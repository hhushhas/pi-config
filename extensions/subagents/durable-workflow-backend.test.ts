import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SubagentRpcClient } from "../../lib/workflows/rpc-client.ts";
import { DurableWorkflowBackendBridge } from "./src/durable-workflow-backend.ts";

class Bus {
  private handlers = new Map<string, Set<(value: unknown) => void>>();
  on(name: string, handler: (value: unknown) => void) { const set = this.handlers.get(name) ?? new Set(); set.add(handler); this.handlers.set(name, set); return () => set.delete(handler); }
  emit(name: string, value: unknown) { for (const handler of this.handlers.get(name) ?? []) handler(value); }
  listenerCount(name: string) { return this.handlers.get(name)?.size ?? 0; }
}

function request(bus: Bus, requestId: string, method: string, params: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const unsubscribe = bus.on(`subagents:workflow-backend:v1:reply:${requestId}`, (value) => {
      unsubscribe();
      const reply = value as { success: boolean; data?: unknown; error?: { message: string } };
      if (reply.success) resolve(reply.data); else reject(new Error(reply.error?.message));
    });
    bus.emit("subagents:workflow-backend:v1:request", { version: 2, requestId, method, params });
  });
}

const sourceProvenance = { workflowId: "wf", nodeId: "node", attemptId: "attempt-1", ownerLeaseEpoch: 1 };
const authority = { harness: "codex" as const, workflowCapability: "secret", provenance: sourceProvenance };

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const runner = join(root, "fake-runner.mjs");
  await writeFile(runner, `
import fs from "node:fs"; import path from "node:path";
const c=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const status=(x)=>({runId:x.runId,asyncDir:x.asyncDir,state:"running",pid:process.pid,cwd:x.cwd,lastUpdate:Date.now(),sessionIdentity:{workflowId:x.runtimeLaunch.provenance.workflowId,nodeId:x.runtimeLaunch.provenance.nodeId,attemptId:x.runtimeLaunch.provenance.attemptId,ownerLeaseEpoch:x.runtimeLaunch.provenance.ownerLeaseEpoch,workflowCapabilityHash:x.capabilityHash},runtimeLaunch:x.runtimeLaunch});
fs.appendFileSync(path.dirname(c.asyncDir)+"/spawn-log",process.pid+"\\n"); fs.writeFileSync(c.asyncDir+"/status.json",JSON.stringify(status(c)));
setInterval(()=>{const d=c.asyncDir+"/controls";if(!fs.existsSync(d))return;for(const f of fs.readdirSync(d)){const q=JSON.parse(fs.readFileSync(d+"/"+f,"utf8"));if(q.action==="resume"&&q.config){fs.mkdirSync(q.config.asyncDir,{recursive:true});fs.writeFileSync(q.config.asyncDir+"/status.json",JSON.stringify(status(q.config)));}}},20);
setTimeout(()=>{},30000);`);
  const bus = new Bus();
  const bridge = new DurableWorkflowBackendBridge(bus as never, join(root, "state"), runner);
  return { root, runner, bus, bridge };
}

const spawnParams = (root: string) => ({ harness: "codex", agent: "worker", task: "do work", cwd: root, operationId: "op", workflowCapability: "secret", provenance: sourceProvenance, notificationMode: "event-only" });

async function cleanup(root: string, pid: number | undefined) {
  if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test("bridge binding is idempotent and lifecycle disposal removes its listener without touching runners", async () => {
  const h = await fixture("workflow-backend-lifecycle-");
  let pid: number | undefined;
  try {
    h.bridge.start(); h.bridge.start();
    assert.equal(h.bus.listenerCount("subagents:workflow-backend:v1:request"), 1);
    const launched = await request(h.bus, "lifecycle-spawn", "spawn", spawnParams(h.root)); pid = launched.operation.pid;
    h.bridge.dispose();
    assert.equal(h.bus.listenerCount("subagents:workflow-backend:v1:request"), 0);
    assert.doesNotThrow(() => process.kill(pid!, 0), "disposing the session bridge must leave the detached runner alive");
    h.bridge.start();
    assert.equal(h.bus.listenerCount("subagents:workflow-backend:v1:request"), 1);
  } finally { h.bridge.dispose(); await cleanup(h.root, pid); }
});

test("concurrent launch and control replay are durable, idempotent, and status routes end to end", async () => {
  const h = await fixture("workflow-backend-concurrent-");
  const secondBus = new Bus();
  const secondBridge = new DurableWorkflowBackendBridge(secondBus as never, join(h.root, "state"), h.runner);
  h.bridge.start(); secondBridge.start();
  let pid: number | undefined;
  try {
    const buses = [h.bus, secondBus];
    const launches = await Promise.all(Array.from({ length: 8 }, (_, index) => request(buses[index % buses.length]!, `spawn-${index}`, "spawn", spawnParams(h.root))));
    const first = launches[0]; pid = first.operation.pid;
    assert.deepEqual(new Set(launches.map((item) => item.runId)).size, 1);
    assert.equal((await readFile(join(h.root, "state", "runs", "spawn-log"), "utf8")).trim().split("\n").length, 1);
    await assert.rejects(request(h.bus, "different-launch", "spawn", { ...spawnParams(h.root), task: "different" }), /different parameters/);

    const client = new SubagentRpcClient(h.bus as never);
    const routed = await client.status(first.runId, authority);
    assert.equal(routed.runId, first.runId);
    client.dispose();

    const controlParams = { ...authority, runId: first.runId, controlRequestId: "control-1" };
    const controls = await Promise.all(Array.from({ length: 8 }, (_, index) => request(buses[index % buses.length]!, `control-${index}`, "stop", controlParams)));
    assert.ok(controls.every((control) => control.accepted));
    const journal = await readdir(join(first.asyncDir, "controls"));
    assert.equal(journal.length, 1);
    assert.equal(JSON.parse(await readFile(join(first.asyncDir, "controls", journal[0]!), "utf8")).controlRequestId, "control-1");
    await assert.rejects(request(h.bus, "different-control", "steer", { ...controlParams, message: "changed" }), /different parameters/);
    await assert.rejects(request(h.bus, "wrong-authority", "stop", { ...controlParams, workflowCapability: "wrong" }), /authority/);
  } finally { h.bridge.dispose(); secondBridge.dispose(); await cleanup(h.root, pid); }
});

test("a paused source accepts one concurrent resume claim and rejects competing operations", async () => {
  const h = await fixture("workflow-backend-resume-");
  h.bridge.start();
  let pid: number | undefined;
  try {
    const source = await request(h.bus, "source", "spawn", spawnParams(h.root)); pid = source.operation.pid;
    const sourceStatusFile = join(source.asyncDir, "status.json");
    const sourceStatus = JSON.parse(await readFile(sourceStatusFile, "utf8"));
    await writeFile(sourceStatusFile, JSON.stringify({ ...sourceStatus, state: "paused", endedAt: Date.now(), terminal: { reason: "paused", at: Date.now(), controlRequestId: "pause" } }));
    const resume = (attemptId: string, operationId: string) => ({ harness: "codex", agent: "worker", task: "continue", cwd: h.root, operationId, workflowCapability: "secret", provenance: { ...sourceProvenance, attemptId }, sourceRunId: source.runId, sourceSessionFile: "/session", sourceAttemptId: "attempt-1", sourceProvenance, notificationMode: "event-only" });
    const claims = await Promise.allSettled([
      request(h.bus, "resume-a", "resume", resume("attempt-2", "resume-a")),
      request(h.bus, "resume-b", "resume", resume("attempt-3", "resume-b")),
    ]);
    assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
    const winnerIndex = claims.findIndex((claim) => claim.status === "fulfilled");
    const winner = claims[winnerIndex] as PromiseFulfilledResult<any>;
    const replayParams = winnerIndex === 0 ? resume("attempt-2", "resume-a") : resume("attempt-3", "resume-b");
    const replay = await request(h.bus, "resume-replay", "resume", replayParams);
    assert.equal(replay.runId, winner.value.runId);
    const rejection = claims.find((claim): claim is PromiseRejectedResult => claim.status === "rejected");
    assert.match(String(rejection?.reason), /already claimed/);
    assert.equal((await readdir(join(source.asyncDir, "controls"))).length, 1);
  } finally { h.bridge.dispose(); await cleanup(h.root, pid); }
});
