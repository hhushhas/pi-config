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
    },
  } as never;

  try {
    uiDashboard(pi, metricsRoot);
    lifecycle.get("session_start")?.({}, ctx);
    events.emit("subagent:dashboard-snapshot", { sessionId: "session-1", runningAgents: 3 });

    const component = footerFactory?.(
      { requestRender() {} },
      { fg: (_color: string, text: string) => text },
      { getExtensionStatuses: () => new Map() },
    );
    assert.match(component?.render(100)[2] ?? "", /3 agents/);
    assert.equal(bus.get("subagent:dashboard-snapshot")?.size, 1);

    lifecycle.get("session_shutdown")?.({}, ctx);
    assert.equal(bus.get("subagent:dashboard-snapshot")?.size, 0);
  } finally {
    rmSync(metricsRoot, { recursive: true, force: true });
  }
});
