import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  grokBackend,
  grokReasoningEffort,
} from "./src/backends/grok.ts";
import type { ParentContext, SpawnTask } from "./src/domain.ts";
import { SubagentManager } from "./src/manager.ts";
import { createSubagentRuntime, runTool } from "./src/runtime.ts";

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return {
    prompt,
    title: "live Grok test",
    cwd: process.cwd(),
    model: "grok-4.5",
    reasoningEffort: "low",
    parent,
  };
}

function deadline<A>(operation: Promise<A>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Live Grok test exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function grokAvailable() {
  return Effect.runPromise(grokBackend.available);
}

test("Grok effort maps to the nearest supported level", () => {
  assert.equal(grokReasoningEffort("off"), "low");
  assert.equal(grokReasoningEffort("medium"), "medium");
  assert.equal(grokReasoningEffort("max"), "high");
  assert.equal(grokReasoningEffort(undefined), undefined);
});

test(
  "Grok backend completes a live manager run with tool activity",
  { timeout: 120_000 },
  async (t) => {
    if (!(await grokAvailable())) {
      t.skip("grok executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const spawned = await runTool(
        runtime,
        manager.spawn(
          "grok",
          task("Use the shell tool to run `pwd`, then reply with exactly: hello grok"),
        ),
      );

      await deadline(runTool(runtime, manager.waitFor([spawned.id])), 100_000);
      const done = manager.view.get(spawned.id);
      assert.equal(done?.status, "done", done?.errorText);
      assert.match(done?.finalText ?? "", /hello grok/i);
      assert.equal(done?.meta.backend, "grok");
      assert.equal(done?.meta.modelLabel, "grok-4.5");
      assert.equal(done?.meta.contextWindow, 500_000);
      assert.ok(done?.meta.nativeSessionId);
      assert.ok(done?.meta.sessionFilePath);
      assert.ok(done?.usage.tokens);
      assert.ok(done?.transcript.some((item) => item.kind === "toolResult"));

      await runTool(runtime, manager.send(spawned.id, "Reply with exactly: second grok"));
      await deadline(runTool(runtime, manager.waitFor([spawned.id])), 100_000);
      const continued = manager.view.get(spawned.id);
      assert.equal(continued?.status, "done", continued?.errorText);
      assert.match(continued?.finalText ?? "", /second grok/i);
    } finally {
      await runtime.dispose();
    }
  },
);

test(
  "Grok backend interrupt settles a live manager run",
  { timeout: 45_000 },
  async (t) => {
    if (!(await grokAvailable())) {
      t.skip("grok executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const spawned = await runTool(
        runtime,
        manager.spawn(
          "grok",
          task("Run `sleep 30`, then reply with the word finished."),
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 500));
      const result = await deadline(
        runTool(runtime, manager.cancel([spawned.id])),
        10_000,
      );
      assert.equal(result[0]?.cancelled, true);
      assert.equal(manager.view.get(spawned.id)?.status, "error");
      assert.equal(manager.view.get(spawned.id)?.errorText, "Run was aborted");
    } finally {
      await runtime.dispose();
    }
  },
);
