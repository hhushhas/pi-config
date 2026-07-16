import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import uiDashboard from "../../extensions/ui-dashboard.ts";

test("dashboard restores async snapshots and removes session bus listeners", () => {
  const metricsRoot = mkdtempSync(join(tmpdir(), "pi-dashboard-test-"));
  const lifecycle = new Map<string, (...args: any[]) => void>();
  const bus = new Map<string, Set<(value: unknown) => void>>();
  let footerFactory: ((tui: any, theme: any, data: any) => { render(width: number): string[] }) | undefined;
  const widgets = new Map<string, any>();
  const renderers = new Map<string, (message: any, options: { expanded: boolean }, theme: any) => any>();
  const events = {
    on(channel: string, handler: (value: unknown) => void) {
      const handlers = bus.get(channel) ?? new Set();
      handlers.add(handler);
      bus.set(channel, handlers);
      return () => handlers.delete(handler);
    },
    emit(channel: string, value: unknown) {
      for (const handler of bus.get(channel) ?? []) handler(value);
    },
  };
  const pi = {
    events,
    on: (name: string, handler: (...args: any[]) => void) => lifecycle.set(name, handler),
    registerMessageRenderer: (type: string, renderer: (message: any, options: { expanded: boolean }, theme: any) => any) => renderers.set(type, renderer),
  } as never;
  const ctx = {
    cwd: "/tmp/project",
    mode: "tui",
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => [],
    },
    ui: {
      setFooter: (factory: typeof footerFactory) => { footerFactory = factory; },
      setWidget: (key: string, factory: any) => { if (factory) widgets.set(key, factory); else widgets.delete(key); },
    },
  } as never;

  try {
    uiDashboard(pi, metricsRoot);
    lifecycle.get("session_start")?.({}, ctx);
    events.emit("subagent:dashboard-snapshot", { sessionId: "session-1", runningAgents: 3 });
    events.emit("dashboard:direct-agent-info", { runningAgents: 2 });
    events.emit("subagent:control-event", { source: "async", event: { type: "needs_attention", runId: "role-1", agent: "worker", message: "Choose a recovery policy" } });

    const component = footerFactory?.(
      { requestRender() {} },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      { getExtensionStatuses: () => new Map() },
    );
    assert.match(component?.render(100)[2] ?? "", /5 agents/);
    assert.match(component?.render(100)[2] ?? "", /1 attention/);
    const widget = widgets.get("orchestration-attention")?.({}, { fg: (_color: string, text: string) => text, bold: (text: string) => text });
    assert.match(widget?.render(100)[0] ?? "", /worker: Choose a recovery policy/);
    assert.equal(bus.get("subagent:dashboard-snapshot")?.size, 1);

    const roleRenderer = renderers.get("subagent-notify");
    assert.ok(roleRenderer, "portable dashboard should override the pinned role notification renderer");
    const lifecycleCases = [
      ["completed", "done"],
      ["failed", "failed"],
      ["paused", "paused"],
    ] as const;
    for (const [status, expected] of lifecycleCases) {
      const rendered = roleRenderer({
        content: `Background task ${status}: **worker**\n\n${Array.from({ length: 80 }, (_, index) => `output ${index}`).join("\n")}`,
      }, { expanded: false }, { fg: (_color: string, text: string) => text, bold: (text: string) => text });
      const lines = rendered.render(80);
      assert.ok(lines.length <= 2);
      assert.match(lines[0] ?? "", new RegExp(expected));
      assert.match(lines[0] ?? "", /role agent · Pi/);
      const expanded = roleRenderer({ content: `Background task ${status}: **worker**\n\n${"line\n".repeat(100)}` }, { expanded: true }, { fg: (_color: string, text: string) => text, bold: (text: string) => text });
      assert.ok(expanded.render(80).length <= 36);
    }

    const controlRenderer = renderers.get("subagent_control_notice");
    assert.ok(controlRenderer);
    const attentionCard = controlRenderer({ content: "Choose a recovery policy", details: { event: { type: "needs_attention", agent: "worker", runId: "role-1", message: "Choose a recovery policy" } } }, { expanded: false }, { fg: (_color: string, text: string) => text, bold: (text: string) => text });
    assert.match(attentionCard.render(100).join("\n"), /attention worker · role agent · Pi · role-1/);

    events.emit("subagent:async-complete", { sessionId: "session-1", runId: "role-1" });
    assert.equal(widgets.has("orchestration-attention"), false);
    lifecycle.get("session_shutdown")?.({}, ctx);
    assert.equal(bus.get("subagent:dashboard-snapshot")?.size, 0);
  } finally {
    rmSync(metricsRoot, { recursive: true, force: true });
  }
});
