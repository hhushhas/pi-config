import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowScheduler, type WorkflowRpc } from "./scheduler.ts";
import { WorkflowStore } from "./store.ts";

class FakeRpc implements WorkflowRpc {
  readonly launches: Array<{ params: Record<string, unknown>; runId: string; asyncDir: string }> = [];
  private nextId = 0;

  constructor(private readonly root: string) {}

  createRequestId(): string {
    return `request-${++this.nextId}`;
  }

  async spawn(params: Record<string, unknown>): Promise<{ text: string; details: { runId: string; asyncDir: string } }> {
    const runId = `run-${this.launches.length + 1}`;
    const asyncDir = join(this.root, runId);
    await mkdir(asyncDir, { recursive: true });
    await writeFile(join(asyncDir, "status.json"), JSON.stringify({
      runId,
      state: "running",
      startedAt: Date.now(),
      steps: [{ model: params.model }],
    }));
    this.launches.push({ params, runId, asyncDir });
    return { text: "started", details: { runId, asyncDir } };
  }

  async status(_runId: string): Promise<void> {}
  async interrupt(_runId: string): Promise<void> {}
  async stop(_runId: string): Promise<void> {}
}

class DelayedRpc extends FakeRpc {
  private releaseSpawn!: () => void;
  private readonly spawnGate = new Promise<void>((resolve) => { this.releaseSpawn = resolve; });
  private markSpawnStarted!: () => void;
  readonly spawnStarted = new Promise<void>((resolve) => { this.markSpawnStarted = resolve; });
  readonly stops: string[] = [];
  readonly interrupts: string[] = [];

  override async spawn(params: Record<string, unknown>) {
    this.markSpawnStarted();
    await this.spawnGate;
    return super.spawn(params);
  }

  release(): void {
    this.releaseSpawn();
  }

  override async stop(runId: string): Promise<void> {
    this.stops.push(runId);
  }

  override async interrupt(runId: string): Promise<void> {
    this.interrupts.push(runId);
  }
}

class DelayedStopRpc extends FakeRpc {
  private releaseStop!: () => void;
  private readonly stopGate = new Promise<void>((resolve) => { this.releaseStop = resolve; });

  override async stop(): Promise<void> {
    await this.stopGate;
  }

  release(): void {
    this.releaseStop();
  }
}

class DelayedStore extends WorkflowStore {
  private releasePreparation!: () => void;
  private markPreparationStarted!: () => void;
  private readonly preparationGate = new Promise<void>((resolve) => { this.releasePreparation = resolve; });
  readonly preparationStarted = new Promise<void>((resolve) => { this.markPreparationStarted = resolve; });

  override async prepareAttempt(workflowId: string, nodeId: string, attemptNumber: number): Promise<string> {
    this.markPreparationStarted();
    await this.preparationGate;
    return super.prepareAttempt(workflowId, nodeId, attemptNumber);
  }

  release(): void {
    this.releasePreparation();
  }
}

test("launches dependents only after prerequisites succeed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-test-"));
  try {
    const rpc = new FakeRpc(join(root, "subagents"));
    const scheduler = new WorkflowScheduler(rpc, new WorkflowStore(join(root, "store"), "/project"), "session-1", undefined, "openai-codex/gpt-5.6-sol", () => {}, 2);
    await scheduler.initialize();
    const workflow = await scheduler.create({
      name: "dependency proof",
      maxConcurrency: 2,
      nodes: [
        { id: "first", agent: "worker", task: "first" },
        { id: "second", agent: "reviewer", task: "second", dependsOn: ["first"] },
      ],
    });
    assert.deepEqual(rpc.launches.map((launch) => launch.params.task), ["first"]);

    await writeFile(join(rpc.launches[0].asyncDir, "status.json"), JSON.stringify({ state: "complete", endedAt: Date.now() }));
    await scheduler.tick();
    assert.deepEqual(rpc.launches.map((launch) => launch.params.task), ["first", "second"]);
    assert.equal(scheduler.get(workflow.id).nodes.first.status, "succeeded");
    scheduler.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery waits for explicit resume before launching downstream work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-recovery-"));
  try {
    const store = new WorkflowStore(join(root, "store"), "/project");
    const firstRpc = new FakeRpc(join(root, "subagents"));
    const first = new WorkflowScheduler(firstRpc, store, "session-1", undefined, undefined, () => {}, 1);
    await first.initialize();
    const workflow = await first.create({
      name: "recovery proof",
      nodes: [
        { id: "first", agent: "worker", task: "first" },
        { id: "second", agent: "worker", task: "second", dependsOn: ["first"] },
      ],
    });
    first.dispose();

    const secondRpc = new FakeRpc(join(root, "subagents-2"));
    const recovered = new WorkflowScheduler(secondRpc, store, "session-2", undefined, undefined, () => {}, 1);
    await recovered.initialize();
    assert.equal(recovered.get(workflow.id).status, "awaiting_resume");
    await writeFile(join(firstRpc.launches[0].asyncDir, "status.json"), JSON.stringify({ state: "complete", endedAt: Date.now() }));
    await recovered.tick();
    assert.equal(secondRpc.launches.length, 0);

    await recovered.resume(workflow.id);
    assert.deepEqual(secondRpc.launches.map((launch) => launch.params.task), ["second"]);
    const persisted = JSON.parse(await readFile(join(store.workflowDir(workflow.id), "state.json"), "utf8"));
    assert.equal(persisted.ownerSessionId, "session-2");
    recovered.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a recovered workflow that already finished does not ask to resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-finished-recovery-"));
  try {
    const store = new WorkflowStore(join(root, "store"), "/project");
    const firstRpc = new FakeRpc(join(root, "subagents"));
    const first = new WorkflowScheduler(firstRpc, store, "session-1", undefined, undefined, () => {}, 1);
    await first.initialize();
    const workflow = await first.create({
      name: "finished recovery proof",
      nodes: [{ id: "only", agent: "worker", task: "only" }],
    });
    await writeFile(join(firstRpc.launches[0].asyncDir, "status.json"), JSON.stringify({ state: "complete", endedAt: Date.now() }));
    first.dispose();

    const recovered = new WorkflowScheduler(new FakeRpc(join(root, "subagents-2")), store, "session-2", undefined, undefined, () => {}, 1);
    await recovered.initialize();
    assert.equal(recovered.get(workflow.id).status, "succeeded");
    assert.equal(recovered.resumableWorkflows().length, 0);
    recovered.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stopping a node while spawn is pending stops the child after launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-stop-launch-"));
  let scheduler: WorkflowScheduler | undefined;
  try {
    const rpc = new DelayedRpc(join(root, "subagents"));
    scheduler = new WorkflowScheduler(rpc, new WorkflowStore(join(root, "store"), "/project"), "session-1", undefined, undefined, () => {}, 1);
    await scheduler.initialize();
    const creating = scheduler.create({ name: "stop race", nodes: [{ id: "only", agent: "worker", task: "only" }] });
    await rpc.spawnStarted;
    const workflow = scheduler.snapshot()[0];
    await scheduler.stopNode(workflow.id, "only");
    rpc.release();
    await creating;
    assert.equal(scheduler.get(workflow.id).nodes.only.status, "stopping");
    assert.deepEqual(rpc.stops, ["run-1"]);
    await writeFile(join(rpc.launches[0].asyncDir, "status.json"), JSON.stringify({ state: "failed", endedAt: Date.now() }));
    await scheduler.tick();
    assert.equal(scheduler.get(workflow.id).nodes.only.status, "stopped");
  } finally {
    scheduler?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("stopping a node while attempt setup is pending prevents its launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-stop-setup-"));
  let scheduler: WorkflowScheduler | undefined;
  try {
    const rpc = new FakeRpc(join(root, "subagents"));
    const store = new DelayedStore(join(root, "store"), "/project");
    scheduler = new WorkflowScheduler(rpc, store, "session-1", undefined, undefined, () => {}, 1);
    await scheduler.initialize();
    const creating = scheduler.create({ name: "setup stop race", nodes: [{ id: "only", agent: "worker", task: "only" }] });
    await store.preparationStarted;
    const workflow = scheduler.snapshot()[0];
    await scheduler.stopNode(workflow.id, "only");
    store.release();
    await creating;
    assert.equal(scheduler.get(workflow.id).nodes.only.status, "stopped");
    assert.equal(rpc.launches.length, 0);
  } finally {
    scheduler?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("pausing a workflow while spawn is pending interrupts the child after launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-pause-launch-"));
  let scheduler: WorkflowScheduler | undefined;
  try {
    const rpc = new DelayedRpc(join(root, "subagents"));
    scheduler = new WorkflowScheduler(rpc, new WorkflowStore(join(root, "store"), "/project"), "session-1", undefined, undefined, () => {}, 1);
    await scheduler.initialize();
    const creating = scheduler.create({ name: "pause race", nodes: [{ id: "only", agent: "worker", task: "only" }] });
    await rpc.spawnStarted;
    const workflow = scheduler.snapshot()[0];
    await scheduler.pause(workflow.id);
    rpc.release();
    await creating;
    assert.equal(scheduler.get(workflow.id).nodes.only.status, "pausing");
    assert.deepEqual(rpc.interrupts, ["run-1"]);
    await writeFile(join(rpc.launches[0].asyncDir, "status.json"), JSON.stringify({ state: "paused", endedAt: Date.now() }));
    await scheduler.tick();
    assert.equal(scheduler.get(workflow.id).nodes.only.status, "paused");
  } finally {
    scheduler?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a recovered run cannot be falsely marked stopped from a new session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-foreign-stop-"));
  try {
    const store = new WorkflowStore(join(root, "store"), "/project");
    const first = new WorkflowScheduler(new FakeRpc(join(root, "subagents")), store, "session-1", undefined, undefined, () => {}, 1);
    await first.initialize();
    const workflow = await first.create({ name: "foreign run", nodes: [{ id: "only", agent: "worker", task: "only" }] });
    first.dispose();
    const recovered = new WorkflowScheduler(new FakeRpc(join(root, "subagents-2")), store, "session-2", undefined, undefined, () => {}, 1);
    await recovered.initialize();
    await assert.rejects(recovered.stopNode(workflow.id, "only"), /previous Pi session/);
    assert.equal(recovered.get(workflow.id).nodes.only.status, "running");
    recovered.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second live Pi process observes an active workflow without taking ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-live-owner-"));
  let first: WorkflowScheduler | undefined;
  let second: WorkflowScheduler | undefined;
  try {
    const store = new WorkflowStore(join(root, "store"), "/project");
    const firstRpc = new FakeRpc(join(root, "subagents"));
    const firstRuntime = { processId: 101, isProcessAlive: (processId: number) => processId === 101 };
    first = new WorkflowScheduler(firstRpc, store, "session-1", undefined, undefined, () => {}, 1, firstRuntime);
    await first.initialize();
    const workflow = await first.create({ name: "owned elsewhere", nodes: [{ id: "only", agent: "worker", task: "only" }] });

    const secondRpc = new FakeRpc(join(root, "subagents-2"));
    const secondRuntime = { processId: 202, isProcessAlive: (processId: number) => processId === 101 || processId === 202 };
    second = new WorkflowScheduler(secondRpc, store, "session-2", undefined, undefined, () => {}, 1, secondRuntime);
    await second.initialize();
    assert.equal(second.resumableWorkflows().length, 0);
    await second.tick();
    assert.equal(secondRpc.launches.length, 0);
    await assert.rejects(second.stopNode(workflow.id, "only"), /another live Pi session/);

    await writeFile(join(firstRpc.launches[0].asyncDir, "status.json"), JSON.stringify({ state: "complete", endedAt: Date.now() }));
    await first.tick();
    await second.tick();
    assert.equal(second.get(workflow.id).status, "succeeded");
  } finally {
    first?.dispose();
    second?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("completion cannot resurrect or overwrite a node while stop RPC is pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-stop-completion-"));
  let scheduler: WorkflowScheduler | undefined;
  try {
    const rpc = new DelayedStopRpc(join(root, "subagents"));
    scheduler = new WorkflowScheduler(rpc, new WorkflowStore(join(root, "store"), "/project"), "session-1", undefined, undefined, () => {}, 1);
    await scheduler.initialize();
    const workflow = await scheduler.create({ name: "stop completion race", nodes: [{ id: "only", agent: "worker", task: "only" }] });
    const stopping = scheduler.stopNode(workflow.id, "only");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scheduler.get(workflow.id).nodes.only.status, "stopping");
    scheduler.handleCompletion({ runId: rpc.launches[0].runId, state: "complete", success: true, timestamp: Date.now() });
    rpc.release();
    await stopping;
    assert.equal(scheduler.get(workflow.id).nodes.only.status, "stopped");
  } finally {
    scheduler?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
