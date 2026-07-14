import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { emptyTelemetry, type LegacyAttemptV2, type WorkflowNode, type WorkflowRun } from "./model.ts";

function projectKey(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 20);
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseV2(value: unknown): WorkflowRun | undefined {
  if (!isRecord(value) || value.schemaVersion !== 2 || typeof value.id !== "string" || typeof value.executionCwd !== "string" || !isRecord(value.nodes)) return undefined;
  const workflow = value as unknown as WorkflowRun;
  workflow.notifications ??= [];
  workflow.externalEvidence ??= [];
  return workflow;
}

function processAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function v1IsQuiescent(value: Record<string, unknown>): boolean {
  if (processAlive(value.ownerProcessId)) return false;
  if (!isRecord(value.nodes)) return false;
  return Object.values(value.nodes).every((node) => {
    if (!isRecord(node)) return false;
    return ["succeeded", "failed", "paused", "orphaned", "stopped"].includes(String(node.status));
  });
}

function writeDurableJson(file: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", mode);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  chmodSync(file, mode);
  const dirFd = openSync(dirname(file), "r");
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

interface LockHandle { release(): Promise<void> }

async function acquireLock(lockFile: string, timeoutMs = 5000): Promise<LockHandle> {
  mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });
  if (!existsSync("/usr/bin/lockf")) throw new Error("Workflow writes require /usr/bin/lockf on this platform.");
  const helper = 'process.stdout.write("READY\\n");process.stdin.once("end",()=>process.exit(0));process.stdin.resume();';
  const child = spawn("/usr/bin/lockf", ["-k", "-t", String(Math.max(1, Math.ceil(timeoutMs / 1000))), lockFile, process.execPath, "-e", helper], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`Timed out acquiring workflow lock '${lockFile}'.`)), timeoutMs + 1000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (!output.includes("READY") || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => fail(error));
    child.once("exit", (code) => {
      if (!output.includes("READY")) fail(new Error(`Could not acquire workflow lock '${lockFile}' (lockf exit ${code ?? "unknown"}).`));
    });
  });
  return {
    async release() {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
      });
    },
  };
}

export class WorkflowStore {
  readonly projectDir: string;
  readonly projectCwd: string;

  constructor(root: string, readonly cwd: string) {
    this.projectCwd = cwd;
    this.projectDir = join(root, projectKey(cwd));
  }

  workflowDir(workflowId: string): string { return join(this.projectDir, workflowId); }
  statePath(workflowId: string): string { return join(this.workflowDir(workflowId), "state.json"); }
  attemptDir(workflowId: string, nodeId: string, attemptNumber: number): string { return join(this.workflowDir(workflowId), "nodes", nodeId, `attempt-${attemptNumber}`); }

  async initialize(): Promise<void> {
    mkdirSync(this.projectDir, { recursive: true, mode: 0o700 });
    chmodSync(this.projectDir, 0o700);
  }

  async loadAll(): Promise<WorkflowRun[]> {
    await this.initialize();
    const workflows: WorkflowRun[] = [];
    for (const entry of readdirSync(this.projectDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const workflow = await this.load(entry.name);
      if (workflow) workflows.push(workflow);
    }
    return workflows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(workflowId: string): Promise<WorkflowRun | undefined> {
    const file = this.statePath(workflowId);
    if (!existsSync(file)) return undefined;
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const v2 = parseV2(parsed);
    if (v2) return v2.projectCwd === this.projectCwd ? this.reconcileMigrationJournal(workflowId, v2) : undefined;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.id !== workflowId || parsed.cwd !== this.cwd) return undefined;
    if (v1IsQuiescent(parsed)) {
      try { return await this.migrateV1(workflowId, raw, parsed); }
      catch (error) {
        const projected = this.projectLiveV1(parsed);
        projected.controlsDisabled = `Migration failed and the original v1 state was preserved: ${error instanceof Error ? error.message : String(error)}`;
        return projected;
      }
    }
    return this.projectLiveV1(parsed);
  }

  async save(workflow: WorkflowRun): Promise<void> {
    if (workflow.controlsDisabled) throw new Error(`Workflow '${workflow.id}' is observation-only: ${workflow.controlsDisabled}`);
    const directory = this.workflowDir(workflow.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = await acquireLock(join(directory, "state.lock"));
    try {
      const current = existsSync(this.statePath(workflow.id)) ? parseV2(JSON.parse(readFileSync(this.statePath(workflow.id), "utf8"))) : undefined;
      if (current && (current.stateRevision !== workflow.stateRevision || current.ownerLeaseId !== workflow.ownerLeaseId || current.ownerLeaseEpoch !== workflow.ownerLeaseEpoch)) {
        throw new Error(`Workflow '${workflow.id}' lease or revision changed; this writer is fenced (expected revision ${workflow.stateRevision}, found ${current.stateRevision}).`);
      }
      workflow.stateRevision += 1;
      workflow.updatedAt = Date.now();
      workflow.cwd = workflow.executionCwd;
      writeDurableJson(this.statePath(workflow.id), workflow);
    } finally {
      await lock.release();
    }
  }

  saveSync(_workflow: WorkflowRun): never {
    throw new Error("Synchronous workflow writes are disabled; use save() so locking and revision fencing apply.");
  }

  async transaction(workflowId: string, expected: { revision: number; leaseId: string; leaseEpoch: number }, mutate: (current: WorkflowRun) => void): Promise<WorkflowRun> {
    const directory = this.workflowDir(workflowId);
    const lock = await acquireLock(join(directory, "state.lock"));
    try {
      const current = parseV2(JSON.parse(readFileSync(this.statePath(workflowId), "utf8")));
      if (!current) throw new Error(`Workflow '${workflowId}' is not writable schema v2.`);
      if (current.stateRevision !== expected.revision || current.ownerLeaseId !== expected.leaseId || current.ownerLeaseEpoch !== expected.leaseEpoch) {
        throw new Error(`Workflow '${workflowId}' lease or revision changed; this scheduler is fenced.`);
      }
      mutate(current);
      current.stateRevision += 1;
      current.updatedAt = Date.now();
      writeDurableJson(this.statePath(workflowId), current);
      return current;
    } finally { await lock.release(); }
  }

  async assertAuthority(workflowId: string, expected: { revision: number; leaseId: string; leaseEpoch: number }): Promise<void> {
    const directory = this.workflowDir(workflowId);
    const lock = await acquireLock(join(directory, "state.lock"));
    try {
      const current = parseV2(JSON.parse(readFileSync(this.statePath(workflowId), "utf8")));
      if (!current || current.stateRevision !== expected.revision || current.ownerLeaseId !== expected.leaseId || current.ownerLeaseEpoch !== expected.leaseEpoch) {
        throw new Error(`Workflow '${workflowId}' lease or revision changed; this scheduler is fenced.`);
      }
    } finally { await lock.release(); }
  }

  async takeover(workflowId: string, observed: { revision: number; leaseId: string; leaseEpoch: number; ownerProcessId?: number }, nextOwner: { sessionId: string; sessionFile?: string; processId: number }, staleAfterMs = 15_000): Promise<WorkflowRun> {
    const directory = this.workflowDir(workflowId);
    const lock = await acquireLock(join(directory, "state.lock"));
    try {
      const current = parseV2(JSON.parse(readFileSync(this.statePath(workflowId), "utf8")));
      if (!current) throw new Error(`Workflow '${workflowId}' is not writable schema v2.`);
      if (current.stateRevision !== observed.revision || current.ownerLeaseId !== observed.leaseId || current.ownerLeaseEpoch !== observed.leaseEpoch || current.ownerProcessId !== observed.ownerProcessId) {
        throw new Error("Takeover confirmation is stale; inspect the workflow again.");
      }
      if (Date.now() - (current.ownerHeartbeatAt ?? current.updatedAt) < staleAfterMs) throw new Error("Workflow owner heartbeat is still fresh.");
      if (processAlive(current.ownerProcessId)) throw new Error("Workflow owner process is still alive; takeover refused.");
      current.ownerSessionId = nextOwner.sessionId;
      current.ownerSessionFile = nextOwner.sessionFile;
      current.ownerProcessId = nextOwner.processId;
      current.ownerHeartbeatAt = Date.now();
      current.ownerLeaseId = randomUUID();
      current.ownerLeaseEpoch += 1;
      current.stateRevision += 1;
      current.updatedAt = Date.now();
      current.takeoverRequired = false;
      writeDurableJson(this.statePath(workflowId), current);
      return current;
    } finally { await lock.release(); }
  }

  async prepareAttempt(workflowId: string, nodeId: string, attemptNumber: number): Promise<string> {
    const directory = this.attemptDir(workflowId, nodeId, attemptNumber);
    mkdirSync(join(directory, "sessions"), { recursive: true, mode: 0o700 });
    return directory;
  }

  async resolveExecutionCwd(requested?: string): Promise<string> {
    const candidate = requested ?? this.cwd;
    const resolved = await realpath(candidate);
    if (!statSync(resolved).isDirectory()) throw new Error(`Workflow cwd is not a directory: ${resolved}`);
    return resolved;
  }

  private async migrateV1(workflowId: string, raw: string, value: Record<string, unknown>): Promise<WorkflowRun> {
    const directory = this.workflowDir(workflowId);
    const lock = await acquireLock(join(directory, "state.lock"));
    try {
      const sourceHash = hash(raw);
      const backup = join(directory, `state.v1.${sourceHash}.json`);
      const journal = join(directory, "migration-v1-v2.json");
      const leaseId = randomUUID();
      writeDurableJson(journal, { migrationId: randomUUID(), sourceHash, sourceRevision: Number(value.stateRevision) || 0, targetSchema: 2, phase: "prepared", backup: backup.split("/").at(-1), leaseId });
      if (!existsSync(backup)) {
        const fd = openSync(backup, "wx", 0o600);
        try { writeFileSync(fd, raw, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
        if (hash(readFileSync(backup)) !== sourceHash) throw new Error("Workflow v1 backup verification failed.");
      }
      const capability = randomBytes(32).toString("base64url");
      const migrated = this.transformV1(value, capability, leaseId, false);
      writeDurableJson(this.statePath(workflowId), migrated);
      writeDurableJson(journal, { sourceHash, sourceRevision: Number(value.stateRevision) || 0, targetSchema: 2, targetHash: hash(readFileSync(this.statePath(workflowId))), phase: "committed", backup: backup.split("/").at(-1) });
      return migrated;
    } finally { await lock.release(); }
  }

  private projectLiveV1(value: Record<string, unknown>): WorkflowRun {
    return this.transformV1(value, "", "legacy-observation-only", true);
  }

  private reconcileMigrationJournal(workflowId: string, workflow: WorkflowRun): WorkflowRun {
    const journal = join(this.workflowDir(workflowId), "migration-v1-v2.json");
    if (!existsSync(journal)) return workflow;
    try {
      const record = JSON.parse(readFileSync(journal, "utf8")) as { phase?: string; sourceHash?: string; backup?: string; targetHash?: string; sourceRevision?: number };
      if (record.phase === "committed") return workflow;
      if (!record.sourceHash || !record.backup) throw new Error("migration journal is incomplete");
      const backup = join(this.workflowDir(workflowId), record.backup);
      if (hash(readFileSync(backup)) !== record.sourceHash) throw new Error("migration backup hash does not match the journal");
      const targetHash = hash(readFileSync(this.statePath(workflowId)));
      writeDurableJson(journal, { sourceHash: record.sourceHash, sourceRevision: record.sourceRevision ?? 0, targetSchema: 2, targetHash, phase: "committed", backup: record.backup });
      return workflow;
    } catch (error) {
      return { ...workflow, controlsDisabled: `Migration verification failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private transformV1(value: Record<string, unknown>, capability: string, leaseId: string, observationOnly: boolean): WorkflowRun {
    const nodes = Object.fromEntries(Object.entries(value.nodes as Record<string, unknown>).map(([nodeId, rawNode]) => {
      const node = rawNode as Record<string, unknown>;
      const attempts = Array.isArray(node.attempts) ? node.attempts : [];
      const migratedAttempts: LegacyAttemptV2[] = attempts.map((rawAttempt, index) => {
        const attempt = rawAttempt as Record<string, unknown>;
        const attemptDir = this.attemptDir(String(value.id), nodeId, index + 1);
        mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
        if (!observationOnly && attempt.statusSnapshot !== undefined) writeDurableJson(join(attemptDir, "legacy-status.json"), attempt.statusSnapshot);
        if (!observationOnly && attempt.resultSnapshot !== undefined) writeDurableJson(join(attemptDir, "legacy-result.json"), attempt.resultSnapshot);
        return {
          id: String(attempt.id ?? `attempt-${index + 1}`),
          kind: "legacy",
          rpcRequestId: String(attempt.rpcRequestId ?? `legacy-${index + 1}`),
          packageRunId: typeof attempt.packageRunId === "string" ? attempt.packageRunId : undefined,
          asyncDir: typeof attempt.asyncDir === "string" ? attempt.asyncDir : undefined,
          ownerSessionId: String(attempt.ownerSessionId ?? value.ownerSessionId ?? "legacy"),
          requestedAt: Number(attempt.requestedAt) || Number(value.createdAt) || Date.now(),
          startedAt: typeof attempt.startedAt === "number" ? attempt.startedAt : undefined,
          endedAt: typeof attempt.endedAt === "number" ? attempt.endedAt : undefined,
          state: String(attempt.state ?? node.status ?? "orphaned") as LegacyAttemptV2["state"],
          sessionRoot: String(attempt.sessionRoot ?? join(attemptDir, "sessions")),
          dependencyAttemptIds: {},
          controls: [],
          completionSeen: attempt.completionSeen === true,
          error: typeof attempt.error === "string" ? attempt.error : undefined,
          controlAvailable: false,
          lookupAvailable: false,
        };
      });
      return [nodeId, {
        spec: node.spec as WorkflowNode["spec"],
        status: String(node.status) as WorkflowNode["status"],
        attempts: migratedAttempts,
        authoritativeAttemptId: migratedAttempts.at(-1)?.id,
      } satisfies WorkflowNode];
    })) as Record<string, WorkflowNode>;
    const executionCwd = String(value.cwd);
    return {
      schemaVersion: 2,
      id: String(value.id),
      name: String(value.name ?? value.id),
      projectCwd: executionCwd,
      executionCwd,
      cwd: executionCwd,
      workflowCapability: capability,
      ownerSessionId: String(value.ownerSessionId ?? "legacy"),
      ownerProcessId: typeof value.ownerProcessId === "number" ? value.ownerProcessId : undefined,
      ownerHeartbeatAt: typeof value.ownerHeartbeatAt === "number" ? value.ownerHeartbeatAt : undefined,
      ownerSessionFile: typeof value.ownerSessionFile === "string" ? value.ownerSessionFile : undefined,
      ownerLeaseId: leaseId,
      ownerLeaseEpoch: 1,
      stateRevision: 0,
      status: String(value.status ?? "blocked") as WorkflowRun["status"],
      maxConcurrency: Number(value.maxConcurrency) || 4,
      createdAt: Number(value.createdAt) || Date.now(),
      updatedAt: Number(value.updatedAt) || Date.now(),
      runtimeContract: { rpcVersion: 2, artifactVersion: 2 },
      ...(observationOnly ? { controlsDisabled: "Live or queued schema-v1 workflow is observation-only until it reaches a quiescent state.", takeoverRequired: true } : {}),
      nodes,
      telemetry: emptyTelemetry(),
      notifications: [],
      externalEvidence: [],
    };
  }
}
