import { randomUUID } from "node:crypto";
import type { EventBus } from "@earendil-works/pi-coding-agent";

const VERSION = 1;
const REQUEST_EVENT = "subagents:rpc:v1:request";
const READY_EVENT = "subagents:rpc:v1:ready";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";

type RpcMethod = "ping" | "status" | "spawn" | "interrupt" | "stop";

interface RpcReply<T> {
  version: 1;
  requestId: string;
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export interface RpcPing {
  version: number;
  methods: string[];
  capabilities: Record<string, boolean>;
  session: { cwd?: string; sessionId?: string; sessionFile?: string | null };
}

export interface SpawnReply {
  text: string;
  details?: {
    runId?: string;
    asyncId?: string;
    asyncDir?: string;
  };
}

export class SubagentRpcClient {
  private disposed = false;
  private cleanups = new Set<() => void>();

  constructor(private readonly events: EventBus) {}

  createRequestId(): string {
    return `dag-${randomUUID()}`;
  }

  async waitForSession(timeoutMs = 5000): Promise<RpcPing> {
    const first = await this.request<RpcPing>("ping", undefined, this.createRequestId());
    if (first.session.sessionId) return first;

    return new Promise<RpcPing>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: RpcPing) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        this.cleanups.delete(cleanup);
        if (error) reject(error);
        else resolve(value!);
      };
      const onReady = () => {
        void this.request<RpcPing>("ping", undefined, this.createRequestId())
          .then((value) => value.session.sessionId
            ? finish(undefined, value)
            : finish(new Error("pi-subagents RPC is ready without an active session.")))
          .catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
      };
      const unsubscribe = this.events.on(READY_EVENT, onReady);
      const cleanup = () => finish(new Error("Subagent RPC client disposed."));
      this.cleanups.add(cleanup);
      const timer = setTimeout(() => finish(new Error("Timed out waiting for pi-subagents RPC session.")), timeoutMs);
    });
  }

  spawn(params: Record<string, unknown>, requestId: string): Promise<SpawnReply> {
    return this.request("spawn", params, requestId, 30_000);
  }

  status(runId: string): Promise<unknown> {
    return this.request("status", { runId }, this.createRequestId());
  }

  interrupt(runId: string): Promise<unknown> {
    return this.request("interrupt", { runId }, this.createRequestId());
  }

  stop(runId: string): Promise<unknown> {
    return this.request("stop", { runId }, this.createRequestId());
  }

  dispose(): void {
    this.disposed = true;
    for (const cleanup of [...this.cleanups]) cleanup();
    this.cleanups.clear();
  }

  private request<T>(method: RpcMethod, params: unknown, requestId: string, timeoutMs = 15_000): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("Subagent RPC client is disposed."));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        this.cleanups.delete(cleanup);
        if (error) reject(error);
        else resolve(value!);
      };
      const eventName = `${REPLY_PREFIX}${requestId}`;
      const unsubscribe = this.events.on(eventName, (value) => {
        const reply = value as RpcReply<T>;
        if (!reply?.success) {
          finish(new Error(reply?.error?.message ?? `Subagent RPC ${method} failed.`));
          return;
        }
        finish(undefined, reply.data);
      });
      const cleanup = () => finish(new Error("Subagent RPC client disposed."));
      this.cleanups.add(cleanup);
      const timer = setTimeout(() => finish(new Error(`Subagent RPC ${method} timed out.`)), timeoutMs);
      this.events.emit(REQUEST_EVENT, {
        version: VERSION,
        requestId,
        method,
        ...(params === undefined ? {} : { params }),
        source: { extension: "pi-config-dag-workflows" },
      });
    });
  }
}
