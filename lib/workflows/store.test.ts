import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyTelemetry, type WorkflowRun } from "./model.ts";
import { WorkflowStore } from "./store.ts";

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const project = join(root, "project");
  await mkdir(project);
  const store = new WorkflowStore(join(root, "runs"), project);
  await store.initialize();
  return { root, project, store };
}

function run(project: string): WorkflowRun {
  const now = Date.now();
  return {
    schemaVersion: 2, id: "wf-test", name: "test", projectCwd: project, executionCwd: project, cwd: project,
    workflowCapability: "secret", ownerSessionId: "session", ownerProcessId: process.pid, ownerHeartbeatAt: now,
    ownerLeaseId: "lease", ownerLeaseEpoch: 1, stateRevision: 0, status: "active", maxConcurrency: 1,
    createdAt: now, updatedAt: now, runtimeContract: { rpcVersion: 2, artifactVersion: 2 },
    nodes: { only: { spec: { id: "only", agent: "worker", task: "work", dependsOn: [] }, status: "queued", attempts: [] } },
    telemetry: emptyTelemetry(), notifications: [], externalEvidence: [],
  };
}

test("quiescent v1 migration preserves an exact backup and marks attempts legacy", async () => {
  const h = await fixture("pi-store-migrate-");
  try {
    const directory = h.store.workflowDir("wf-old");
    await mkdir(directory, { recursive: true });
    const old = { schemaVersion: 1, id: "wf-old", name: "old", cwd: h.project, ownerSessionId: "old", status: "blocked", maxConcurrency: 1, createdAt: 1, updatedAt: 2, nodes: { only: { spec: { id: "only", agent: "worker", task: "work", dependsOn: [] }, status: "failed", attempts: [{ id: "attempt-1", rpcRequestId: "r", ownerSessionId: "old", requestedAt: 1, state: "failed", sessionRoot: "/tmp/s", statusSnapshot: { state: "failed" } }] } } };
    const raw = `${JSON.stringify(old, null, 2)}\n`;
    await writeFile(join(directory, "state.json"), raw);
    const migrated = await h.store.load("wf-old");
    assert.equal(migrated?.schemaVersion, 2);
    assert.equal(migrated?.nodes.only.attempts[0]?.kind, "legacy");
    const backups = (await import("node:fs/promises")).readdir(directory).then((items) => items.filter((item) => item.startsWith("state.v1.")));
    const backup = (await backups)[0]!;
    assert.equal(await readFile(join(directory, backup), "utf8"), raw);
    assert.equal(JSON.parse(await readFile(join(directory, "migration-v1-v2.json"), "utf8")).phase, "committed");
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test("live or queued v1 workflows stay observation-only and are not replaced", async () => {
  const h = await fixture("pi-store-live-v1-");
  try {
    const directory = h.store.workflowDir("wf-live");
    await mkdir(directory, { recursive: true });
    const old = { schemaVersion: 1, id: "wf-live", name: "live", cwd: h.project, ownerSessionId: "old", ownerProcessId: process.pid, status: "active", nodes: { only: { spec: { id: "only", agent: "worker", task: "work", dependsOn: [] }, status: "running", attempts: [] } } };
    await writeFile(join(directory, "state.json"), JSON.stringify(old));
    const projected = await h.store.load("wf-live");
    assert.match(projected?.controlsDisabled ?? "", /observation-only/);
    assert.equal(JSON.parse(await readFile(join(directory, "state.json"), "utf8")).schemaVersion, 1);
    await assert.rejects(h.store.save(projected!), /observation-only/);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test("kernel-locked CAS transactions reject stale writers and lose no increments", async () => {
  const h = await fixture("pi-store-lock-");
  try {
    const workflow = run(h.project);
    await h.store.save(workflow);
    const stale = { revision: workflow.stateRevision - 1, leaseId: workflow.ownerLeaseId, leaseEpoch: workflow.ownerLeaseEpoch };
    await assert.rejects(h.store.transaction(workflow.id, stale, () => {}), /fenced/);
    await Promise.all(Array.from({ length: 4 }, async (_, writer) => {
      for (let update = 0; update < 10; update++) {
        let conflicts = 0;
        for (;;) {
          const current = (await h.store.load(workflow.id))!;
          try {
            await h.store.transaction(workflow.id, { revision: current.stateRevision, leaseId: current.ownerLeaseId, leaseEpoch: current.ownerLeaseEpoch }, (draft) => { draft.telemetry.attentionEvents += 1; });
            break;
          } catch (error) {
            if (!String(error).includes("fenced")) throw error;
            conflicts += 1;
            await new Promise((resolve) => setTimeout(resolve, Math.min(50, conflicts * 2) + writer));
          }
        }
      }
    }));
    const final = (await h.store.load(workflow.id))!;
    assert.equal(final.telemetry.attentionEvents, 40);
    assert.equal((await stat(h.store.statePath(workflow.id))).mode & 0o777, 0o600);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test("takeover rejects fresh and live owners, then atomically fences concurrent claimants", async () => {
  const h = await fixture("pi-store-takeover-");
  try {
    const workflow = run(h.project);
    await h.store.save(workflow);
    const observed = () => ({ revision: workflow.stateRevision, leaseId: workflow.ownerLeaseId, leaseEpoch: workflow.ownerLeaseEpoch, ownerProcessId: workflow.ownerProcessId });
    await assert.rejects(h.store.takeover(workflow.id, observed(), { sessionId: "next", processId: process.pid + 1000 }, 15_000), /heartbeat is still fresh/);

    workflow.ownerHeartbeatAt = 1;
    await h.store.save(workflow);
    await assert.rejects(h.store.takeover(workflow.id, observed(), { sessionId: "next", processId: process.pid + 1000 }, 0), /process is still alive/);

    workflow.ownerProcessId = 999_999;
    await h.store.save(workflow);
    const confirmation = observed();
    const claims = await Promise.allSettled([
      h.store.takeover(workflow.id, confirmation, { sessionId: "winner-a", processId: process.pid + 1000 }, 0),
      h.store.takeover(workflow.id, confirmation, { sessionId: "winner-b", processId: process.pid + 2000 }, 0),
    ]);
    assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
    assert.equal(claims.filter((claim) => claim.status === "rejected").length, 1);
    const acquired = (claims.find((claim): claim is PromiseFulfilledResult<WorkflowRun> => claim.status === "fulfilled"))!.value;
    assert.equal(acquired.ownerLeaseEpoch, 2);
    assert.notEqual(acquired.ownerLeaseId, confirmation.leaseId);
    await assert.rejects(h.store.assertAuthority(workflow.id, { revision: confirmation.revision, leaseId: confirmation.leaseId, leaseEpoch: confirmation.leaseEpoch }), /fenced/);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test("interrupted migration recovers from an exact backup and disables controls on verification failure", async () => {
  const h = await fixture("pi-store-migration-recovery-");
  try {
    const directory = h.store.workflowDir("wf-interrupted");
    await mkdir(directory, { recursive: true });
    const old = { schemaVersion: 1, id: "wf-interrupted", name: "old", cwd: h.project, ownerSessionId: "old", status: "blocked", nodes: { only: { spec: { id: "only", agent: "worker", task: "work", dependsOn: [] }, status: "failed", attempts: [] } } };
    const raw = `${JSON.stringify(old, null, 2)}\n`;
    const sourceHash = createHash("sha256").update(raw).digest("hex");
    const backupName = `state.v1.${sourceHash}.json`;
    await writeFile(join(directory, "state.json"), raw);
    await writeFile(join(directory, backupName), raw);
    await writeFile(join(directory, "migration-v1-v2.json"), JSON.stringify({ phase: "prepared", sourceHash, backup: backupName, targetSchema: 2 }));
    const recovered = await h.store.load("wf-interrupted");
    assert.equal(recovered?.schemaVersion, 2);
    assert.equal(JSON.parse(await readFile(join(directory, "migration-v1-v2.json"), "utf8")).phase, "committed");
    assert.equal(await readFile(join(directory, backupName), "utf8"), raw);

    const badDirectory = h.store.workflowDir("wf-bad-journal");
    await mkdir(badDirectory, { recursive: true });
    const v2 = run(h.project);
    v2.id = "wf-bad-journal";
    await writeFile(join(badDirectory, "state.json"), JSON.stringify(v2));
    await writeFile(join(badDirectory, "broken-backup.json"), "corrupt");
    await writeFile(join(badDirectory, "migration-v1-v2.json"), JSON.stringify({ phase: "prepared", sourceHash: "0".repeat(64), backup: "broken-backup.json", targetSchema: 2 }));
    const disabled = await h.store.load("wf-bad-journal");
    assert.match(disabled?.controlsDisabled ?? "", /Migration verification failed/);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});
