/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry is test-only: scripted
 * stub sessions registered under the claude/codex names (the production
 * backends launch real processes and have their own live test files), plus
 * the real pi backend for its cheap registry precondition.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type { BackendName, ParentContext, SpawnTask } from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    piBackend,
    makeStubBackend({
      backend: "claude",
      defaultModelLabel: "claude/sonnet",
      contextWindow: 200_000,
      toolName: "Bash",
      cadenceMs: 40,
    }),
    makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/gpt-5-codex",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 30,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

const createTestRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "claude");
    assert.ok(snap.meta.sessionFilePath);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:claude\] completed: Say hello to the tests/,
    );
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    // The waitFor marked the settle as consumed.
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("FAIL: blow up please")),
    );
    // Poll without wait-interest so the settle is delivered unconsumed.
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Long running task")),
    );
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("the concurrency cap rejects a fifth running subagent", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(runtime, manager.spawn("codex", task("Task 5"))),
      /Max 4 subagents/,
    );
  });
});

test("pi spawn fails fast without the parent model registry", async () => {
  await withManager(async (manager, runtime) => {
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("needs a registry"))),
      /model registry/,
    );
    // The failed spawn must release its concurrency reservation.
    const snap = await runTool(runtime, manager.spawn("codex", task("ok")));
    assert.equal(snap.backend, "codex");
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    // Settle one subagent, then fill all four slots with running ones.
    const settled = await runTool(
      runtime,
      manager.spawn("claude", task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    // Restarting the settled one would be a fifth concurrent run.
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      /Max 4 subagents/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    // The fresh run flips the status back to running...
    while (manager.view.get(snap.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});

test("queued backend continuations retain their concurrency slot", async () => {
  await withManager(async (manager, runtime) => {
    const first = await runTool(
      runtime,
      manager.spawn("claude", task("First turn with a queued continuation")),
    );

    const activityDeadline = Date.now() + 5_000;
    while (
      !manager.view.get(first.id)?.liveAssistant?.text &&
      Date.now() < activityDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(manager.view.get(first.id)?.liveAssistant?.text);
    await runTool(runtime, manager.send(first.id, "Queued second turn"));

    const queueDeadline = Date.now() + 2_000;
    while (
      manager.view.get(first.id)?.queued.length === 0 &&
      Date.now() < queueDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(manager.view.get(first.id)?.queued.length, 1);

    let extraSpawn: Promise<{ error?: unknown }> | undefined;
    manager.view.setOnSettled((snap) => {
      if (snap.id === first.id && !extraSpawn) {
        extraSpawn = runTool(
          runtime,
          manager.spawn("claude", task("Must not become a fifth run")),
        ).then(
          () => ({}),
          (error: unknown) => ({ error }),
        );
      }
    });

    let maxVisibleRunning = 0;
    const recordRunning = () => {
      maxVisibleRunning = Math.max(
        maxVisibleRunning,
        manager.view.list().filter((snap) => snap.status === "running").length,
      );
    };
    const unsubscribe = manager.view.subscribe(recordRunning);
    try {
      await runTool(
        runtime,
        Effect.forEach(
          [1, 2, 3],
          (n) => manager.spawn("claude", task(`Concurrent peer ${n}`)),
          { concurrency: "unbounded" },
        ),
      );
      recordRunning();

      const settleDeadline = Date.now() + 5_000;
      while (!extraSpawn && Date.now() < settleDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(extraSpawn);
      const blocked = await extraSpawn;
      assert.match(String(blocked.error), /Max 4 subagents/);
      assert.ok(maxVisibleRunning <= 4);

      const continuationDeadline = Date.now() + 8_000;
      while (
        !manager.view.get(first.id)?.finalText.includes("Queued second turn") &&
        Date.now() < continuationDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.match(
        manager.view.get(first.id)?.finalText ?? "",
        /Queued second turn/,
      );
    } finally {
      unsubscribe();
    }
  });
});

test("takeover requestSend reports a rejected restart", async () => {
  await withManager(async (manager, runtime) => {
    const settled = await runTool(
      runtime,
      manager.spawn("claude", task("Settle before takeover retry")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Occupied slot ${n}`)),
        { concurrency: "unbounded" },
      ),
    );

    await assert.rejects(
      manager.view.requestSend(settled.id, "Keep this input for retry"),
      /Max 4 subagents/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

for (const mode of ["END_STREAM", "CRASH_STREAM"] as const) {
  test(`${mode} releases queued continuation capacity and delivers failure`, async () => {
    await withManager(async (manager, runtime) => {
      const deliveries: Array<{ status: string; error?: string }> = [];
      manager.view.setOnSettled((snap) => {
        deliveries.push({ status: snap.status, error: snap.errorText });
      });

      const first = await runTool(
        runtime,
        manager.spawn("claude", task(`${mode}: terminate the event stream`)),
      );
      const activityDeadline = Date.now() + 5_000;
      while (
        !manager.view.get(first.id)?.liveAssistant?.text &&
        Date.now() < activityDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(manager.view.get(first.id)?.liveAssistant?.text);
      await runTool(runtime, manager.send(first.id, "Accepted queued work"));

      const failureDeadline = Date.now() + 5_000;
      while (
        manager.view.get(first.id)?.errorText !==
          "Backend ended before queued work could start" &&
        Date.now() < failureDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        manager.view.get(first.id)?.errorText,
        "Backend ended before queued work could start",
      );
      assert.equal(deliveries.at(-1)?.status, "error");
      assert.equal(
        deliveries.at(-1)?.error,
        "Backend ended before queued work could start",
      );

      const replacements = await runTool(
        runtime,
        Effect.forEach(
          [1, 2, 3, 4],
          (n) => manager.spawn("codex", task(`Replacement ${n}`)),
          { concurrency: "unbounded" },
        ),
      );
      assert.equal(replacements.length, 4);
    });
  });
}
