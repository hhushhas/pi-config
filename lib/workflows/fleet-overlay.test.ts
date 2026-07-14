import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { FleetOverlay, type FleetActions } from "./fleet-overlay.ts";
import type { WorkflowRun } from "./model.ts";

function workflow(): WorkflowRun {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: "wf-fleet",
    name: "A long dependency-aware fleet workflow",
    cwd: "/project",
    ownerSessionId: "session",
    status: "active",
    maxConcurrency: 4,
    createdAt: now,
    updatedAt: now,
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
          rpcRequestId: "request",
          packageRunId: "run",
          asyncDir: "/tmp/run",
          ownerSessionId: "session",
          requestedAt: now,
          startedAt: now,
          state: "running",
          sessionRoot: "/tmp/sessions",
          statusSnapshot: {
            state: "running",
            totalTokens: { input: 1200, output: 400, total: 1600 },
            totalCost: { inputTokens: 1200, outputTokens: 400, costUsd: 0.0123 },
            steps: [{ recentOutput: ["Reading a very long path that should never overflow the fleet overlay width."], turnCount: 3, toolCount: 8 }],
          },
        }],
      },
    },
  };
}

function harness() {
  const listeners = new Set<() => void>();
  let renders = 0;
  let retries = 0;
  const tui = { requestRender: () => { renders += 1; } } as unknown as TUI;
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
    }[binding] === data),
  } as KeybindingsManager;
  const actions: FleetActions = {
    snapshot: () => [workflow()],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resume: async () => {},
    pause: async () => {},
    stopNode: async () => {},
    retryNode: async () => { retries += 1; },
    notify: () => {},
  };
  const overlay = new FleetOverlay(tui, theme, keybindings, () => {}, actions);
  return { overlay, listeners, get renders() { return renders; }, get retries() { return retries; } };
}

test("fleet rendering stays inside narrow and wide terminal widths", () => {
  const { overlay } = harness();
  for (const width of [40, 60, 100, 160]) {
    for (const line of overlay.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
  }
  overlay.dispose();
});

test("fleet keyboard actions target the selected node and disposal removes redraws", async () => {
  const state = harness();
  state.overlay.handleInput("down");
  state.overlay.handleInput("r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.retries, 1);
  const rendersBeforeDispose = state.renders;
  state.overlay.dispose();
  for (const listener of state.listeners) listener();
  assert.equal(state.renders, rendersBeforeDispose);
});
