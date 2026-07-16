import { randomBytes, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { ControlReply, OperationReply, SpawnReply, WorkflowProvenance } from "./rpc-client.ts";
import type { WorkflowStore } from "./store.ts";
import {
  WORKFLOW_SCHEMA_VERSION,
  currentAttempt,
  deriveWorkflowStatus,
  descendantsOf,
  emptyTelemetry,
  readyNodeIds,
  validateDefinition,
  type AttemptControl,
  type LaunchedAttemptV2,
  type WorkflowDefinition,
  type WorkflowHarness,
  type WorkflowNode,
  type WorkflowRun,
} from "./model.ts";
import { authoritativeAttemptForRun, discoverExternalRuns, normalizedModel, rebuildWorkflowTelemetry, refreshAttemptFromDisk } from "./runtime.ts";

type Listener = () => void;
type Notice = (message: string, level: "info" | "warning" | "error", triggerTurn?: boolean) => void | Promise<void>;
type RuntimeIdentity = { processId: number; isProcessAlive(processId: number): boolean };

const DEFAULT_RUNTIME: RuntimeIdentity = {
  processId: process.pid,
  isProcessAlive(processId) {
    try { process.kill(processId, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  },
};

export interface WorkflowRpc {
  createRequestId(): string;
  spawn(params: Record<string, unknown>, requestId: string): Promise<SpawnReply>;
  resume(params: Record<string, unknown>, requestId: string): Promise<SpawnReply>;
  lookup(params: { operationId: string; workflowCapability: string; provenance: WorkflowProvenance; harness?: WorkflowHarness }): Promise<OperationReply>;
  status(runId: string, authority?: { workflowCapability: string; provenance: WorkflowProvenance; harness?: WorkflowHarness }): Promise<unknown>;
  interrupt(runId: string, authority: { controlRequestId: string; workflowCapability: string; provenance: WorkflowProvenance; harness?: WorkflowHarness }): Promise<ControlReply>;
  stop(runId: string, authority: { controlRequestId: string; workflowCapability: string; provenance: WorkflowProvenance; harness?: WorkflowHarness }): Promise<ControlReply>;
  steer(runId: string, message: string, authority: { controlRequestId: string; workflowCapability: string; provenance: WorkflowProvenance; harness?: WorkflowHarness }): Promise<ControlReply>;
}

export class WorkflowScheduler {
  private workflows = new Map<string, WorkflowRun>();
  private listeners = new Set<Listener>();
  private polling?: NodeJS.Timeout;
  private ticking = false;
  private disposed = false;
  private foreignOwned = new Set<string>();
  private ownedLeases = new Map<string, string>();
  private operationTail: Promise<void> = Promise.resolve();
  private intervalTickPending = false;

  constructor(
    private readonly rpc: WorkflowRpc,
    private readonly store: WorkflowStore,
    private sessionId: string,
    private readonly sessionFile: string | undefined,
    private readonly fallbackModel: string | undefined,
    private readonly notice: Notice,
    private readonly globalConcurrency = 4,
    private readonly runtime: RuntimeIdentity = DEFAULT_RUNTIME,
  ) {}

  async initialize(): Promise<void> {
    const loaded = await this.store.loadAll();
    for (const workflow of loaded) {
      if (!["succeeded", "failed", "stopped"].includes(workflow.status)) this.foreignOwned.add(workflow.id);
      this.workflows.set(workflow.id, workflow);
    }
    await this.refreshAll();
    this.polling = setInterval(() => this.scheduleIntervalTick(), 1000);
    this.polling.unref?.();
  }

  snapshot(): WorkflowRun[] { return [...this.workflows.values()].sort((a, b) => b.updatedAt - a.updatedAt); }
  subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  resumableWorkflows(): WorkflowRun[] { return this.snapshot().filter((workflow) => workflow.status === "awaiting_resume" || workflow.takeoverRequired); }

  async create(definition: WorkflowDefinition): Promise<WorkflowRun> { return this.runExclusive(() => this.createInternal(definition)); }

  private async createInternal(definition: WorkflowDefinition): Promise<WorkflowRun> {
    const specs = validateDefinition(definition);
    const executionCwd = await this.store.resolveExecutionCwd(definition.cwd);
    const now = Date.now();
    const id = `wf-${now.toString(36)}-${randomUUID().slice(0, 8)}`;
    for (const spec of specs) await this.resolveNodeCwd(executionCwd, spec.cwd);
    const workflow: WorkflowRun = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id,
      name: definition.name.trim(),
      projectCwd: this.store.projectCwd,
      executionCwd,
      cwd: executionCwd,
      workflowCapability: randomBytes(32).toString("base64url"),
      ownerSessionId: this.sessionId,
      ownerProcessId: this.runtime.processId,
      ownerHeartbeatAt: now,
      ...(this.sessionFile ? { ownerSessionFile: this.sessionFile } : {}),
      ownerLeaseId: randomUUID(),
      ownerLeaseEpoch: 1,
      stateRevision: 0,
      status: "active",
      maxConcurrency: definition.maxConcurrency ?? 4,
      createdAt: now,
      updatedAt: now,
      runtimeContract: { rpcVersion: 2, artifactVersion: 2 },
      nodes: Object.fromEntries(specs.map((spec) => [spec.id, { spec, status: "queued", attempts: [] }])),
      telemetry: emptyTelemetry(),
      notifications: [],
      externalEvidence: [],
    };
    this.workflows.set(id, workflow);
    this.ownedLeases.set(id, workflow.ownerLeaseId);
    await this.store.save(workflow);
    this.emit();
    await this.tickInternal();
    return workflow;
  }

  get(workflowId: string): WorkflowRun {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) throw new Error(`Workflow '${workflowId}' was not found.`);
    return workflow;
  }

  isForeignOwned(workflowId: string): boolean { return this.foreignOwned.has(workflowId); }

  async takeover(workflowId: string, confirmation: { revision: number; leaseId: string; leaseEpoch: number; ownerProcessId?: number }): Promise<void> { return this.runExclusive(() => this.takeoverInternal(workflowId, confirmation)); }

  private async takeoverInternal(workflowId: string, confirmation: { revision: number; leaseId: string; leaseEpoch: number; ownerProcessId?: number }): Promise<void> {
    const current = this.get(workflowId);
    if (!current.workflowCapability) throw new Error("Legacy workflows cannot be taken over.");
    const next = await this.store.takeover(workflowId, confirmation, { sessionId: this.sessionId, sessionFile: this.sessionFile, processId: this.runtime.processId });
    this.workflows.set(workflowId, next);
    this.ownedLeases.set(workflowId, next.ownerLeaseId);
    this.foreignOwned.delete(workflowId);
    this.emit();
    await this.tickInternal();
  }

  async resume(workflowId: string, nodeId?: string): Promise<void> { return this.runExclusive(() => this.resumeInternal(workflowId, nodeId)); }

  private async resumeInternal(workflowId: string, nodeId?: string): Promise<void> {
    this.assertLocallyControllable(workflowId);
    if (!nodeId) throw new Error("nodeId is required for context-preserving resume. Cross-session recovery uses explicit takeover.");
    const workflow = this.get(workflowId);
    const node = workflow.nodes[nodeId];
    if (!node) throw new Error(`Node '${nodeId}' was not found.`);
    const source = currentAttempt(node);
    if (!source || source.kind === "legacy" || source.state !== "paused" || !source.packageRunId || !source.childSessionFile) throw new Error(`Node '${nodeId}' does not have a causally confirmed resumable attempt.`);
    workflow.status = "active";
    const attempt = await this.prepareAttempt(workflow, node, "resume", source);
    const params = this.launchParams(workflow, node, attempt, await this.resolveNodeCwd(workflow.executionCwd, node.spec.cwd), {
      sourceRunId: source.packageRunId,
      sourceSessionFile: source.childSessionFile,
      sourceAttemptId: source.id,
      sourceProvenance: { workflowId: workflow.id, nodeId: node.spec.id, attemptId: source.id, ownerLeaseEpoch: source.launchLeaseEpoch },
      message: "Continue the assigned task from the paused session. Preserve prior context and finish the acceptance contract.",
    });
    await this.dispatchLaunch(workflow, node, attempt, "resume", params);
  }

  async pause(workflowId: string): Promise<void> { return this.runExclusive(() => this.pauseInternal(workflowId)); }

  private async pauseInternal(workflowId: string): Promise<void> {
    this.assertLocallyControllable(workflowId);
    const workflow = this.get(workflowId);
    workflow.status = "pausing";
    const targets = Object.values(workflow.nodes).filter((node) => node.status === "running" && currentAttempt(node)?.packageRunId);
    const controls = targets.map((node) => this.prepareControl(workflow, node, "pause"));
    await this.store.save(workflow);
    for (const { node, attempt, control } of controls) {
      try {
        const reply = await this.rpc.interrupt(attempt.packageRunId!, this.authority(workflow, node, attempt, control.controlRequestId));
        if (!reply.accepted) throw new Error(reply.message);
        control.acceptedAt = Date.now();
      } catch (error) {
        control.error = error instanceof Error ? error.message : String(error);
        workflow.status = "blocked";
        workflow.telemetry.controlFailures += 1;
      }
    }
    if (workflow.status === "blocked") await this.notifyTransition(workflow, "blocked");
    await this.store.save(workflow);
    this.emit();
  }

  async stopWorkflow(workflowId: string): Promise<void> { return this.runExclusive(() => this.stopWorkflowInternal(workflowId)); }

  private async stopWorkflowInternal(workflowId: string): Promise<void> {
    this.assertLocallyControllable(workflowId);
    const workflow = this.get(workflowId);
    const transitional = Object.values(workflow.nodes).find((node) => ["pausing", "stopping"].includes(node.status));
    if (transitional) throw new Error(`Node '${transitional.spec.id}' already has a control in progress; wait for causal confirmation before stopping the workflow.`);
    workflow.status = "stopping";
    const controls: Array<{ node: WorkflowNode; attempt: LaunchedAttemptV2; control: AttemptControl }> = [];
    for (const node of Object.values(workflow.nodes)) {
      const attempt = currentAttempt(node);
      if (node.status === "queued" && !attempt) {
        node.status = "stopped";
        continue;
      }
      if (!attempt || attempt.kind === "legacy" || !["running", "launching"].includes(node.status)) continue;
      const prepared = this.prepareControl(workflow, node, "stop");
      if (attempt.packageRunId) controls.push(prepared);
    }
    await this.store.save(workflow);
    const failures: string[] = [];
    for (const { node, attempt, control } of controls) {
      try {
        const reply = await this.rpc.stop(attempt.packageRunId!, this.authority(workflow, node, attempt, control.controlRequestId));
        if (!reply.accepted) throw new Error(reply.message);
        control.acceptedAt = Date.now();
      } catch (error) {
        control.error = error instanceof Error ? error.message : String(error);
        failures.push(`${node.spec.id}: ${control.error}`);
      }
    }
    if (failures.length) {
      workflow.status = "blocked";
      await this.notifyTransition(workflow, "blocked");
    }
    await this.store.save(workflow);
    this.emit();
    if (failures.length) throw new Error(`Workflow stop was rejected for ${failures.join("; ")}`);
  }

  async stopNode(workflowId: string, nodeId: string, persist = true): Promise<void> { return this.runExclusive(() => this.stopNodeInternal(workflowId, nodeId, persist)); }

  private async stopNodeInternal(workflowId: string, nodeId: string, persist = true): Promise<void> {
    this.assertLocallyControllable(workflowId);
    const workflow = this.get(workflowId);
    const node = workflow.nodes[nodeId];
    if (!node) throw new Error(`Node '${nodeId}' was not found.`);
    const attempt = currentAttempt(node);
    if (node.status === "queued" && !attempt) {
      node.status = "stopped";
      if (persist) await this.store.save(workflow);
      this.emit();
      return;
    }
    if (!attempt || attempt.kind === "legacy") throw new Error(`Node '${nodeId}' has no controllable authoritative attempt.`);
    if (["pausing", "stopping"].includes(node.status)) {
      throw new Error(`Node '${nodeId}' already has a ${node.status === "pausing" ? "pause" : "stop"} control in progress; wait for causal confirmation.`);
    }
    if (node.status === "launching") {
      this.prepareControl(workflow, node, "stop");
      if (persist) await this.store.save(workflow);
      this.emit();
      return;
    }
    if (node.status === "running" && attempt.packageRunId) {
      const { control } = this.prepareControl(workflow, node, "stop");
      if (persist) await this.store.save(workflow);
      try {
        const reply = await this.rpc.stop(attempt.packageRunId, this.authority(workflow, node, attempt, control.controlRequestId));
        if (!reply.accepted) throw new Error(reply.message);
        control.acceptedAt = Date.now();
      } catch (error) {
        control.error = error instanceof Error ? error.message : String(error);
        workflow.status = "blocked";
        workflow.telemetry.controlFailures += 1;
        if (persist) {
          await this.notifyTransition(workflow, "blocked");
          await this.store.save(workflow);
        }
        throw error;
      }
    } else if (!["succeeded", "failed", "paused", "stopped", "orphaned", "invalidated"].includes(node.status)) {
      throw new Error(`Node '${nodeId}' is not in a stoppable lifecycle state.`);
    }
    if (persist) await this.store.save(workflow);
    this.emit();
  }

  async nudgeNode(workflowId: string, nodeId: string, message: string): Promise<void> { return this.runExclusive(() => this.nudgeNodeInternal(workflowId, nodeId, message)); }

  private async nudgeNodeInternal(workflowId: string, nodeId: string, message: string): Promise<void> {
    this.assertLocallyControllable(workflowId);
    const workflow = this.get(workflowId);
    const node = workflow.nodes[nodeId];
    const attempt = node && currentAttempt(node);
    if (!node || !attempt || attempt.kind === "legacy" || node.status !== "running" || !attempt.packageRunId) throw new Error(`Node '${nodeId}' is not a steerable authoritative live run.`);
    await this.store.assertAuthority(workflow.id, { revision: workflow.stateRevision, leaseId: workflow.ownerLeaseId, leaseEpoch: workflow.ownerLeaseEpoch });
    const controlRequestId = randomUUID();
    const reply = await this.rpc.steer(attempt.packageRunId, message, this.authority(workflow, node, attempt, controlRequestId));
    if (!reply.accepted) throw new Error(reply.message);
    attempt.controls.push({ controlRequestId, action: "steer", requestedAt: Date.now(), acceptedAt: Date.now(), confirmedAt: Date.now() });
    await this.store.save(workflow);
  }

  async retryNode(workflowId: string, nodeId: string): Promise<void> { return this.runExclusive(() => this.retryNodeInternal(workflowId, nodeId)); }

  private async retryNodeInternal(workflowId: string, nodeId: string): Promise<void> {
    this.assertLocallyControllable(workflowId);
    const workflow = this.get(workflowId);
    const node = workflow.nodes[nodeId];
    if (!node) throw new Error(`Node '${nodeId}' was not found.`);
    if (!["succeeded", "failed", "paused", "stopped", "orphaned"].includes(node.status)) {
      throw new Error(`Node '${nodeId}' can be retried only from a terminal state; current state is '${node.status}'.`);
    }
    const descendants = descendantsOf(workflow, nodeId);
    const requestedStops: Array<{ nodeId: string; attemptId: string; controlRequestId: string }> = [];
    for (const descendantId of descendants) {
      const child = workflow.nodes[descendantId];
      if (["running", "pausing", "stopping"].includes(child.status)) {
        await this.stopNodeInternal(workflowId, descendantId);
        const attempt = currentAttempt(child);
        const control = attempt?.controls.at(-1);
        if (attempt && control?.action === "stop") requestedStops.push({ nodeId: descendantId, attemptId: attempt.id, controlRequestId: control.controlRequestId });
      }
    }
    const deadline = Date.now() + 15_000;
    while (descendants.some((id) => ["running", "pausing", "stopping"].includes(workflow.nodes[id].status))) {
      if (Date.now() >= deadline) throw new Error("Retry refused because a live descendant did not confirm stop.");
      await this.refreshAll();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    for (const requested of requestedStops) {
      const attempt = workflow.nodes[requested.nodeId].attempts.find((candidate) => candidate.id === requested.attemptId);
      const control = attempt?.controls.find((candidate) => candidate.controlRequestId === requested.controlRequestId);
      if (!attempt || attempt.state !== "stopped" || !control?.confirmedAt || control.error) {
        throw new Error(`Retry refused because descendant '${requested.nodeId}' did not causally confirm stop '${requested.controlRequestId}'.`);
      }
    }
    const previous = currentAttempt(node);
    const invalidatedAt = Date.now();
    for (const descendantId of descendants) {
      const child = workflow.nodes[descendantId];
      child.invalidatedAt = invalidatedAt;
      child.invalidatedByAttemptId = previous?.id;
      child.status = "queued";
      child.authoritativeAttemptId = undefined;
    }
    node.status = "queued";
    workflow.status = "active";
    await this.store.save(workflow);
    this.emit();
    await this.launchNode(workflow, node, "retry", previous);
  }

  handleCompletion(value: unknown): void { void this.runExclusive(() => this.consumeCompletion(value)); }

  async tick(): Promise<void> { return this.runExclusive(() => this.tickInternal()); }

  private async tickInternal(): Promise<void> {
    if (this.disposed) return;
    if (this.ticking) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      return this.tickInternal();
    }
    this.ticking = true;
    try {
      let changed = await this.refreshAll();
      changed = (await this.heartbeatOwnedWorkflows()) || changed;
      changed = (await this.retryPendingNotifications()) || changed;
      let capacity = this.globalConcurrency - this.activeNodeCount();
      for (const workflow of this.snapshot()) {
        if (capacity <= 0) break;
        if (workflow.status !== "active" || this.foreignOwned.has(workflow.id) || workflow.controlsDisabled) continue;
        let localCapacity = workflow.maxConcurrency - Object.values(workflow.nodes).filter((node) => ["launching", "running", "pausing", "stopping"].includes(node.status)).length;
        for (const nodeId of readyNodeIds(workflow)) {
          if (capacity <= 0 || localCapacity <= 0) break;
          await this.launchNode(workflow, workflow.nodes[nodeId], "initial");
          capacity -= 1; localCapacity -= 1;
        }
        const nextStatus = deriveWorkflowStatus(workflow);
        if (nextStatus !== workflow.status) {
          workflow.status = nextStatus;
          await this.notifyTransition(workflow, nextStatus);
          await this.store.save(workflow);
          changed = true;
        }
      }
      if (changed) this.emit();
    } finally { this.ticking = false; }
  }

  dispose(): void { this.disposed = true; if (this.polling) clearInterval(this.polling); this.listeners.clear(); }

  private async launchNode(workflow: WorkflowRun, node: WorkflowNode, kind: "initial" | "retry" = "initial", previous?: LaunchedAttemptV2 | import("./model.ts").LegacyAttemptV2): Promise<void> {
    if (workflow.status !== "active" || node.status !== "queued") return;
    const attempt = await this.prepareAttempt(workflow, node, kind, previous);
    const cwd = await this.resolveNodeCwd(workflow.executionCwd, node.spec.cwd);
    await this.dispatchLaunch(workflow, node, attempt, "spawn", this.launchParams(workflow, node, attempt, cwd));
  }

  private async prepareAttempt(workflow: WorkflowRun, node: WorkflowNode, kind: "initial" | "resume" | "retry", previous?: import("./model.ts").NodeAttempt): Promise<LaunchedAttemptV2> {
    const attemptNumber = node.attempts.length + 1;
    const attemptDir = await this.store.prepareAttempt(workflow.id, node.spec.id, attemptNumber);
    const executionCwd = await this.resolveNodeCwd(workflow.executionCwd, node.spec.cwd);
    const harness = node.spec.harness ?? "pi";
    const defaultModel = harness === "pi" ? this.fallbackModel : undefined;
    const configuredModel = harness === "pi" ? normalizedModel(node.spec.model, node.spec.thinking, defaultModel) : node.spec.model;
    const expectedModel = kind === "resume" ? previous?.telemetry?.model ?? configuredModel : configuredModel;
    const expectedThinking = kind === "resume" ? previous?.telemetry?.thinking ?? node.spec.thinking : node.spec.thinking;
    const attempt: LaunchedAttemptV2 = {
      id: `attempt-${attemptNumber}`,
      kind,
      launchOperationId: randomUUID(),
      rpcRequestId: this.rpc.createRequestId(),
      ownerSessionId: this.sessionId,
      requestedAt: Date.now(),
      state: "launching",
      sessionRoot: resolve(attemptDir, "sessions"),
      dependencyAttemptIds: Object.fromEntries(node.spec.dependsOn.map((id) => [id, currentAttempt(workflow.nodes[id])!.id])),
      controls: [],
      runtimeProtocolVersion: 2,
      artifactVersion: 2,
      launchLeaseEpoch: workflow.ownerLeaseEpoch,
      expectedExecution: {
        harness,
        agent: node.spec.agent,
        ...(expectedModel ? { model: expectedModel } : {}),
        ...(expectedThinking ? { thinking: expectedThinking } : {}),
        cwd: executionCwd,
        ...(node.spec.timeoutMs ? { timeoutMs: node.spec.timeoutMs } : {}),
        notificationMode: "event-only",
      },
      ...(previous ? { previousAttemptId: previous.id, sourceRunId: previous.packageRunId } : {}),
    };
    node.attempts.push(attempt);
    if (kind !== "resume") node.authoritativeAttemptId = attempt.id;
    node.status = "launching";
    await this.store.save(workflow);
    this.emit();
    return attempt;
  }

  private launchParams(workflow: WorkflowRun, node: WorkflowNode, attempt: LaunchedAttemptV2, cwd: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      agent: node.spec.agent,
      task: node.spec.task,
      ...(node.spec.harness && node.spec.harness !== "pi" ? { harness: node.spec.harness } : {}),
      cwd,
      context: "fresh",
      async: true,
      clarify: false,
      artifacts: true,
      sessionDir: attempt.sessionRoot,
      operationId: attempt.launchOperationId,
      workflowCapability: workflow.workflowCapability,
      provenance: this.provenance(workflow, node, attempt),
      notificationMode: "event-only",
      ...(attempt.expectedExecution.timeoutMs ? { timeoutMs: attempt.expectedExecution.timeoutMs } : {}),
      ...(attempt.expectedExecution.model ? { model: attempt.expectedExecution.model } : {}),
      ...(attempt.expectedExecution.thinking ? { thinking: attempt.expectedExecution.thinking } : {}),
      ...extra,
    };
  }

  private async dispatchLaunch(workflow: WorkflowRun, node: WorkflowNode, attempt: LaunchedAttemptV2, method: "spawn" | "resume", params: Record<string, unknown>): Promise<void> {
    try {
      let reply: SpawnReply;
      try { reply = await this.rpc[method](params, attempt.rpcRequestId); }
      catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "timeout" && code !== "unknown_outcome") throw error;
        const operation = await this.rpc.lookup({ operationId: attempt.launchOperationId, workflowCapability: workflow.workflowCapability, provenance: this.provenance(workflow, node, attempt), ...(node.spec.harness && node.spec.harness !== "pi" ? { harness: node.spec.harness } : {}) });
        reply = { runId: operation.runId, asyncDir: operation.asyncDir, operation };
      }
      const runId = reply.runId ?? reply.operation?.runId ?? reply.details?.runId ?? reply.details?.asyncId;
      const asyncDir = reply.asyncDir ?? reply.operation?.asyncDir ?? reply.details?.asyncDir;
      if (!runId || !asyncDir) throw new Error("Subagent launch did not return a run identity.");
      attempt.packageRunId = runId;
      attempt.asyncDir = asyncDir;
      attempt.pid = reply.operation?.pid;
      attempt.startedAt = Date.now();
      const observed = await refreshAttemptFromDisk(workflow, node, attempt);
      const pendingStop = [...attempt.controls].reverse().find((control) => control.action === "stop" && !control.confirmedAt && !control.error);
      if (!observed || attempt.error || !["running", "stopping"].includes(attempt.state)) throw new Error(attempt.error ?? "Subagent launch did not publish a matching authoritative runtime artifact.");
      node.authoritativeAttemptId = attempt.id;
      node.status = pendingStop ? "stopping" : "running";
      if (pendingStop) {
        attempt.state = "stopping";
        await this.store.save(workflow);
        const controlReply = await this.rpc.stop(runId, this.authority(workflow, node, attempt, pendingStop.controlRequestId));
        if (!controlReply.accepted) throw new Error(controlReply.message);
        pendingStop.acceptedAt = Date.now();
      }
    } catch (error) {
      attempt.error = error instanceof Error ? error.message : String(error);
      const pendingAttachedControl = attempt.packageRunId && node.authoritativeAttemptId === attempt.id
        ? [...attempt.controls].reverse().find((control) => ["pause", "stop"].includes(control.action) && !control.confirmedAt)
        : undefined;
      if (pendingAttachedControl) {
        pendingAttachedControl.error = attempt.error;
        attempt.state = pendingAttachedControl.action === "stop" ? "stopping" : "pausing";
        node.status = attempt.state;
        workflow.status = "blocked";
      } else if (method === "resume" && attempt.previousAttemptId) {
        attempt.state = "orphaned";
        attempt.endedAt = Date.now();
        const source = node.attempts.find((candidate) => candidate.id === attempt.previousAttemptId);
        node.authoritativeAttemptId = source?.id;
        node.status = source?.state === "paused" ? "paused" : "orphaned";
        workflow.status = source?.state === "paused" ? "paused" : "blocked";
      } else {
        attempt.state = "orphaned";
        attempt.endedAt = Date.now();
        node.status = "orphaned";
        workflow.status = "blocked";
      }
      await this.notifyTransition(workflow, workflow.status);
    }
    rebuildWorkflowTelemetry(workflow);
    await this.store.save(workflow);
    this.emit();
  }

  private prepareControl(workflow: WorkflowRun, node: WorkflowNode, action: "pause" | "stop"): { node: WorkflowNode; attempt: LaunchedAttemptV2; control: AttemptControl } {
    const attempt = currentAttempt(node);
    if (!attempt || attempt.kind === "legacy" || !attempt.packageRunId) throw new Error(`Node '${node.spec.id}' has no controllable authoritative run.`);
    const control: AttemptControl = { controlRequestId: randomUUID(), action, requestedAt: Date.now() };
    attempt.controls.push(control);
    attempt.state = action === "pause" ? "pausing" : "stopping";
    node.status = attempt.state;
    return { node, attempt, control };
  }

  private provenance(workflow: WorkflowRun, node: WorkflowNode, attempt: LaunchedAttemptV2): WorkflowProvenance {
    return { workflowId: workflow.id, nodeId: node.spec.id, attemptId: attempt.id, ownerLeaseEpoch: attempt.launchLeaseEpoch };
  }

  private authority(workflow: WorkflowRun, node: WorkflowNode, attempt: LaunchedAttemptV2, controlRequestId: string) {
    return { controlRequestId, workflowCapability: workflow.workflowCapability, provenance: this.provenance(workflow, node, attempt), ...(node.spec.harness && node.spec.harness !== "pi" ? { harness: node.spec.harness } : {}) };
  }

  private async consumeCompletion(value: unknown): Promise<void> {
    if (!value || typeof value !== "object") return;
    const result = value as Record<string, unknown>;
    const runId = String(result.runId ?? result.id ?? "");
    if (!runId) return;
    for (const workflow of this.workflows.values()) {
      const found = authoritativeAttemptForRun(workflow, runId);
      if (!found || found.attempt.completionSeen) continue;
      if (found.attempt.kind !== "legacy") {
        const identity = result.sessionIdentity as Record<string, unknown> | undefined;
        const launch = result.runtimeLaunch as Record<string, unknown> | undefined;
        const provenance = launch?.provenance as Record<string, unknown> | undefined;
        if (!identity || !launch || !provenance
          || identity.workflowId !== workflow.id || identity.nodeId !== found.node.spec.id || identity.attemptId !== found.attempt.id
          || identity.ownerLeaseEpoch !== found.attempt.launchLeaseEpoch || launch.operationId !== found.attempt.launchOperationId || launch.runId !== runId
          || provenance.workflowId !== workflow.id || provenance.nodeId !== found.node.spec.id || provenance.attemptId !== found.attempt.id) return;
      }
      const changed = await refreshAttemptFromDisk(workflow, found.node, found.attempt, found.authoritative);
      if (!changed || !found.attempt.completionSeen) return;
      rebuildWorkflowTelemetry(workflow);
      const previousStatus = workflow.status;
      workflow.status = deriveWorkflowStatus(workflow);
      if (!workflow.controlsDisabled && this.ownedLeases.get(workflow.id) === workflow.ownerLeaseId) {
        if (workflow.status !== previousStatus) await this.notifyTransition(workflow, workflow.status);
        await this.store.save(workflow);
      }
      this.emit();
      if (found.authoritative && workflow.status === "active") await this.tickInternal();
      return;
    }
  }

  private activeNodeCount(): number {
    return this.snapshot().filter((workflow) => !this.foreignOwned.has(workflow.id)).flatMap((workflow) => Object.values(workflow.nodes)).filter((node) => ["launching", "running", "pausing", "stopping"].includes(node.status)).length;
  }

  private async refreshAll(): Promise<boolean> {
    let anyChanged = false;
    for (const workflow of this.workflows.values()) {
      let changed = false;
      const previousStatus = workflow.status;
      for (const node of Object.values(workflow.nodes)) {
        const authoritative = currentAttempt(node);
        for (const attempt of node.attempts) {
          if (!attempt.asyncDir || !attempt.packageRunId || !["running", "launching", "pausing", "stopping"].includes(attempt.state)) continue;
          changed = (await refreshAttemptFromDisk(workflow, node, attempt, attempt.id === authoritative?.id)) || changed;
        }
      }
      const externalEvidence = await discoverExternalRuns(workflow);
      if (JSON.stringify(externalEvidence) !== JSON.stringify(workflow.externalEvidence ?? [])) {
        workflow.externalEvidence = externalEvidence;
        changed = true;
      }
      rebuildWorkflowTelemetry(workflow);
      const status = deriveWorkflowStatus(workflow);
      if (status !== workflow.status && (workflow.status === "active" || ["succeeded", "blocked", "failed", "paused", "stopped"].includes(status))) { workflow.status = status; changed = true; }
      if (changed && !workflow.controlsDisabled && this.ownedLeases.get(workflow.id) === workflow.ownerLeaseId) {
        anyChanged = true;
        if (workflow.status !== previousStatus) await this.notifyTransition(workflow, workflow.status);
        await this.store.save(workflow);
      }
    }
    return anyChanged;
  }

  private async heartbeatOwnedWorkflows(): Promise<boolean> {
    let changed = false;
    const now = Date.now();
    for (const workflow of this.workflows.values()) {
      if (!["active", "pausing", "stopping"].includes(workflow.status) || this.ownedLeases.get(workflow.id) !== workflow.ownerLeaseId || now - (workflow.ownerHeartbeatAt ?? 0) < 5000) continue;
      workflow.ownerHeartbeatAt = now;
      await this.store.save(workflow);
      changed = true;
    }
    return changed;
  }

  private async retryPendingNotifications(): Promise<boolean> {
    let changed = false;
    const now = Date.now();
    for (const workflow of this.workflows.values()) {
      if (this.ownedLeases.get(workflow.id) !== workflow.ownerLeaseId) continue;
      const pending = workflow.notifications.filter((record) => !record.deliveredAt && now - record.attemptedAt >= 5000);
      if (!pending.length) continue;
      for (const record of pending) await this.deliverNotification(workflow, record);
      await this.store.save(workflow);
      changed = true;
    }
    return changed;
  }

  private assertLocallyControllable(workflowId: string): void {
    const workflow = this.get(workflowId);
    if (workflow.controlsDisabled) throw new Error(`Workflow '${workflowId}' is observation-only: ${workflow.controlsDisabled}`);
    if (this.foreignOwned.has(workflowId) || this.ownedLeases.get(workflowId) !== workflow.ownerLeaseId || workflow.ownerProcessId !== this.runtime.processId) throw new Error(`Workflow '${workflowId}' is owned by another Pi session. Use explicit confirmed takeover only after its owner is dead.`);
  }

  private async resolveNodeCwd(root: string, requested?: string): Promise<string> {
    const rootReal = await realpath(root);
    const childReal = await realpath(resolve(rootReal, requested ?? "."));
    const rel = relative(rootReal, childReal);
    if (rel.startsWith("..") || resolve(rootReal, rel) !== childReal) throw new Error(`Node cwd escapes workflow execution directory: ${requested ?? "."}`);
    return childReal;
  }

  private async notifyTransition(workflow: WorkflowRun, status: WorkflowRun["status"]): Promise<void> {
    if (!["succeeded", "blocked", "failed", "paused", "stopped"].includes(status)) return;
    const category = status as "succeeded" | "blocked" | "failed" | "paused" | "stopped";
    const key = `${workflow.id}:${workflow.stateRevision}:${category}`;
    if (workflow.notifications.some((record) => record.key === key && record.deliveredAt)) return;
    const failed = Object.values(workflow.nodes).filter((node) => ["failed", "orphaned"].includes(node.status)).map((node) => node.spec.id);
    let message = `Workflow ${workflow.id} ${status}. ${Object.values(workflow.nodes).filter((node) => node.status === "succeeded").length}/${Object.keys(workflow.nodes).length} nodes succeeded; ${workflow.telemetry.totalTokens} child tokens; $${workflow.telemetry.costUsd.toFixed(4)}. State: ${this.store.statePath(workflow.id)}${failed.length ? ` Failed: ${failed.join(", ")}.` : ""}`;
    while (Buffer.byteLength(message, "utf8") > 1024) message = `${message.slice(0, -32)}… [truncated]`;
    const triggerTurn = ["succeeded", "blocked", "failed"].includes(status);
    const record = workflow.notifications.find((candidate) => candidate.key === key) ?? { key, category, attemptedAt: Date.now(), bytes: Buffer.byteLength(message, "utf8"), triggerTurn, message };
    if (!workflow.notifications.includes(record)) workflow.notifications.push(record);
    await this.deliverNotification(workflow, record);
  }

  private async deliverNotification(workflow: WorkflowRun, record: import("./model.ts").NotificationRecord): Promise<void> {
    record.attemptedAt = Date.now();
    try {
      await this.notice(record.message, record.category === "succeeded" ? "info" : "warning", record.triggerTurn);
      record.deliveredAt = Date.now();
      record.error = undefined;
      workflow.telemetry.notificationCount += 1;
      workflow.telemetry.notificationBytes += record.bytes;
      if (record.triggerTurn) workflow.telemetry.parentWakeCount += 1;
    } catch (error) { Object.assign(record, { error: error instanceof Error ? error.message : String(error) }); }
  }

  private scheduleIntervalTick(): void {
    if (this.intervalTickPending || this.disposed) return;
    this.intervalTickPending = true;
    void this.runExclusive(() => this.tickInternal()).finally(() => { this.intervalTickPending = false; });
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  private emit(): void { for (const listener of this.listeners) listener(); }
}
