import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyTelemetry, type WorkflowRun } from "./model.ts";
import { normalizedModel, refreshAttemptFromDisk } from "./runtime.ts";

test("normalizes only supported pi-subagents reasoning suffixes", () => {
  assert.equal(normalizedModel("openai-codex/gpt-5.6-sol", "off"), "openai-codex/gpt-5.6-sol:off");
  assert.equal(normalizedModel("openai-codex/gpt-5.6-sol:high", "low"), "openai-codex/gpt-5.6-sol:high");
});

test("restart reconciliation fences a stale nonterminal artifact whose durable runner is gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-process-lost-"));
  try {
    const asyncDir = join(root, "run"); await mkdir(asyncDir);
    const attempt: any = { id: "attempt-1", kind: "initial", launchOperationId: "op", rpcRequestId: "rpc", packageRunId: "run", asyncDir, pid: 999999, ownerSessionId: "session", requestedAt: Date.now() - 10_000, state: "running", sessionRoot: root, dependencyAttemptIds: {}, controls: [], runtimeProtocolVersion: 2, artifactVersion: 2, launchLeaseEpoch: 1, expectedExecution: { harness: "codex", agent: "worker", cwd: root, notificationMode: "event-only" } };
    const node: any = { spec: { id: "node", harness: "codex", agent: "worker", task: "work", dependsOn: [] }, status: "running", attempts: [attempt], authoritativeAttemptId: attempt.id };
    const workflow: WorkflowRun = { schemaVersion: 2, id: "wf", name: "wf", projectCwd: root, executionCwd: root, cwd: root, workflowCapability: "secret", ownerSessionId: "session", ownerLeaseId: "lease", ownerLeaseEpoch: 1, stateRevision: 1, status: "active", maxConcurrency: 1, createdAt: 1, updatedAt: 1, runtimeContract: { rpcVersion: 2, artifactVersion: 2 }, nodes: { node }, telemetry: emptyTelemetry(), notifications: [], externalEvidence: [] };
    const { createHash } = await import("node:crypto");
    const capability = createHash("sha256").update("pi-workflow-capability-v1\0").update("wf").update("\0").update("secret").digest("hex");
    await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: "run", state: "running", pid: 999999, cwd: root, lastUpdate: Date.now() - 10_000, sessionIdentity: { orchestratorSessionId: "durable", workflowId: "wf", nodeId: "node", attemptId: "attempt-1", workflowCapabilityHash: capability, ownerLeaseEpoch: 1 }, runtimeLaunch: { operationId: "op", runId: "run", kind: "spawn", provenance: { workflowId: "wf", nodeId: "node", attemptId: "attempt-1", ownerLeaseEpoch: 1 }, effectiveExecution: { harness: "codex", agent: "worker", cwd: root, notificationMode: "event-only" } } }));
    await refreshAttemptFromDisk(workflow, node, attempt);
    assert.equal(node.status, "orphaned");
    assert.equal(attempt.telemetry.terminalReason, "process_lost");
  } finally { await rm(root, { recursive: true, force: true }); }
});
