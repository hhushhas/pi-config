import { randomUUID } from "node:crypto";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { WorkflowHarness } from "./model.ts";

const VERSION = 2 as const;
const REQUEST_EVENT = "subagents:rpc:v2:request";
const READY_EVENT = "subagents:rpc:v2:ready";
const REPLY_PREFIX = "subagents:rpc:v2:reply:";
const BACKEND_REQUEST_EVENT = "subagents:workflow-backend:v1:request";
const BACKEND_REPLY_PREFIX = "subagents:workflow-backend:v1:reply:";

export type RpcMethod = "ping" | "status" | "lookup" | "spawn" | "interrupt" | "stop" | "steer" | "resume";

interface RpcReply<T> {
  version: 2;
  requestId: string;
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export class SubagentRpcError extends Error {
  constructor(readonly code: string, message: string, readonly method: RpcMethod) {
    super(message);
    this.name = "SubagentRpcError";
  }
}

export interface RpcPing {
  version: 2;
  methods: string[];
  capabilities: Record<string, boolean>;
  session: { cwd?: string; sessionId?: string; sessionFile?: string | null };
}

export interface WorkflowProvenance {
  workflowId: string;
  nodeId: string;
  attemptId: string;
  ownerLeaseEpoch: number;
}

export interface SpawnReply {
  text?: string;
  runId: string;
  asyncDir: string;
  operation?: OperationReply;
  details?: { runId?: string; asyncId?: string; asyncDir?: string };
}

export interface OperationReply {
  operationId: string;
  kind: "spawn" | "resume";
  state: "prepared" | "launched" | "failed";
  runId: string;
  asyncDir: string;
  pid?: number;
  error?: string;
}

export interface ControlReply {
  controlRequestId: string;
  accepted: boolean;
  runId: string;
  asyncDir: string;
  previousState: string;
  requestedState: string;
  replacementRunId?: string;
  replacementAsyncDir?: string;
  message: string;
}

export interface RuntimeStatus {
  runId: string;
  asyncDir: string;
  state: string;
  pid?: number;
  cwd?: string;
  startedAt?: number;
  endedAt?: number;
  lastUpdate?: number;
  activityState?: "active_long_running" | "needs_attention";
  currentTool?: string;
  turnCount?: number;
  toolCount?: number;
  totalTokens?: { input: number; output: number; total: number };
  totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
  sessionFile?: string;
  sessionIdentity?: {
    orchestratorSessionId: string;
    orchestratorSessionFile?: string;
    workflowId?: string;
    nodeId?: string;
    attemptId?: string;
    workflowCapabilityHash?: string;
    ownerLeaseEpoch?: number;
  };
  runtimeLaunch?: { operationId: string; runId: string; kind: "spawn" | "resume"; provenance: WorkflowProvenance; effectiveExecution: { harness?: WorkflowHarness; agent: string; cwd: string; model?: string; thinking?: string; timeoutMs?: number; notificationMode: "default" | "event-only" }; sourceRunId?: string; sourceSessionFile?: string; sourceAttemptId?: string; sourceProvenance?: WorkflowProvenance };
  terminal?: { reason: "completed" | "failed" | "paused" | "stopped" | "timed_out" | "process_lost"; at: number; controlRequestId?: string };
  error?: string;
}

export class SubagentRpcClient {
  private disposed = false;
  private cleanups = new Set<() => void>();

  constructor(private readonly events: EventBus) {}
  createRequestId(): string { return `dag-${randomUUID()}`; }

  async waitForSession(timeoutMs = 5000): Promise<RpcPing> {
    const first = await this.request<RpcPing>("ping", undefined, this.createRequestId());
    this.validateContract(first);
    if (first.session.sessionId) return first;
    return new Promise<RpcPing>((resolve, reject) => {
      let settled = false;
      let unsubscribe: (() => void) | void;
      const finish = (error?: Error, value?: RpcPing) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        this.cleanups.delete(cleanup);
        if (error) reject(error); else resolve(value!);
      };
      unsubscribe = this.events.on(READY_EVENT, () => {
        void this.request<RpcPing>("ping", undefined, this.createRequestId()).then((value) => {
          this.validateContract(value);
          return value.session.sessionId ? finish(undefined, value) : finish(new Error("pi-subagents RPC is ready without an active session."));
        }).catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
      });
      const cleanup = () => finish(new Error("Subagent RPC client disposed."));
      this.cleanups.add(cleanup);
      const timer = setTimeout(() => finish(new Error("Timed out waiting for pi-subagents RPC session.")), timeoutMs);
    });
  }

  spawn(params: Record<string, unknown>, requestId: string): Promise<SpawnReply> { return this.requestForHarness("spawn", params, requestId, 30_000); }
  resume(params: Record<string, unknown>, requestId: string): Promise<SpawnReply> { return this.requestForHarness("resume", params, requestId, 30_000); }
  lookup(params: { operationId: string; workflowCapability: string; provenance: WorkflowProvenance; harness?: WorkflowHarness }): Promise<OperationReply> { return this.requestForHarness("lookup", params, this.createRequestId()); }
  status(runId: string, authority?: { workflowCapability: string; provenance: WorkflowProvenance; harness?: WorkflowHarness }): Promise<RuntimeStatus> {
    return authority?.harness && authority.harness !== "pi"
      ? this.requestForHarness("status", { runId, ...authority }, this.createRequestId())
      : this.request("status", { runId }, this.createRequestId());
  }
  interrupt(runId: string, authority?: { controlRequestId: string; workflowCapability: string; provenance: WorkflowProvenance; harness?: WorkflowHarness }): Promise<ControlReply> {
    if (!authority) return Promise.reject(new Error("Workflow pause requires capability authority."));
    return this.requestForHarness("interrupt", { runId, ...authority }, this.createRequestId());
  }
  pause(runId: string, authority: { controlRequestId: string; workflowCapability: string; provenance: WorkflowProvenance; harness?: WorkflowHarness }): Promise<ControlReply> { return this.interrupt(runId, authority); }
  stop(runId: string, authority?: { controlRequestId: string; workflowCapability: string; provenance: WorkflowProvenance; harness?: WorkflowHarness }): Promise<ControlReply> {
    if (!authority) return Promise.reject(new Error("Workflow stop requires capability authority."));
    return this.requestForHarness("stop", { runId, ...authority }, this.createRequestId());
  }
  steer(runId: string, message: string, authority: { controlRequestId: string; workflowCapability: string; provenance: WorkflowProvenance; harness?: WorkflowHarness }): Promise<ControlReply> { return this.requestForHarness("steer", { runId, message, ...authority }, this.createRequestId()); }

  dispose(): void {
    this.disposed = true;
    for (const cleanup of [...this.cleanups]) cleanup();
    this.cleanups.clear();
  }

  private validateContract(ping: RpcPing): void {
    const requiredMethods = ["lookup", "spawn", "interrupt", "stop", "steer", "resume"];
    const missing = requiredMethods.filter((method) => !ping.methods.includes(method));
    if (ping.version !== VERSION || missing.length > 0 || !ping.capabilities.idempotentSpawn || !ping.capabilities.idempotentResume
      || !ping.capabilities.causalControls || !ping.capabilities.eventOnlyNotifications || !ping.capabilities.steerAcknowledgement) {
      throw new Error(`pi-subagents workflow protocol is incompatible${missing.length ? `; missing methods: ${missing.join(", ")}` : ""}.`);
    }
  }

  private requestForHarness<T>(method: RpcMethod, params: unknown, requestId: string, timeoutMs = 15_000): Promise<T> {
    const harness = (params as { harness?: WorkflowHarness } | undefined)?.harness;
    return this.request(method, params, requestId, timeoutMs, harness && harness !== "pi" ? { request: BACKEND_REQUEST_EVENT, reply: BACKEND_REPLY_PREFIX } : undefined);
  }

  private request<T>(method: RpcMethod, params: unknown, requestId: string, timeoutMs = 15_000, channel?: { request: string; reply: string }): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("Subagent RPC client is disposed."));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let unsubscribe: (() => void) | void;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        this.cleanups.delete(cleanup);
        if (error) reject(error); else resolve(value!);
      };
      unsubscribe = this.events.on(`${channel?.reply ?? REPLY_PREFIX}${requestId}`, (value) => {
        const reply = value as RpcReply<T>;
        if (reply?.version !== VERSION) return finish(new SubagentRpcError("unsupported_version", `Subagent RPC ${method} returned protocol ${String(reply?.version)}.`, method));
        if (!reply.success) return finish(new SubagentRpcError(reply.error?.code ?? "execution_failed", reply.error?.message ?? `Subagent RPC ${method} failed.`, method));
        finish(undefined, reply.data);
      });
      const cleanup = () => finish(new Error("Subagent RPC client disposed."));
      this.cleanups.add(cleanup);
      const timer = setTimeout(() => finish(new SubagentRpcError("timeout", `Subagent RPC ${method} timed out.`, method)), timeoutMs);
      this.events.emit(channel?.request ?? REQUEST_EVENT, { version: VERSION, requestId, method, ...(params !== undefined ? { params } : {}), source: { extension: "dag-workflows" } });
    });
  }
}
