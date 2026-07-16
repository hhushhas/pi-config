import assert from "node:assert/strict";
import test from "node:test";
import {
  currentAttempt,
  deriveWorkflowStatus,
  effectiveNodeStatus,
  readyNodeIds,
  topologicalNodeIds,
  validateDefinition,
  type WorkflowRun,
} from "./model.ts";

function workflow(): WorkflowRun {
  const now = Date.now();
  return {
    schemaVersion: 2,
    id: "wf-test",
    name: "test",
    cwd: "/tmp/test",
    projectCwd: "/tmp/test",
    executionCwd: "/tmp/test",
    workflowCapability: "secret",
    ownerSessionId: "session",
    ownerLeaseId: "lease",
    ownerLeaseEpoch: 1,
    stateRevision: 1,
    status: "active",
    maxConcurrency: 4,
    createdAt: now,
    updatedAt: now,
    runtimeContract: { rpcVersion: 2, artifactVersion: 2 },
    telemetry: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, attempts: 0, turns: 0, tools: 0, wallTimeMs: 0, queueTimeMs: 0, controlFailures: 0, attentionEvents: 0, notificationCount: 0, notificationBytes: 0, parentWakeCount: 0, lastStatusBytes: 0 },
    notifications: [],
    externalEvidence: [],
    nodes: {
      context: { spec: { id: "context", agent: "scout", task: "map", dependsOn: [] }, status: "queued", attempts: [] },
      build: { spec: { id: "build", agent: "worker", task: "build", dependsOn: ["context"] }, status: "queued", attempts: [] },
      review: { spec: { id: "review", agent: "reviewer", task: "review", dependsOn: ["build"] }, status: "queued", attempts: [] },
    },
  };
}

test("validates and orders a dependency graph", () => {
  const nodes = validateDefinition({
    name: "ship",
    nodes: [
      { id: "review", agent: "reviewer", task: "review", dependsOn: ["build"] },
      { id: "build", agent: "worker", task: "build" },
    ],
  });
  assert.deepEqual(topologicalNodeIds(Object.fromEntries(nodes.map((node) => [node.id, { spec: node }]))), ["build", "review"]);
});

test("rejects cycles and unknown dependencies", () => {
  assert.throws(() => validateDefinition({
    name: "cycle",
    nodes: [
      { id: "a", agent: "worker", task: "a", dependsOn: ["b"] },
      { id: "b", agent: "worker", task: "b", dependsOn: ["a"] },
    ],
  }), /cycle/);
  assert.throws(() => validateDefinition({
    name: "unknown",
    nodes: [{ id: "a", agent: "worker", task: "a", dependsOn: ["missing"] }],
  }), /unknown node/);
  assert.throws(() => validateDefinition({
    name: "thinking",
    nodes: [{ id: "a", agent: "worker", task: "a", thinking: "light" as never }],
  }), /unsupported reasoning effort/);
  assert.throws(() => validateDefinition({
    name: "harness",
    nodes: [{ id: "a", agent: "worker", task: "a", harness: "shell" as never }],
  }), /unsupported harness/);
});

test("releases only nodes whose dependencies succeeded", () => {
  const run = workflow();
  assert.deepEqual(readyNodeIds(run), ["context"]);
  run.nodes.context.status = "succeeded";
  run.nodes.context.attempts.push({ id: "attempt-1", kind: "legacy", rpcRequestId: "legacy", ownerSessionId: "session", requestedAt: Date.now(), state: "succeeded", sessionRoot: "/tmp", dependencyAttemptIds: {}, controls: [], completionSeen: true, controlAvailable: false, lookupAvailable: false });
  run.nodes.context.authoritativeAttemptId = "attempt-1";
  assert.deepEqual(readyNodeIds(run), ["build"]);
  run.nodes.build.status = "failed";
  assert.equal(effectiveNodeStatus(run, run.nodes.review), "blocked");
  assert.equal(deriveWorkflowStatus(run), "blocked");

  run.status = "awaiting_resume";
  for (const node of Object.values(run.nodes)) node.status = "succeeded";
  assert.equal(deriveWorkflowStatus(run), "succeeded");

  run.nodes.build.invalidatedAt = Date.now();
  run.nodes.build.authoritativeAttemptId = undefined;
  assert.equal(currentAttempt(run.nodes.build), undefined);

  run.status = "pausing";
  for (const node of Object.values(run.nodes)) node.status = "paused";
  assert.equal(deriveWorkflowStatus(run), "paused");
  run.status = "stopping";
  for (const node of Object.values(run.nodes)) node.status = "stopped";
  assert.equal(deriveWorkflowStatus(run), "stopped");
});
