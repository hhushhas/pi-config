import assert from "node:assert/strict";
import test from "node:test";
import {
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
    schemaVersion: 1,
    id: "wf-test",
    name: "test",
    cwd: "/tmp/test",
    ownerSessionId: "session",
    status: "active",
    maxConcurrency: 4,
    createdAt: now,
    updatedAt: now,
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
});

test("releases only nodes whose dependencies succeeded", () => {
  const run = workflow();
  assert.deepEqual(readyNodeIds(run), ["context"]);
  run.nodes.context.status = "succeeded";
  assert.deepEqual(readyNodeIds(run), ["build"]);
  run.nodes.build.status = "failed";
  assert.equal(effectiveNodeStatus(run, run.nodes.review), "blocked");
  assert.equal(deriveWorkflowStatus(run), "blocked");

  run.status = "awaiting_resume";
  for (const node of Object.values(run.nodes)) node.status = "succeeded";
  assert.equal(deriveWorkflowStatus(run), "succeeded");
});
