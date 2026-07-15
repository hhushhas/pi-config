import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  activeToolsForBackgroundTerminals,
  BACKGROUND_TERMINAL_STATE_TYPE,
  restoreBackgroundTerminalEnabled,
  stopRunningTerminals,
} from "./index.ts";
import { TerminalManager } from "./src/manager.ts";
import { createTerminalRuntime, runTool } from "./src/runtime.ts";

function contextWithBranch(entries: unknown[]): ExtensionContext {
  return {
    sessionManager: { getBranch: () => entries },
  } as unknown as ExtensionContext;
}

test("background terminal tools are enabled by default and toggle as one independent capability", () => {
  const initial = ["read", "bash", "workflow"];
  const enabled = activeToolsForBackgroundTerminals(initial, true);
  assert.deepEqual(enabled, [
    "read",
    "bash",
    "workflow",
    "bg_start",
    "bg_status",
    "bg_list",
    "bg_kill",
  ]);
  assert.deepEqual(activeToolsForBackgroundTerminals(enabled, false), initial);
  assert.deepEqual(activeToolsForBackgroundTerminals(enabled, true), enabled);
});

test("session restore uses the latest enable-disable choice on the current branch", () => {
  assert.equal(restoreBackgroundTerminalEnabled(contextWithBranch([])), true);
  const custom = (enabled: boolean) => ({
    type: "custom",
    customType: BACKGROUND_TERMINAL_STATE_TYPE,
    data: { enabled },
  });
  assert.equal(
    restoreBackgroundTerminalEnabled(
      contextWithBranch([custom(false), { type: "message" }, custom(true)]),
    ),
    true,
  );
  assert.equal(
    restoreBackgroundTerminalEnabled(
      contextWithBranch([custom(true), custom(false)]),
    ),
    false,
  );
});

test("/stop kill path settles every running tracked terminal and consumes each completion", async () => {
  const runtime = createTerminalRuntime();
  try {
    const manager = await runtime.runPromise(TerminalManager);
    const settlements: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) => settlements.push({ id: snap.id, consumed }));
    const settled = await runTool(
      runtime,
      manager.start({ command: "true", title: "already done", cwd: process.cwd() }),
    );
    while (manager.view.get(settled.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    settlements.length = 0;

    const first = await runTool(
      runtime,
      manager.start({ command: "sleep 60", title: "first", cwd: process.cwd() }),
    );
    const second = await runTool(
      runtime,
      manager.start({ command: "sleep 60", title: "second", cwd: process.cwd() }),
    );
    const report = await stopRunningTerminals(manager, runtime);

    assert.deepEqual(new Set(report.map((entry) => entry.id)), new Set([first.id, second.id]));
    assert.ok(report.every((entry) => entry.status === "killed"));
    assert.equal(manager.view.get(settled.id)?.status, "done", "settled terminals are not affected");
    assert.deepEqual(
      settlements.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: first.id, consumed: true },
        { id: second.id, consumed: true },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    assert.deepEqual(await stopRunningTerminals(manager, runtime), []);
  } finally {
    await runtime.dispose();
  }
});
