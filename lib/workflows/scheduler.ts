import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SpawnReply } from "./rpc-client.ts";
import type { WorkflowStore } from "./store.ts";
import {
  WORKFLOW_SCHEMA_VERSION,
  currentAttempt,
  deriveWorkflowStatus,
  descendantsOf,
  readyNodeIds,
  validateDefinition,
  type NodeAttempt,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowRun,
} from "./model.ts";
import { normalizedModel, refreshAttemptFromDisk, resultState } from "./runtime.ts";

type Listener = () => void;
type Notice = (message: string, level: "info" | "warning" | "error") => void;
type RuntimeIdentity = { processId: number; isProcessAlive(processId: number): boolean };

const DEFAULT_RUNTIME: RuntimeIdentity = {
  processId: process.pid,
  isProcessAlive(processId) {
    try {
      process.kill(processId, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
};

export interface WorkflowRpc {
  createRequestId(): string;
  spawn(params: Record<string, unknown>, requestId: string): Promise<SpawnReply>;
  status(runId: string): Promise<unknown>;
  interrupt(runId: string): Promise<unknown>;
  stop(runId: string): Promise<unknown>;
}

export class WorkflowScheduler {
  private workflows = new Map<string, WorkflowRun>();
  private listeners = new Set<Listener>();
  private polling?: NodeJS.Timeout;
  private ticking = false;
  private disposed = false;
  private reconciled = new Set<string>();
  private foreignOwned = new Set<string>();

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
      const ownedHere = workflow.ownerProcessId === this.runtime.processId && workflow.ownerSessionId === this.sessionId;
      const ownedByLiveProcess = workflow.ownerProcessId !== undefined
        && workflow.ownerProcessId !== this.runtime.processId
        && this.runtime.isProcessAlive(workflow.ownerProcessId);
      if (workflow.status === "active" && ownedByLiveProcess) {
        this.foreignOwned.add(workflow.id);
      } else if (workflow.status === "active" && !ownedHere) {
        workflow.status = "awaiting_resume";
        await this.store.save(workflow);
      }
      this.workflows.set(workflow.id, workflow);
    }
    await this.refreshAll();
    for (const workflow of this.workflows.values()) {
      if (workflow.status === "awaiting_resume" && Object.values(workflow.nodes).every((node) => node.status === "succeeded")) {
        workflow.status = "succeeded";
        await this.store.save(workflow);
      }
    }
    this.polling = setInterval(() => void this.tick(), 1000);
  }

  snapshot(): WorkflowRun[] {
    return [...this.workflows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resumableWorkflows(): WorkflowRun[] {
    return this.snapshot().filter((workflow) => workflow.status === "awaiting_resume");
  }

  async create(definition: WorkflowDefinition): Promise<WorkflowRun> {
    const specs = validateDefinition(definition);
    const now = Date.now();
    const id = `wf-${now.toString(36)}-${randomUUID().slice(0, 8)}`;
    const workflow: WorkflowRun = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id,
      name: definition.name.trim(),
      cwd: this.store.cwd,
      ownerSessionId: this.sessionId,
      ownerProcessId: this.runtime.processId,
      ownerHeartbeatAt: now,
      ...(this.sessionFile ? { ownerSessionFile: this.sessionFile } : {}),
      status: "active",
      maxConcurrency: definition.maxConcurrency ?? 4,
      createdAt: now,
      updatedAt: now,
      nodes: Object.fromEntries(specs.map((spec) => [spec.id, { spec, status: "queued", attempts: [] }])),
    };
    this.workflows.set(id, workflow);
    await this.store.save(workflow);
    this.emit();
    await this.tick();
    return workflow;
  }

  get(workflowId: string): WorkflowRun {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) throw new Error(`Workflow '${workflowId}' was not found.`);
    return workflow;
  }

  async resume(workflowId: string): Promise<void> {
    const workflow = this.get(workflowId);
    if (!["awaiting_resume", "paused", "blocked"].includes(workflow.status)) return;
    if (Object.values(workflow.nodes).some((node) => node.status === "pausing")) {
      throw new Error(`Workflow '${workflowId}' is still pausing; resume it after interruption is confirmed.`);
    }
    for (const node of Object.values(workflow.nodes)) {
      if (node.status === "paused") node.status = "queued";
    }
    workflow.ownerSessionId = this.sessionId;
    workflow.ownerProcessId = this.runtime.processId;
    workflow.ownerHeartbeatAt = Date.now();
    workflow.status = "active";
    await this.store.save(workflow);
    this.emit();
    await this.tick();
  }

  async pause(workflowId: string): Promise<void> {
    this.assertLocallyControllable(workflowId);
    const workflow = this.get(workflowId);
    const foreign = Object.values(workflow.nodes).find((node) => {
      const attempt = currentAttempt(node);
      return ["running", "pausing", "stopping"].includes(node.status) && attempt?.packageRunId && attempt.ownerSessionId !== this.sessionId;
    });
    if (foreign) {
      throw new Error(`Cannot pause workflow '${workflowId}': node '${foreign.spec.id}' belongs to a previous Pi session and is still running.`);
    }
    workflow.status = "paused";
    for (const node of Object.values(workflow.nodes)) {
      if (node.status === "launching") {
        node.status = "pausing";
        const attempt = currentAttempt(node);
        if (attempt) {
          attempt.pauseRequested = true;
          attempt.state = "pausing";
        }
      }
    }
    const running = Object.values(workflow.nodes).filter((node) => node.status === "running");
    for (const node of running) {
      const attempt = currentAttempt(node);
      if (attempt) {
        attempt.pauseRequested = true;
        attempt.state = "pausing";
      }
      node.status = "pausing";
    }
    await this.store.save(workflow);
    try {
      await Promise.all(running.map(async (node) => {
        const runId = currentAttempt(node)?.packageRunId;
        if (!runId) return;
        await this.rpc.interrupt(runId);
      }));
    } catch (error) {
      workflow.status = "blocked";
      await this.store.save(workflow);
      throw error;
    }
    this.emit();
  }

  async stopWorkflow(workflowId: string): Promise<void> {
    this.assertLocallyControllable(workflowId);
    const workflow = this.get(workflowId);
    const foreign = Object.values(workflow.nodes).find((node) => {
      const attempt = currentAttempt(node);
      return ["running", "pausing", "stopping"].includes(node.status) && attempt?.packageRunId && attempt.ownerSessionId !== this.sessionId;
    });
    if (foreign) {
      throw new Error(`Cannot stop workflow '${workflowId}': node '${foreign.spec.id}' belongs to a previous Pi session and is still running.`);
    }
    workflow.status = "stopped";
    await this.store.save(workflow);
    try {
      await Promise.all(Object.values(workflow.nodes).map((node) => this.stopNode(workflow.id, node.spec.id, false)));
    } catch (error) {
      workflow.status = "blocked";
      await this.store.save(workflow);
      throw error;
    }
    await this.store.save(workflow);
    this.emit();
  }

  async stopNode(workflowId: string, nodeId: string, persist = true): Promise<void> {
    this.assertLocallyControllable(workflowId);
    const workflow = this.get(workflowId);
    const node = workflow.nodes[nodeId];
    if (!node) throw new Error(`Node '${nodeId}' was not found.`);
    const attempt = currentAttempt(node);
    if (["running", "pausing", "stopping"].includes(node.status) && attempt?.packageRunId) {
      if (attempt.ownerSessionId !== this.sessionId) {
        throw new Error(`Cannot stop node '${nodeId}': it belongs to a previous Pi session and is still running.`);
      }
      attempt.stopRequested = true;
      attempt.pauseRequested = false;
      attempt.state = "stopping";
      node.status = "stopping";
      await this.store.save(workflow);
      await this.rpc.stop(attempt.packageRunId);
    }
    if (!["succeeded", "stopping"].includes(node.status)) node.status = "stopped";
    if (persist) await this.store.save(workflow);
    this.emit();
  }

  async retryNode(workflowId: string, nodeId: string): Promise<void> {
    this.assertLocallyControllable(workflowId);
    const workflow = this.get(workflowId);
    const node = workflow.nodes[nodeId];
    if (!node) throw new Error(`Node '${nodeId}' was not found.`);
    if (["running", "launching", "pausing", "stopping", "succeeded"].includes(node.status)) {
      throw new Error(`Node '${nodeId}' cannot be retried while ${node.status}.`);
    }
    node.status = "queued";
    for (const descendant of descendantsOf(workflow, nodeId)) {
      const child = workflow.nodes[descendant];
      if (!["running", "launching", "pausing", "stopping", "succeeded"].includes(child.status)) child.status = "queued";
    }
    workflow.status = "active";
    workflow.ownerSessionId = this.sessionId;
    workflow.ownerProcessId = this.runtime.processId;
    workflow.ownerHeartbeatAt = Date.now();
    await this.store.save(workflow);
    this.emit();
    await this.tick();
  }

  handleCompletion(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const result = value as Record<string, unknown>;
    const runId = String(result.runId ?? result.id ?? "");
    if (!runId) return;
    for (const workflow of this.workflows.values()) {
      for (const node of Object.values(workflow.nodes)) {
        const attempt = currentAttempt(node);
        if (attempt?.packageRunId !== runId || attempt.completionSeen) continue;
        attempt.resultSnapshot = result;
        attempt.completionSeen = true;
        attempt.endedAt = Number(result.timestamp) || Date.now();
        const terminalState = resultState(result);
        attempt.state = attempt.stopRequested ? "stopped" : attempt.pauseRequested ? "paused" : terminalState;
        node.status = workflow.status === "stopped" || node.status === "stopped" || attempt.stopRequested
          ? "stopped"
          : attempt.pauseRequested ? "paused" : terminalState;
        workflow.status = deriveWorkflowStatus(workflow);
        this.store.saveSync(workflow);
        this.emit();
        if (workflow.status === "active") void this.tick();
        else if (workflow.status === "succeeded") this.notice(`Workflow '${workflow.name}' completed.`, "info");
        else if (workflow.status === "blocked") this.notice(`Workflow '${workflow.name}' needs attention.`, "warning");
        return;
      }
    }
  }

  async tick(): Promise<void> {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    try {
      let changed = await this.reconcileForeignOwners();
      changed = (await this.refreshAll()) || changed;
      changed = (await this.heartbeatOwnedWorkflows()) || changed;
      let capacity = this.globalConcurrency - this.activeNodeCount();
      if (capacity <= 0) {
        if (changed) this.emit();
        return;
      }
      for (const workflow of this.snapshot()) {
        if (workflow.status !== "active" || this.foreignOwned.has(workflow.id)) continue;
        const localActive = Object.values(workflow.nodes).filter((node) => ["launching", "running", "pausing", "stopping"].includes(node.status)).length;
        let localCapacity = workflow.maxConcurrency - localActive;
        for (const nodeId of readyNodeIds(workflow)) {
          if (capacity <= 0 || localCapacity <= 0) break;
          await this.launchNode(workflow, workflow.nodes[nodeId]);
          capacity -= 1;
          localCapacity -= 1;
        }
        const nextStatus = deriveWorkflowStatus(workflow);
        if (nextStatus !== workflow.status) {
          workflow.status = nextStatus;
          await this.store.save(workflow);
          changed = true;
          if (nextStatus === "succeeded") this.notice(`Workflow '${workflow.name}' completed.`, "info");
          if (nextStatus === "blocked") this.notice(`Workflow '${workflow.name}' needs attention.`, "warning");
        }
      }
      if (changed) this.emit();
    } finally {
      this.ticking = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.polling) clearInterval(this.polling);
    this.listeners.clear();
  }

  private async launchNode(workflow: WorkflowRun, node: WorkflowNode): Promise<void> {
    const attemptNumber = node.attempts.length + 1;
    const attemptDir = await this.store.prepareAttempt(workflow.id, node.spec.id, attemptNumber);
    if (workflow.status !== "active" || node.status !== "queued") return;
    const requestId = this.rpc.createRequestId();
    const attempt: NodeAttempt = {
      id: `attempt-${attemptNumber}`,
      rpcRequestId: requestId,
      ownerSessionId: this.sessionId,
      requestedAt: Date.now(),
      state: "launching",
      sessionRoot: join(attemptDir, "sessions"),
    };
    node.attempts.push(attempt);
    node.status = "launching";
    await this.store.save(workflow);
    this.emit();

    try {
      const reply = await this.rpc.spawn({
        agent: node.spec.agent,
        task: node.spec.task,
        cwd: workflow.cwd,
        context: "fresh",
        async: true,
        clarify: false,
        artifacts: true,
        sessionDir: attempt.sessionRoot,
        ...(node.spec.timeoutMs ? { timeoutMs: node.spec.timeoutMs } : {}),
        ...(normalizedModel(node.spec.model, node.spec.thinking, this.fallbackModel)
          ? { model: normalizedModel(node.spec.model, node.spec.thinking, this.fallbackModel) }
          : {}),
      }, requestId) as SpawnReply;
      const runId = reply.details?.runId ?? reply.details?.asyncId;
      if (!runId || !reply.details?.asyncDir) throw new Error("Subagent spawn reply did not include a run ID and directory.");
      attempt.packageRunId = runId;
      attempt.asyncDir = reply.details.asyncDir;
      attempt.startedAt = Date.now();
      const controlledWorkflowStatus: string = workflow.status;
      const controlledNodeStatus: string = node.status;
      if (controlledWorkflowStatus === "stopped" || controlledNodeStatus === "stopped") {
        attempt.stopRequested = true;
        attempt.state = "stopping";
        node.status = "stopping";
        await this.rpc.stop(runId);
      } else if (controlledWorkflowStatus === "paused" || controlledNodeStatus === "paused" || controlledNodeStatus === "pausing") {
        attempt.pauseRequested = true;
        attempt.state = "pausing";
        node.status = "pausing";
        await this.rpc.interrupt(runId);
      } else {
        attempt.state = "running";
        node.status = "running";
      }
    } catch (error) {
      const childMayBeRunning = Boolean(attempt.packageRunId);
      const completionSeen = attempt.completionSeen === true;
      if (childMayBeRunning && !completionSeen) {
        attempt.pauseRequested = false;
        attempt.stopRequested = false;
      }
      attempt.state = completionSeen ? attempt.state : childMayBeRunning ? "running" : "orphaned";
      attempt.error = error instanceof Error ? error.message : String(error);
      if (!childMayBeRunning) attempt.endedAt = Date.now();
      if (!completionSeen) node.status = childMayBeRunning ? "running" : "orphaned";
      if (childMayBeRunning) {
        workflow.status = "blocked";
        this.notice(`Control failed for node '${node.spec.id}'; the child may still be running.`, "error");
      }
    }
    await this.store.save(workflow);
    this.emit();
  }

  private activeNodeCount(): number {
    return this.snapshot().filter((workflow) => !this.foreignOwned.has(workflow.id))
      .flatMap((workflow) => Object.values(workflow.nodes))
      .filter((node) => ["launching", "running", "pausing", "stopping"].includes(node.status)).length;
  }

  private async refreshAll(): Promise<boolean> {
    let anyChanged = false;
    for (const workflow of this.workflows.values()) {
      if (this.foreignOwned.has(workflow.id)) continue;
      let changed = false;
      for (const node of Object.values(workflow.nodes)) {
        const attempt = currentAttempt(node);
        if (!attempt?.asyncDir || !attempt.packageRunId || !["running", "launching", "pausing", "stopping"].includes(node.status)) continue;
        if (!this.reconciled.has(attempt.packageRunId)) {
          await this.rpc.status(attempt.packageRunId).catch(() => undefined);
          this.reconciled.add(attempt.packageRunId);
        }
        changed = (await refreshAttemptFromDisk(node, attempt)) || changed;
      }
      const status = deriveWorkflowStatus(workflow);
      if (status !== workflow.status && (workflow.status === "active" || status === "succeeded")) {
        workflow.status = status;
        changed = true;
      }
      if (changed) {
        anyChanged = true;
        await this.store.save(workflow);
      }
    }
    return anyChanged;
  }

  private async reconcileForeignOwners(): Promise<boolean> {
    let changed = false;
    for (const workflowId of [...this.foreignOwned]) {
      const persisted = await this.store.load(workflowId);
      if (persisted && persisted.status !== "active") {
        this.workflows.set(workflowId, persisted);
        this.foreignOwned.delete(workflowId);
        changed = true;
        continue;
      }
      const ownerProcessId = persisted?.ownerProcessId ?? this.workflows.get(workflowId)?.ownerProcessId;
      if (ownerProcessId !== undefined && this.runtime.isProcessAlive(ownerProcessId)) continue;
      const workflow = persisted ?? this.workflows.get(workflowId);
      if (!workflow) continue;
      workflow.status = "awaiting_resume";
      this.workflows.set(workflowId, workflow);
      this.foreignOwned.delete(workflowId);
      await this.store.save(workflow);
      changed = true;
    }
    return changed;
  }

  private async heartbeatOwnedWorkflows(): Promise<boolean> {
    let changed = false;
    const now = Date.now();
    for (const workflow of this.workflows.values()) {
      if (workflow.status !== "active" || this.foreignOwned.has(workflow.id)) continue;
      if (workflow.ownerProcessId !== this.runtime.processId || now - (workflow.ownerHeartbeatAt ?? 0) < 5000) continue;
      workflow.ownerHeartbeatAt = now;
      await this.store.save(workflow);
      changed = true;
    }
    return changed;
  }

  private assertLocallyControllable(workflowId: string): void {
    if (this.foreignOwned.has(workflowId)) {
      throw new Error(`Workflow '${workflowId}' is owned by another live Pi session.`);
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
