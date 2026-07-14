import assert from "node:assert/strict";
import test from "node:test";
import { emptyTelemetry, type WorkflowRun } from "./model.ts";
import { inspectProjection, statusProjection } from "./projection.ts";

function largeWorkflow(): WorkflowRun {
  const now = Date.now();
  return {
    schemaVersion: 2, id: "wf-large", name: "🚀".repeat(200), projectCwd: "/project", executionCwd: "/worktree", cwd: "/worktree",
    workflowCapability: "never-visible-secret", ownerSessionId: "session", ownerLeaseId: "lease", ownerLeaseEpoch: 1, stateRevision: 1,
    status: "active", maxConcurrency: 8, createdAt: now, updatedAt: now, runtimeContract: { rpcVersion: 2, artifactVersion: 2 },
    nodes: Object.fromEntries(Array.from({ length: 64 }, (_, index) => {
      const id = `node-${index}`;
      return [id, { spec: { id, label: "界".repeat(300), agent: "worker", task: "PRIVATE REPORT ".repeat(10_000), dependsOn: index ? [`node-${index - 1}`] : [] }, status: index === 0 ? "running" : "queued", attempts: index === 0 ? [{ id: "attempt-1", kind: "initial", launchOperationId: "op", rpcRequestId: "rpc", packageRunId: "run", asyncDir: "/tmp/run", ownerSessionId: "session", requestedAt: now, state: "running", sessionRoot: "/tmp/s", dependencyAttemptIds: {}, controls: [], runtimeProtocolVersion: 2, artifactVersion: 2, launchLeaseEpoch: 1, expectedExecution: { agent: "worker", cwd: "/worktree", notificationMode: "event-only" }, error: "E".repeat(100_000) }] : [], authoritativeAttemptId: index === 0 ? "attempt-1" : undefined }];
    })),
    telemetry: emptyTelemetry(), notifications: [], externalEvidence: [],
  };
}

test("64-node status stays below 32 KiB and excludes task/report/capability bodies", () => {
  const workflow = largeWorkflow();
  const text = statusProjection(workflow);
  assert.ok(Buffer.byteLength(text, "utf8") <= 32 * 1024);
  assert.doesNotMatch(text, /PRIVATE REPORT/);
  assert.doesNotMatch(text, /never-visible-secret/);
});

test("node inspection stays below 8 KiB", () => {
  const text = inspectProjection(largeWorkflow(), "node-0");
  assert.ok(Buffer.byteLength(text, "utf8") <= 8 * 1024);
  assert.doesNotMatch(text, /PRIVATE REPORT/);
});
