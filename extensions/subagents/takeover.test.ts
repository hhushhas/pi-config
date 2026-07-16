import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  DirectAgentsOverlay,
  reconcileDashboardSelection,
  type DashboardSelection,
} from "./src/ui/takeover.ts";
import type { SubagentSnapshot } from "./src/domain.ts";
import type { SubagentReadModel } from "./src/manager.ts";
import { buildTranscriptLines } from "./src/ui/transcript.ts";

function snapshot(id: string, title: string): SubagentSnapshot {
  return {
    id,
    backend: id.includes("claude") ? "claude" : "codex",
    title,
    prompt: "review",
    cwd: "/project",
    status: "running",
    createdAt: Date.now(),
    meta: { backend: id.includes("claude") ? "claude" : "codex", modelLabel: "test-model" },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
  };
}

function overlayHarness() {
  let subs = [snapshot("claude-1", "Security review"), snapshot("codex-2", "Code review")];
  const listeners = new Set<() => void>();
  let closes = 0;
  let renders = 0;
  const view: SubagentReadModel = {
    list: () => subs,
    get: (id) => subs.find((snap) => snap.id === id),
    size: () => subs.length,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeTo: () => () => {},
    requestSend: async () => {},
    requestAbort: () => {},
    setOnSettled: () => {},
  };
  const tui = { requestRender: () => { renders += 1; }, terminal: { rows: 30 } } as unknown as TUI;
  const theme = {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
  } as Theme;
  const keybindings = {
    getKeys: (binding: string) => [binding],
    matches: (data: string, binding: string) => ({
      "tui.select.cancel": "escape",
      "tui.select.confirm": "enter",
      "tui.select.up": "up",
      "tui.select.down": "down",
      "app.clear": "ctrl+l",
      "app.interrupt": "ctrl+c",
      "tui.editor.cursorUp": "alt+up",
      "tui.editor.cursorDown": "alt+down",
      "tui.editor.pageUp": "pageup",
      "tui.editor.pageDown": "pagedown",
    }[binding] === data),
  } as KeybindingsManager;
  const overlay = new DirectAgentsOverlay(tui, theme, keybindings, view, () => { closes += 1; });
  return {
    overlay,
    listeners,
    replace(next: SubagentSnapshot[]) { subs = next; for (const listener of listeners) listener(); },
    get closes() { return closes; },
    get renders() { return renders; },
  };
}

test("dashboard selection follows its subagent id and falls back by row", () => {
  const selection: DashboardSelection = { id: "sa-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "sa-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `sa-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "sa-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sa-${index + 1}` })),
    { id: "sa-8" },
    { id: "sa-9" },
  ]);
  assert.deepEqual(selection, { id: "sa-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "sa-1" }, { id: "sa-2" }]);
  assert.deepEqual(selection, { id: "sa-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});

test("direct-agent overlay is bounded and uses wide master-detail", () => {
  const state = overlayHarness();
  try {
    for (const width of [40, 60, 100, 160]) {
      const lines = state.overlay.render(width);
      assert.equal(lines.length, 29);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
    assert.match(state.overlay.render(120).join("\n"), /Security review/);
    assert.match(state.overlay.render(120).join("\n"), /transcript/);
  } finally {
    state.overlay.dispose();
  }
});

test("narrow direct-agent view drills down and preserves selection by id", () => {
  const state = overlayHarness();
  try {
    state.overlay.render(60);
    state.overlay.handleInput("down");
    state.replace([snapshot("new-0", "New"), snapshot("codex-2", "Code review")]);
    assert.match(state.overlay.render(60).join("\n"), /direct agents/);
    state.overlay.handleInput("enter");
    assert.match(state.overlay.render(60).join("\n"), /agent details · Code review/);
    state.overlay.handleInput("escape");
    assert.match(state.overlay.render(60).join("\n"), /direct agents/);
    state.overlay.handleInput("escape");
    assert.equal(state.closes, 1);
  } finally {
    state.overlay.dispose();
  }
});

test("direct transcript projection stays bounded", () => {
  const snap = snapshot("codex-bounded", "Bounded");
  const transcript = Array.from({ length: 400 }, (_, index) => ({ kind: "user" as const, text: `message ${index} ${"x".repeat(1000)}` }));
  const lines = buildTranscriptLines({ ...snap, transcript }, 40, {
    fg: (_name: string, text: string) => text,
    italic: (text: string) => text,
  } as Theme);
  assert.ok(lines.length <= 2_000);
  assert.match(lines.at(-1) ?? "", /message 399|x/);
});

test("direct-agent disposal removes streaming redraw subscription", () => {
  const state = overlayHarness();
  const renders = state.renders;
  state.overlay.dispose();
  for (const listener of state.listeners) listener();
  assert.equal(state.renders, renders);
});
