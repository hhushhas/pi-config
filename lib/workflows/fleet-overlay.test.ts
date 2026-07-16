import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { FleetOverlay, type FleetActions } from "./fleet-overlay.ts";
import type { WorkflowRun } from "./model.ts";

function workflow(): WorkflowRun {
  const now = Date.now();
  return {
    schemaVersion: 2,
    id: "wf-fleet",
    name: "A long dependency-aware fleet workflow",
    cwd: "/project",
    projectCwd: "/project",
    executionCwd: "/project",
    workflowCapability: "secret",
    ownerSessionId: "session",
    ownerProcessId: process.pid,
    ownerLeaseId: "lease",
    ownerLeaseEpoch: 1,
    stateRevision: 1,
    status: "active",
    maxConcurrency: 4,
    createdAt: now,
    updatedAt: now,
    runtimeContract: { rpcVersion: 2, artifactVersion: 2 },
    telemetry: { inputTokens: 1200, outputTokens: 400, totalTokens: 1600, costUsd: 0.0123, attempts: 1, turns: 3, tools: 8, wallTimeMs: 0, queueTimeMs: 0, controlFailures: 0, attentionEvents: 0, notificationCount: 0, notificationBytes: 0, parentWakeCount: 0, lastStatusBytes: 0 },
    notifications: [],
    externalEvidence: [],
    nodes: {
      context: {
        spec: { id: "context", label: "Map an extremely long authentication context", agent: "scout", task: "map", dependsOn: [] },
        status: "succeeded",
        attempts: [],
      },
      build: {
        spec: { id: "build", agent: "worker", task: "build", dependsOn: ["context"], model: "openai-codex/gpt-5.6-sol", thinking: "high" },
        status: "running",
        attempts: [{
          id: "attempt-1",
          kind: "initial",
          launchOperationId: "operation",
          rpcRequestId: "request",
          packageRunId: "run",
          asyncDir: "/tmp/run",
          ownerSessionId: "session",
          requestedAt: now,
          startedAt: now,
          state: "running",
          sessionRoot: "/tmp/sessions",
          dependencyAttemptIds: { context: "attempt-1" },
          controls: [],
          runtimeProtocolVersion: 2,
          artifactVersion: 2,
          launchLeaseEpoch: 1,
          expectedExecution: { agent: "worker", cwd: "/project", notificationMode: "event-only" },
          telemetry: {
            state: "running",
            totalTokens: { input: 1200, output: 400, total: 1600 },
            totalCost: { inputTokens: 1200, outputTokens: 400, costUsd: 0.0123 },
            turnCount: 3,
            toolCount: 8,
          },
        }],
        authoritativeAttemptId: "attempt-1",
      },
    },
  };
}

function harness(controllable = true) {
  const listeners = new Set<() => void>();
  let currentWorkflow = workflow();
  let renders = 0;
  let retries = 0;
  let pauses = 0;
  let stops = 0;
  let closes = 0;
  const notices: string[] = [];
  const tui = {
    requestRender: () => { renders += 1; },
    terminal: { rows: 30 },
  } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const keybindings = {
    matches: (data: string, binding: string) => ({
      "tui.select.cancel": "escape",
      "tui.select.up": "up",
      "tui.select.down": "down",
      "tui.select.confirm": "enter",
    }[binding] === data),
  } as KeybindingsManager;
  const actions: FleetActions = {
    snapshot: () => [currentWorkflow],
    isControllable: () => controllable,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resume: async () => {},
    pause: async () => { pauses += 1; },
    stopNode: async () => { stops += 1; },
    retryNode: async () => { retries += 1; },
    takeover: async () => {},
    confirm: async () => true,
    notify: (message) => { notices.push(message); },
  };
  const overlay = new FleetOverlay(tui, theme, keybindings, () => { closes += 1; }, actions);
  return {
    overlay,
    listeners,
    notices,
    replaceWorkflow(next: WorkflowRun) { currentWorkflow = next; for (const listener of listeners) listener(); },
    get renders() { return renders; },
    get retries() { return retries; },
    get pauses() { return pauses; },
    get stops() { return stops; },
    get closes() { return closes; },
  };
}

test("fleet rendering fills the screen and stays inside narrow and wide terminal widths", () => {
  const { overlay } = harness();
  for (const width of [40, 60, 100, 160]) {
    const lines = overlay.render(width);
    assert.equal(lines.length, 29);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
  }
  overlay.dispose();
});

test("narrow fleet view drills into details and escape returns before closing", () => {
  const state = harness();
  try {
    state.overlay.render(60);
    state.overlay.handleInput("enter");
    assert.match(state.overlay.render(60).join("\n"), /node details/);

    state.overlay.handleInput("escape");
    assert.equal(state.closes, 0);
    assert.match(state.overlay.render(60).join("\n"), /workflow nodes/);

    state.overlay.handleInput("escape");
    assert.equal(state.closes, 1);
  } finally { state.overlay.dispose(); }
});

test("fleet selection follows stable workflow and node ids as rows are inserted", () => {
  const state = harness();
  try {
    state.overlay.render(120);
    state.overlay.handleInput("down");
    const next = workflow();
    next.nodes = {
      aaa: { spec: { id: "aaa", label: "New independent node", agent: "scout", task: "new", dependsOn: [] }, status: "queued", attempts: [] },
      ...next.nodes,
    };
    state.replaceWorkflow(next);
    const rendered = state.overlay.render(120).join("\n");
    assert.match(rendered, /build/);
    assert.match(rendered, /worker/);
  } finally { state.overlay.dispose(); }
});

test("fleet disables pause and stop for a foreign-owned authoritative attempt", async () => {
  const state = harness(false);
  try {
    state.overlay.handleInput("down");
    state.overlay.handleInput("p");
    state.overlay.handleInput("x");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.pauses, 0);
    assert.equal(state.stops, 0);
    assert.match(state.notices.join("\n"), /disabled for foreign/);
  } finally { state.overlay.dispose(); }
});

test("fleet keyboard actions target the selected node and disposal removes redraws", async () => {
  const state = harness();
  try {
    state.overlay.handleInput("down");
    state.overlay.handleInput("p");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.pauses, 1);
    const rendersBeforeDispose = state.renders;
    state.overlay.dispose();
    for (const listener of state.listeners) listener();
    assert.equal(state.renders, rendersBeforeDispose);
  } finally { state.overlay.dispose(); }
});
