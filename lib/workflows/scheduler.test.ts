import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowScheduler, type WorkflowRpc } from "./scheduler.ts";
import { WorkflowStore } from "./store.ts";
import type { ControlReply, OperationReply, SpawnReply, WorkflowProvenance } from "./rpc-client.ts";

class FakeRpc implements WorkflowRpc {
  readonly launches: Array<{ params: Record<string, unknown>; runId: string; asyncDir: string }> = [];
  readonly operations = new Map<string, OperationReply>();
  loseNextReply = false;
  confirmControls = true;
  private nextId = 0;

  constructor(private readonly root: string) {}
  createRequestId(): string { return `request-${++this.nextId}`; }

  async spawn(params: Record<string, unknown>): Promise<SpawnReply> { return this.launch(params, "spawn"); }
  async resume(params: Record<string, unknown>): Promise<SpawnReply> { return this.launch(params, "resume"); }
  async lookup(params: { operationId: string }): Promise<OperationReply> {
    const operation = this.operations.get(params.operationId);
    if (!operation) throw new Error("operation not found");
    return operation;
  }
  async status(): Promise<unknown> { return {}; }

  async interrupt(runId: string, authority: { controlRequestId: string }): Promise<ControlReply> {
    return this.control(runId, "paused", authority.controlRequestId);
  }
  async stop(runId: string, authority: { controlRequestId: string }): Promise<ControlReply> {
    return this.control(runId, "stopped", authority.controlRequestId);
  }
  async steer(runId: string, _message: string, authority: { controlRequestId: string }): Promise<ControlReply> {
    const launch = this.launches.find((candidate) => candidate.runId === runId)!;
    return { controlRequestId: authority.controlRequestId, accepted: true, runId, asyncDir: launch.asyncDir, previousState: "running", requestedState: "running", message: "delivered" };
  }

  async finish(runId: string, reason: "completed" | "failed" | "paused" | "stopped", controlRequestId?: string): Promise<void> {
    const launch = this.launches.find((candidate) => candidate.runId === runId)!;
    const params = launch.params;
    const provenance = params.provenance as WorkflowProvenance;
    await writeFile(join(launch.asyncDir, "status.json"), JSON.stringify({
      runId,
      state: reason === "completed" ? "complete" : reason,
      cwd: params.cwd,
      startedAt: Date.now() - 10,
      endedAt: Date.now(),
      terminal: { reason, at: Date.now(), ...(controlRequestId ? { controlRequestId } : {}) },
      sessionIdentity: { workflowId: provenance.workflowId, nodeId: provenance.nodeId, attemptId: provenance.attemptId, ownerLeaseEpoch: provenance.ownerLeaseEpoch, orchestratorSessionId: "session-1", workflowCapabilityHash: this.capabilityHash(params) },
      runtimeLaunch: this.runtimeLaunch(params, runId),
      sessionFile: join(launch.asyncDir, "child.jsonl"),
    }));
  }

  private async launch(params: Record<string, unknown>, kind: "spawn" | "resume"): Promise<SpawnReply> {
    const runId = `run-${this.launches.length + 1}`;
    const asyncDir = join(this.root, runId);
    await mkdir(asyncDir, { recursive: true });
    this.launches.push({ params, runId, asyncDir });
    const operation: OperationReply = { operationId: String(params.operationId), kind, state: "launched", runId, asyncDir, pid: 999999 };
    this.operations.set(operation.operationId, operation);
    await this.writeRunning(this.launches.at(-1)!);
    if (this.loseNextReply) {
      this.loseNextReply = false;
      const error = Object.assign(new Error("lost reply"), { code: "timeout" });
      throw error;
    }
    return { runId, asyncDir, operation };
  }

  private async writeRunning(launch: { params: Record<string, unknown>; runId: string; asyncDir: string }): Promise<void> {
    const provenance = launch.params.provenance as WorkflowProvenance;
    await writeFile(join(launch.asyncDir, "status.json"), JSON.stringify({
      runId: launch.runId,
      state: "running",
      cwd: launch.params.cwd,
      startedAt: Date.now(),
      pid: 999999,
      sessionIdentity: { workflowId: provenance.workflowId, nodeId: provenance.nodeId, attemptId: provenance.attemptId, ownerLeaseEpoch: provenance.ownerLeaseEpoch, orchestratorSessionId: "session-1", workflowCapabilityHash: this.capabilityHash(launch.params) },
      runtimeLaunch: this.runtimeLaunch(launch.params, launch.runId),
    }));
  }

  private capabilityHash(params: Record<string, unknown>): string {
    const provenance = params.provenance as WorkflowProvenance;
    return createHash("sha256").update("pi-workflow-capability-v1\0").update(provenance.workflowId).update("\0").update(String(params.workflowCapability)).digest("hex");
  }

  private runtimeLaunch(params: Record<string, unknown>, runId: string) {
    return {
      operationId: params.operationId,
      runId,
      kind: params.sourceRunId ? "resume" : "spawn",
      provenance: params.provenance,
      effectiveExecution: {
        ...(params.harness ? { harness: params.harness } : {}),
        agent: params.agent,
        cwd: params.cwd,
        ...(params.model ? { model: params.model } : {}),
        ...(params.thinking ? { thinking: params.thinking } : {}),
        ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
        notificationMode: params.notificationMode,
      },
      ...(params.sourceRunId ? { sourceRunId: params.sourceRunId } : {}),
      ...(params.sourceSessionFile ? { sourceSessionFile: params.sourceSessionFile } : {}),
      ...(params.sourceAttemptId ? { sourceAttemptId: params.sourceAttemptId } : {}),
      ...(params.sourceProvenance ? { sourceProvenance: params.sourceProvenance } : {}),
    };
  }

  private async control(runId: string, reason: "paused" | "stopped", controlRequestId: string): Promise<ControlReply> {
    const launch = this.launches.find((candidate) => candidate.runId === runId)!;
    if (this.confirmControls) await this.finish(runId, reason, controlRequestId);
    return { controlRequestId, accepted: true, runId, asyncDir: launch.asyncDir, previousState: "running", requestedState: reason === "paused" ? "pausing" : "stopping", message: "accepted" };
  }
}

async function harness(prefix: string, concurrency = 2, notice: (message: string, level: "info" | "warning" | "error", triggerTurn?: boolean) => void | Promise<void> = () => {}) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const project = join(root, "project");
  await mkdir(project);
  const rpc = new FakeRpc(join(root, "subagents"));
  const store = new WorkflowStore(join(root, "store"), project);
  const scheduler = new WorkflowScheduler(rpc, store, "session-1", undefined, "openai-codex/gpt-5.6-sol", notice, concurrency);
  await scheduler.initialize();
  return { root, project, rpc, store, scheduler };
}

test("persists and dispatches an explicit external harness without Pi model rewriting", async () => {
  const h = await harness("pi-dag-harness-");
  try {
    const workflow = await h.scheduler.create({ name: "cross harness", nodes: [
      { id: "build", harness: "codex", agent: "worker", task: "build", model: "gpt-5.6-codex", thinking: "high" },
      { id: "review", harness: "claude", agent: "reviewer", task: "review", dependsOn: ["build"] },
    ] });
    const launch = h.rpc.launches[0]!;
    assert.equal(launch.params.harness, "codex");
    assert.equal(launch.params.model, "gpt-5.6-codex");
    assert.equal(launch.params.thinking, "high");
    const attempt = workflow.nodes.build.attempts[0]!;
    assert.equal(attempt.kind === "legacy" ? undefined : attempt.expectedExecution.harness, "codex");
    assert.equal(attempt.kind === "legacy" ? undefined : attempt.expectedExecution.model, "gpt-5.6-codex");
    await h.rpc.finish("run-1", "completed");
    await h.scheduler.tick();
    assert.equal(workflow.nodes.build.status, "succeeded");
    assert.equal(workflow.nodes.review.status, "running");
    assert.equal(h.rpc.launches[1]?.params.harness, "claude");
    assert.equal(workflow.nodes.review.attempts[0]?.dependencyAttemptIds.build, "attempt-1");
  } finally { h.scheduler.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("launches dependents only after a provenance-backed prerequisite succeeds", async () => {
  const h = await harness("pi-dag-v2-");
  try {
    const workflow = await h.scheduler.create({ name: "dependency proof", nodes: [
      { id: "first", agent: "worker", task: "first" },
      { id: "second", agent: "reviewer", task: "second", dependsOn: ["first"] },
    ] });
    assert.deepEqual(h.rpc.launches.map((launch) => launch.params.task), ["first"]);
    assert.equal(h.rpc.launches[0]?.params.harness, undefined, "legacy Pi RPC wire contract must not receive the additive harness field");
    await h.rpc.finish("run-1", "completed");
    await h.scheduler.tick();
    assert.deepEqual(h.rpc.launches.map((launch) => launch.params.task), ["first", "second"]);
    assert.equal(h.scheduler.get(workflow.id).nodes.second.attempts[0]?.dependencyAttemptIds.first, "attempt-1");
  } finally { h.scheduler.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("lost spawn reply is reconciled by operation lookup without a duplicate child", async () => {
  const h = await harness("pi-dag-lookup-");
  try {
    h.rpc.loseNextReply = true;
    const workflow = await h.scheduler.create({ name: "lookup proof", nodes: [{ id: "only", agent: "worker", task: "only" }] });
    assert.equal(h.rpc.launches.length, 1);
    assert.equal(h.scheduler.get(workflow.id).nodes.only.status, "running");
    assert.equal(h.scheduler.get(workflow.id).nodes.only.attempts.length, 1);
  } finally { h.scheduler.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("stop remains pending until the exact control id is causally confirmed", async () => {
  const h = await harness("pi-dag-control-");
  try {
    h.rpc.confirmControls = false;
    const workflow = await h.scheduler.create({ name: "control proof", nodes: [{ id: "only", agent: "worker", task: "only" }] });
    await h.scheduler.stopNode(workflow.id, "only");
    assert.equal(h.scheduler.get(workflow.id).nodes.only.status, "stopping");
    await assert.rejects(h.scheduler.stopNode(workflow.id, "only"), /stop control in progress/);
    assert.equal(h.scheduler.get(workflow.id).nodes.only.status, "stopping");
    const attempt = h.scheduler.get(workflow.id).nodes.only.attempts[0]!;
    await h.rpc.finish("run-1", "completed");
    await h.scheduler.tick();
    assert.equal(attempt.state, "succeeded");
    assert.equal(attempt.controls[0]?.error, "completed_before_control");
    assert.equal(h.rpc.launches.length, 1);
  } finally { h.scheduler.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("a second scheduler observes but cannot control a live-owned workflow", async () => {
  const h = await harness("pi-dag-owner-", 1);
  let second: WorkflowScheduler | undefined;
  try {
    const workflow = await h.scheduler.create({ name: "foreign proof", nodes: [{ id: "only", agent: "worker", task: "only" }] });
    second = new WorkflowScheduler(new FakeRpc(join(h.root, "other")), h.store, "session-2", undefined, undefined, () => {}, 1, { processId: process.pid + 1000, isProcessAlive: () => true });
    await second.initialize();
    await assert.rejects(second.stopNode(workflow.id, "only"), /owned by another Pi session/);
    assert.equal(second.get(workflow.id).nodes.only.status, "running");
  } finally { second?.dispose(); h.scheduler.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("pause and resume append lineage and preserve the child session", async () => {
  const h = await harness("pi-dag-resume-", 1);
  try {
    const workflow = await h.scheduler.create({ name: "resume proof", nodes: [{ id: "only", agent: "worker", task: "only" }] });
    await h.scheduler.pause(workflow.id);
    await h.scheduler.tick();
    assert.equal(h.scheduler.get(workflow.id).nodes.only.status, "paused");
    assert.equal(h.scheduler.get(workflow.id).status, "paused");
    await h.scheduler.resume(workflow.id, "only");
    const node = h.scheduler.get(workflow.id).nodes.only;
    assert.equal(node.attempts.length, 2);
    assert.equal(node.attempts[1]?.kind, "resume");
    assert.equal((node.attempts[1] as { previousAttemptId?: string }).previousAttemptId, "attempt-1");
    assert.equal(h.rpc.launches[1]?.params.sourceRunId, "run-1");
  } finally { h.scheduler.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("lost resume reply is reconciled by operation lookup without a duplicate replacement", async () => {
  const h = await harness("pi-dag-resume-lookup-", 1);
  try {
    const workflow = await h.scheduler.create({ name: "resume lookup", nodes: [{ id: "only", agent: "worker", task: "only" }] });
    await h.scheduler.pause(workflow.id);
    await h.scheduler.tick();
    h.rpc.loseNextReply = true;
    await h.scheduler.resume(workflow.id, "only");
    const node = h.scheduler.get(workflow.id).nodes.only;
    assert.equal(h.rpc.launches.length, 2);
    assert.equal(node.attempts.length, 2);
    assert.equal(node.attempts[1]?.packageRunId, "run-2");
    assert.equal(node.status, "running");
  } finally { h.scheduler.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("a dependent binds to the resumed prerequisite attempt", async () => {
  const h = await harness("pi-dag-resume-dependency-", 1);
  try {
    const workflow = await h.scheduler.create({ name: "resume dependency", nodes: [
      { id: "first", agent: "worker", task: "first" },
      { id: "second", agent: "worker", task: "second", dependsOn: ["first"] },
    ] });
    await h.scheduler.pause(workflow.id);
    await h.scheduler.tick();
    await h.scheduler.resume(workflow.id, "first");
    await h.rpc.finish("run-2", "completed");
    await h.scheduler.tick();
    const second = h.scheduler.get(workflow.id).nodes.second;
    assert.equal(h.rpc.launches.length, 3);
    assert.equal(second.attempts[0]?.dependencyAttemptIds.first, "attempt-2");
  } finally { h.scheduler.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("retrying a succeeded prerequisite invalidates and rebinds every descendant", async () => {
  const h = await harness("pi-dag-retry-lineage-", 3);
  try {
    const workflow = await h.scheduler.create({ name: "retry lineage", nodes: [
      { id: "first", agent: "worker", task: "first" },
      { id: "second", agent: "worker", task: "second", dependsOn: ["first"] },
      { id: "third", agent: "worker", task: "third", dependsOn: ["second"] },
    ] });
    await h.rpc.finish("run-1", "completed");
    await h.scheduler.tick();
    await h.rpc.finish("run-2", "completed");
    await h.scheduler.tick();
    await h.rpc.finish("run-3", "completed");
    await h.scheduler.tick();
    await h.scheduler.retryNode(workflow.id, "first");
    const invalidated = h.scheduler.get(workflow.id).nodes.second;
    const invalidatedGrandchild = h.scheduler.get(workflow.id).nodes.third;
    assert.equal(invalidated.status, "queued");
    assert.equal(invalidated.authoritativeAttemptId, undefined);
    assert.equal(invalidated.invalidatedByAttemptId, "attempt-1");
    assert.equal(invalidatedGrandchild.authoritativeAttemptId, undefined);
    await h.rpc.finish("run-4", "completed");
    await h.scheduler.tick();
    assert.equal(h.rpc.launches.length, 5);
    assert.equal(h.rpc.launches[4]?.params.task, "second");
    assert.equal(invalidated.attempts[1]?.dependencyAttemptIds.first, "attempt-2");
    assert.equal(invalidatedGrandchild.attempts.length, 1);
  } finally { h.scheduler.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("retry rejects running and queued targets without launching replacements", async () => {
  const h = await harness("pi-dag-retry-state-", 2);
  try {
    const workflow = await h.scheduler.create({ name: "retry state", nodes: [
      { id: "first", agent: "worker", task: "first" },
      { id: "second", agent: "worker", task: "second", dependsOn: ["first"] },
    ] });
    await assert.rejects(h.scheduler.retryNode(workflow.id, "first"), /terminal state.*running/);
    await assert.rejects(h.scheduler.retryNode(workflow.id, "second"), /terminal state.*queued/);
    assert.equal(h.rpc.launches.length, 1);
  } finally { h.scheduler.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("an external revival is read-only evidence and cannot release a dependency", async () => {
  const h = await harness("pi-dag-external-", 1);
  try {
    const workflow = await h.scheduler.create({ name: "external evidence", nodes: [
      { id: "first", agent: "worker", task: "first" },
      { id: "second", agent: "worker", task: "second", dependsOn: ["first"] },
    ] });
    await h.rpc.finish("run-1", "paused", "pause-external-proof");
    await h.scheduler.tick();
    const source = h.scheduler.get(workflow.id).nodes.first.attempts[0]!;
    const externalDir = join(h.root, "subagents", "external-run");
    await mkdir(externalDir, { recursive: true });
    await writeFile(join(externalDir, "status.json"), JSON.stringify({ runId: "external-run", state: "complete", sessionFile: source.childSessionFile, startedAt: Date.now() - 10, endedAt: Date.now() }));
    await h.scheduler.tick();
    const current = h.scheduler.get(workflow.id);
    assert.equal(current.externalEvidence.length, 1);
    assert.equal(current.externalEvidence[0]?.runId, "external-run");
    assert.equal(current.nodes.first.status, "paused");
    assert.equal(current.nodes.second.status, "queued");
    assert.equal(h.rpc.launches.length, 1);
  } finally { h.scheduler.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("workflow and node cwd validation rejects traversal and symlink escapes", async () => {
  const h = await harness("pi-dag-cwd-");
  try {
    const outside = join(h.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(h.project, "escape"));
    await assert.rejects(h.scheduler.create({ name: "traversal", nodes: [{ id: "only", agent: "worker", task: "x", cwd: "../outside" }] }), /relative path contained by the workflow execution directory/);
    await assert.rejects(h.scheduler.create({ name: "symlink", nodes: [{ id: "only", agent: "worker", task: "x", cwd: "escape" }] }), /escapes workflow execution directory/);
    assert.equal(h.rpc.launches.length, 0);
  } finally { h.scheduler.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("notification delivery failure leaves lifecycle unchanged and retries exactly once", async () => {
  let fail = true;
  const deliveries: Array<{ message: string; triggerTurn?: boolean }> = [];
  const h = await harness("pi-dag-notification-", 1, (message, _level, triggerTurn) => {
    deliveries.push({ message, triggerTurn });
    if (fail) throw new Error("notice unavailable");
  });
  try {
    const workflow = await h.scheduler.create({ name: "notification retry", nodes: [{ id: "only", agent: "worker", task: "only" }] });
    await h.rpc.finish("run-1", "completed");
    await h.scheduler.tick();
    const current = h.scheduler.get(workflow.id);
    assert.equal(current.status, "succeeded");
    assert.equal(current.notifications.length, 1);
    assert.equal(current.notifications[0]?.deliveredAt, undefined);
    assert.equal(current.telemetry.parentWakeCount, 0);
    current.notifications[0]!.attemptedAt = 0;
    fail = false;
    await h.scheduler.tick();
    assert.equal(current.status, "succeeded");
    assert.equal(current.notifications.length, 1);
    assert.equal(current.telemetry.notificationCount, 1);
    assert.equal(current.telemetry.parentWakeCount, 1);
    assert.equal(deliveries.length, 2);
    assert.ok(Buffer.byteLength(deliveries[1]!.message, "utf8") < 1024);
  } finally { h.scheduler.dispose(); await rm(h.root, { recursive: true, force: true }); }
});
