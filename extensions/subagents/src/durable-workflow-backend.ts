import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import type { BackendName } from "./domain.ts";

const REQUEST = "subagents:workflow-backend:v1:request";
const REPLY = "subagents:workflow-backend:v1:reply:";
const EXTERNAL = new Set<BackendName>(["claude", "codex", "grok"]);

type Provenance = { workflowId: string; nodeId: string; attemptId: string; ownerLeaseEpoch: number };
type Request = { version?: number; requestId?: string; method?: string; params?: unknown };
type Operation = { operationId: string; kind: "spawn" | "resume"; state: "prepared" | "launched" | "failed"; runId: string; asyncDir: string; pid?: number; error?: string; requestHash: string; capabilityHash: string; provenance: Provenance; harness: BackendName };
type Identity = { prov: Provenance; hash: string; harness: BackendName };
type RuntimeStatus = { runId?: string; asyncDir?: string; state?: string; sessionIdentity?: { workflowCapabilityHash?: string; workflowId?: string; nodeId?: string; attemptId?: string; ownerLeaseEpoch?: number }; [key: string]: unknown };

function atomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  chmodSync(file, 0o600);
  if (process.platform !== "win32") {
    const directory = openSync(dirname(file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RPC params must be an object.");
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value;
}
function provenance(value: unknown): Provenance {
  const input = record(value);
  const ownerLeaseEpoch = Number(input.ownerLeaseEpoch);
  if (!Number.isInteger(ownerLeaseEpoch) || ownerLeaseEpoch < 1) throw new Error("provenance.ownerLeaseEpoch must be a positive integer.");
  return { workflowId: requiredString(input.workflowId, "provenance.workflowId"), nodeId: requiredString(input.nodeId, "provenance.nodeId"), attemptId: requiredString(input.attemptId, "provenance.attemptId"), ownerLeaseEpoch };
}
function capabilityHash(prov: Provenance, secret: string): string {
  return createHash("sha256").update("pi-workflow-capability-v1\0").update(prov.workflowId).update("\0").update(secret).digest("hex");
}
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

/** Durable external-harness RPC adapter. Detached runners outlive this bridge. */
export class DurableWorkflowBackendBridge {
  private unsubscribe?: () => void;
  private bound = false;
  constructor(private readonly events: EventBus, private readonly root: string, private readonly runnerFile: string) {}

  start(): void {
    if (this.bound) return;
    this.bound = true;
    this.unsubscribe = this.events.on(REQUEST, (value) => { void this.handle(value as Request); }) ?? undefined;
  }
  dispose(): void { this.unsubscribe?.(); this.unsubscribe = undefined; this.bound = false; }

  private runDirectory(runId: string): string {
    if (!/^harness-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) throw new Error(`Invalid durable backend run id '${runId}'.`);
    return join(this.root, "runs", runId);
  }
  private operationFile(hash: string, operationId: string): string {
    return join(this.root, "operations", `${digest({ hash, operationId })}.json`);
  }
  private readOperation(hash: string, operationId: string): Operation | undefined {
    const file = this.operationFile(hash, operationId);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Operation : undefined;
  }
  private async locked<T>(scope: unknown, operation: () => Promise<T> | T): Promise<T> {
    const anchor = join(this.root, "locks", `${digest(scope)}.anchor`);
    mkdirSync(dirname(anchor), { recursive: true, mode: 0o700 });
    closeSync(openSync(anchor, "a", 0o600));
    chmodSync(anchor, 0o600);
    const release = await lockfile.lock(anchor, { realpath: false, stale: 15_000, update: 5_000, retries: { retries: 1200, factor: 1, minTimeout: 25, maxTimeout: 25, randomize: false } });
    try { return await operation(); } finally { await release(); }
  }

  private async handle(request: Request): Promise<void> {
    if (request.version !== 2 || typeof request.requestId !== "string") return;
    try {
      const params = record(request.params);
      const method = requiredString(request.method, "method");
      const data = method === "spawn" || method === "resume" ? await this.launch(params, method)
        : method === "lookup" ? this.lookup(params)
        : method === "status" ? this.status(params)
        : await this.control(params, method);
      this.events.emit(`${REPLY}${request.requestId}`, { version: 2, requestId: request.requestId, success: true, data });
    } catch (error) {
      this.events.emit(`${REPLY}${request.requestId}`, { version: 2, requestId: request.requestId, success: false, error: { code: "execution_failed", message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private identity(params: Record<string, unknown>): Identity {
    const prov = provenance(params.provenance);
    const secret = requiredString(params.workflowCapability, "workflowCapability");
    const harness = requiredString(params.harness, "harness") as BackendName;
    if (!EXTERNAL.has(harness)) throw new Error(`Harness '${harness}' is not an external durable backend.`);
    return { prov, hash: capabilityHash(prov, secret), harness };
  }
  private authenticatedStatus(params: Record<string, unknown>, identity: Identity): { asyncDir: string; status: RuntimeStatus } {
    const runId = requiredString(params.runId, "runId");
    const asyncDir = this.runDirectory(runId);
    const statusFile = join(asyncDir, "status.json");
    if (!existsSync(statusFile)) throw new Error(`Run '${runId}' was not found.`);
    const status = JSON.parse(readFileSync(statusFile, "utf8")) as RuntimeStatus;
    const actual = status.sessionIdentity;
    if (status.runId !== runId || !actual || !safeEqual(actual.workflowCapabilityHash ?? "", identity.hash) || actual.workflowId !== identity.prov.workflowId || actual.nodeId !== identity.prov.nodeId || actual.attemptId !== identity.prov.attemptId || actual.ownerLeaseEpoch !== identity.prov.ownerLeaseEpoch) throw new Error("Runtime authority does not match the durable attempt.");
    return { asyncDir, status };
  }

  private async launch(params: Record<string, unknown>, kind: "spawn" | "resume") {
    const identity = this.identity(params);
    const operationId = requiredString(params.operationId, "operationId");
    return this.locked({ type: "operation", hash: identity.hash, operationId }, () => this.launchReserved(params, kind, identity, operationId));
  }

  private async launchReserved(params: Record<string, unknown>, kind: "spawn" | "resume", identity: Identity, operationId: string) {
    const { prov, hash, harness } = identity;
    const requestHash = digest({ kind, harness, operationId, provenance: prov, task: params.task, cwd: params.cwd, model: params.model, thinking: params.thinking, sourceRunId: params.sourceRunId, sourceProvenance: kind === "resume" ? provenance(params.sourceProvenance) : undefined });
    const existing = this.readOperation(hash, operationId);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new Error(`Operation '${operationId}' was replayed with different parameters.`);
      return { runId: existing.runId, asyncDir: existing.asyncDir, operation: existing };
    }
    let resumeSourceDir: string | undefined;
    if (kind === "resume") resumeSourceDir = await this.reserveResumeSource(params, identity, operationId, requestHash);

    const runId = `harness-${randomUUID()}`;
    const asyncDir = this.runDirectory(runId);
    mkdirSync(asyncDir, { recursive: true, mode: 0o700 });
    const operation: Operation = { operationId, kind, state: "prepared", runId, asyncDir, requestHash, capabilityHash: hash, provenance: prov, harness };
    atomicJson(this.operationFile(hash, operationId), operation);
    const effectiveExecution = { harness, agent: requiredString(params.agent, "agent"), cwd: requiredString(params.cwd, "cwd"), ...(params.model ? { model: params.model } : {}), ...(params.thinking ? { thinking: params.thinking } : {}), ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}), notificationMode: "event-only" };
    const runtimeLaunch = { operationId, runId, kind, provenance: prov, effectiveExecution, ...(kind === "resume" ? { sourceRunId: params.sourceRunId, sourceSessionFile: params.sourceSessionFile, sourceAttemptId: params.sourceAttemptId, sourceProvenance: params.sourceProvenance } : {}) };
    const config = { runId, asyncDir, harness, prompt: requiredString(params.task, "task"), title: `${prov.workflowId}/${prov.nodeId}`, cwd: effectiveExecution.cwd, model: params.model, reasoningEffort: params.thinking, timeoutMs: params.timeoutMs, capabilityHash: hash, runtimeLaunch };
    atomicJson(join(asyncDir, "runner-config.json"), config);
    if (kind === "resume") {
      await this.persistControl(resumeSourceDir!, identity, { action: "resume", controlRequestId: operationId, config });
    } else {
      const child = spawn(process.execPath, ["--experimental-strip-types", this.runnerFile, join(asyncDir, "runner-config.json")], { cwd: effectiveExecution.cwd, detached: true, stdio: "ignore", env: process.env });
      child.unref();
      operation.pid = child.pid;
    }
    const statusFile = join(asyncDir, "status.json");
    const deadline = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (existsSync(statusFile)) {
        try { ready = ["running", "stopping"].includes(String((JSON.parse(readFileSync(statusFile, "utf8")) as { state?: string }).state)); } catch { /* atomic publication in progress */ }
        if (ready) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!ready) {
      operation.state = "failed"; operation.error = "Durable backend runner did not publish its authoritative artifact.";
      atomicJson(this.operationFile(hash, operationId), operation);
      throw new Error(operation.error);
    }
    const status = JSON.parse(readFileSync(statusFile, "utf8")) as { pid?: number };
    operation.state = "launched"; operation.pid = status.pid ?? operation.pid;
    atomicJson(this.operationFile(hash, operationId), operation);
    return { runId, asyncDir, operation };
  }

  private async reserveResumeSource(params: Record<string, unknown>, identity: Identity, operationId: string, requestHash: string): Promise<string> {
    const sourceRunId = requiredString(params.sourceRunId, "sourceRunId");
    const sourceDir = this.runDirectory(sourceRunId);
    return this.locked({ type: "resume-source", hash: identity.hash, sourceRunId }, () => {
      const sourceStatusFile = join(sourceDir, "status.json");
      if (!existsSync(sourceStatusFile)) throw new Error(`Paused source '${sourceRunId}' was not found.`);
      const sourceStatus = JSON.parse(readFileSync(sourceStatusFile, "utf8")) as RuntimeStatus & { terminal?: { reason?: string } };
      const source = provenance(params.sourceProvenance);
      const actual = sourceStatus.sessionIdentity;
      if (sourceStatus.terminal?.reason !== "paused" || !actual || !safeEqual(actual.workflowCapabilityHash ?? "", identity.hash)
        || actual.workflowId !== source.workflowId || actual.nodeId !== source.nodeId || actual.attemptId !== source.attemptId || actual.ownerLeaseEpoch !== source.ownerLeaseEpoch) {
        throw new Error(`Paused source '${sourceRunId}' does not match the authenticated resume lineage.`);
      }
      const claimFile = join(sourceDir, "resume-claim.json");
      const claim = { operationId, requestHash, sourceRunId };
      if (existsSync(claimFile)) {
        const existing = JSON.parse(readFileSync(claimFile, "utf8"));
        if (digest(existing) !== digest(claim)) throw new Error(`Paused source '${sourceRunId}' is already claimed by another resume operation.`);
      } else atomicJson(claimFile, claim);
      return sourceDir;
    });
  }

  private lookup(params: Record<string, unknown>) {
    const { hash } = this.identity(params);
    const operationId = requiredString(params.operationId, "operationId");
    const operation = this.readOperation(hash, operationId);
    if (!operation) throw new Error(`Operation '${operationId}' was not found.`);
    return operation;
  }
  private status(params: Record<string, unknown>) {
    const identity = this.identity(params);
    return this.authenticatedStatus(params, identity).status;
  }

  private async persistControl(asyncDir: string, identity: Identity, payload: Record<string, unknown>): Promise<void> {
    const controlRequestId = requiredString(payload.controlRequestId, "controlRequestId");
    const file = join(asyncDir, "controls", `${digest({ hash: identity.hash, provenance: identity.prov, controlRequestId })}.json`);
    await this.locked({ type: "control", file }, () => {
      if (existsSync(file)) {
        const existing = JSON.parse(readFileSync(file, "utf8"));
        if (digest(existing) !== digest(payload)) throw new Error(`Control '${controlRequestId}' was replayed with different parameters.`);
        return;
      }
      atomicJson(file, payload);
    });
  }

  private async control(params: Record<string, unknown>, method: string) {
    if (!["interrupt", "stop", "steer"].includes(method)) throw new Error(`Unsupported durable backend method '${method}'.`);
    const identity = this.identity(params);
    const { asyncDir, status } = this.authenticatedStatus(params, identity);
    const controlRequestId = requiredString(params.controlRequestId, "controlRequestId");
    const action = method === "interrupt" ? "pause" : method;
    const payload = { action, controlRequestId, ...(method === "steer" ? { message: requiredString(params.message, "message") } : {}) };
    await this.persistControl(asyncDir, identity, payload);
    return { controlRequestId, accepted: true, runId: requiredString(params.runId, "runId"), asyncDir, previousState: status.state ?? "unknown", requestedState: action === "pause" ? "pausing" : action === "stop" ? "stopping" : "running", message: "Durable control was persisted; terminal state remains pending until the runner confirms this exact request." };
  }
}
