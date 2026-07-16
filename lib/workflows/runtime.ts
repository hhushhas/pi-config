import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { THINKING_LEVELS, currentAttempt, type AttemptTelemetry, type NodeAttempt, type ThinkingLevel, type WorkflowNode, type WorkflowRun } from "./model.ts";
import type { RuntimeStatus } from "./rpc-client.ts";

export function normalizedModel(model: string | undefined, thinking: ThinkingLevel | undefined, fallback?: string): string | undefined {
  const resolved = model ?? fallback;
  if (!resolved || !thinking || new RegExp(`:(${THINKING_LEVELS.join("|")})$`).test(resolved)) return resolved;
  return `${resolved}:${thinking}`;
}

export function resultState(result: Record<string, unknown>): NodeAttempt["state"] {
  const terminal = result.terminal as { reason?: string } | undefined;
  if (terminal?.reason === "paused" || result.state === "paused") return "paused";
  if (terminal?.reason === "stopped" || result.state === "stopped") return "stopped";
  if (terminal?.reason === "completed" || result.success === true || result.state === "complete") return "succeeded";
  return "failed";
}

function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function telemetry(status: RuntimeStatus): AttemptTelemetry {
  return {
    state: status.state,
    startedAt: status.startedAt,
    endedAt: status.endedAt,
    lastActivityAt: status.lastUpdate,
    activityState: status.activityState,
    currentTool: status.currentTool,
    turnCount: status.turnCount,
    toolCount: status.toolCount,
    totalTokens: status.totalTokens,
    totalCost: status.totalCost,
    model: status.runtimeLaunch?.effectiveExecution.model,
    thinking: status.runtimeLaunch?.effectiveExecution.thinking,
    terminalReason: status.terminal?.reason,
    terminalControlRequestId: status.terminal?.controlRequestId,
  };
}

function validateAuthority(workflow: WorkflowRun, node: WorkflowNode, attempt: NodeAttempt, status: RuntimeStatus): string | undefined {
  if (attempt.kind === "legacy") return undefined;
  const identity = status.sessionIdentity;
  const launch = status.runtimeLaunch;
  if (!identity || !launch) return "Runtime status lacks workflow identity and launch provenance.";
  if (identity.workflowId !== workflow.id || identity.nodeId !== node.spec.id || identity.attemptId !== attempt.id) return "Runtime provenance does not match this workflow attempt.";
  if (identity.ownerLeaseEpoch !== attempt.launchLeaseEpoch) return "Runtime launch lease epoch does not match this attempt.";
  const expectedCapabilityHash = createHash("sha256").update("pi-workflow-capability-v1\0").update(workflow.id).update("\0").update(workflow.workflowCapability).digest("hex");
  if (identity.workflowCapabilityHash !== expectedCapabilityHash) return "Runtime capability hash does not match this workflow.";
  if (launch.operationId !== attempt.launchOperationId || launch.runId !== attempt.packageRunId) return "Runtime launch operation does not match this attempt.";
  if (launch.provenance.workflowId !== workflow.id || launch.provenance.nodeId !== node.spec.id || launch.provenance.attemptId !== attempt.id || launch.provenance.ownerLeaseEpoch !== attempt.launchLeaseEpoch) return "Runtime launch provenance does not match this attempt.";
  const expected = attempt.expectedExecution;
  if ((launch.effectiveExecution.harness ?? "pi") !== (expected.harness ?? "pi") || launch.effectiveExecution.agent !== expected.agent || launch.effectiveExecution.model !== expected.model || launch.effectiveExecution.thinking !== expected.thinking
    || resolve(launch.effectiveExecution.cwd) !== expected.cwd || launch.effectiveExecution.timeoutMs !== expected.timeoutMs || launch.effectiveExecution.notificationMode !== expected.notificationMode) return "Runtime effective execution contract does not match this attempt.";
  if (!status.cwd || resolve(status.cwd) !== expected.cwd) return `Runtime cwd mismatch: expected '${expected.cwd}', got '${status.cwd ?? "missing"}'.`;
  if (attempt.kind === "resume") {
    const source = attempt.previousAttemptId ? node.attempts.find((candidate) => candidate.id === attempt.previousAttemptId) : undefined;
    if (!source || launch.sourceRunId !== source.packageRunId || launch.sourceAttemptId !== source.id || launch.sourceSessionFile !== source.childSessionFile
      || launch.sourceProvenance?.workflowId !== workflow.id || launch.sourceProvenance.nodeId !== node.spec.id || launch.sourceProvenance.attemptId !== source.id
      || (source.kind !== "legacy" && launch.sourceProvenance.ownerLeaseEpoch !== source.launchLeaseEpoch)) return "Runtime resume lineage does not match the paused source attempt.";
  }
  return undefined;
}

export async function refreshAttemptFromDisk(workflow: WorkflowRun, node: WorkflowNode, attempt: NodeAttempt, authoritative = true): Promise<boolean> {
  if (!attempt.asyncDir) return false;
  try {
    const raw = await readFile(join(attempt.asyncDir, "status.json"), "utf8");
    const status = JSON.parse(raw) as RuntimeStatus;
    if (!status || typeof status.runId !== "string" || typeof status.state !== "string") throw new Error("Malformed runtime status artifact.");
    const previous = JSON.stringify({ node: node.status, attempt: attempt.state, telemetry: attempt.telemetry, controls: attempt.controls });
    attempt.pid = status.pid;
    attempt.telemetry = telemetry(status);
    attempt.startedAt ??= status.startedAt;
    attempt.endedAt = status.endedAt;
    attempt.childSessionFile = status.sessionFile;
    const authorityError = validateAuthority(workflow, node, attempt, status);
    if (authorityError) {
      attempt.error = authorityError;
      attempt.state = "orphaned";
      if (authoritative) node.status = "orphaned";
      return true;
    }
    const pending = [...attempt.controls].reverse().find((control) => ["pause", "stop"].includes(control.action) && !control.confirmedAt);
    if (!status.terminal && status.pid && Date.now() - (status.lastUpdate ?? attempt.requestedAt) >= 5_000 && !processAlive(status.pid)) {
      attempt.endedAt = Date.now();
      attempt.error = "The durable runtime process exited without publishing a terminal record.";
      attempt.state = "orphaned";
      attempt.telemetry.terminalReason = "process_lost";
      if (authoritative) node.status = "orphaned";
    } else if (status.terminal) {
      attempt.endedAt = status.terminal.at;
      attempt.completionSeen = true;
      const expectedReason = pending?.action === "pause" ? "paused" : pending?.action === "stop" ? "stopped" : undefined;
      if (pending && status.terminal.reason === expectedReason && status.terminal.controlRequestId === pending.controlRequestId) {
        pending.confirmedAt = status.terminal.at;
      } else if (pending) {
        pending.error = status.terminal.reason === "completed" ? "completed_before_control" : `Control was not confirmed; runtime ended as ${status.terminal.reason}.`;
      }
      attempt.state = status.terminal.reason === "completed" ? "succeeded" : status.terminal.reason === "paused" ? "paused" : status.terminal.reason === "stopped" ? "stopped" : "failed";
      if (authoritative) node.status = attempt.state;
    } else if (status.state === "pausing") {
      attempt.state = "pausing"; if (authoritative) node.status = "pausing";
    } else if (status.state === "stopping") {
      attempt.state = "stopping"; if (authoritative) node.status = "stopping";
    } else if (["running", "queued"].includes(status.state)) {
      if (!pending || !["pausing", "stopping"].includes(attempt.state)) {
        attempt.state = "running"; if (authoritative) node.status = "running";
      }
    } else if (["complete", "failed", "paused", "stopped"].includes(status.state)) {
      attempt.error = "Runtime reached a terminal state without a terminal record.";
      attempt.state = "orphaned"; if (authoritative) node.status = "orphaned";
    }
    return previous !== JSON.stringify({ node: node.status, attempt: attempt.state, telemetry: attempt.telemetry, controls: attempt.controls });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      attempt.error = error instanceof Error ? error.message : String(error);
      return true;
    }
    if (Date.now() - attempt.requestedAt < 5000) return false;
    if (processAlive(attempt.pid)) {
      attempt.error = "The runtime artifact is unreadable, but the child process may still be live.";
      return true;
    }
    if (authoritative) node.status = "orphaned";
    attempt.state = "orphaned";
    attempt.endedAt = Date.now();
    attempt.error = "The runtime artifact is missing and the child process is not alive.";
    return true;
  }
}

export function rebuildWorkflowTelemetry(workflow: WorkflowRun): void {
  const attempts = Object.values(workflow.nodes).flatMap((node) => node.attempts);
  workflow.telemetry.inputTokens = attempts.reduce((sum, attempt) => sum + (attempt.telemetry?.totalTokens?.input ?? 0), 0);
  workflow.telemetry.outputTokens = attempts.reduce((sum, attempt) => sum + (attempt.telemetry?.totalTokens?.output ?? 0), 0);
  workflow.telemetry.totalTokens = attempts.reduce((sum, attempt) => sum + (attempt.telemetry?.totalTokens?.total ?? 0), 0);
  workflow.telemetry.costUsd = attempts.reduce((sum, attempt) => sum + (attempt.telemetry?.totalCost?.costUsd ?? 0), 0);
  workflow.telemetry.attempts = attempts.length;
  workflow.telemetry.turns = attempts.reduce((sum, attempt) => sum + (attempt.telemetry?.turnCount ?? 0), 0);
  workflow.telemetry.tools = attempts.reduce((sum, attempt) => sum + (attempt.telemetry?.toolCount ?? 0), 0);
  workflow.telemetry.controlFailures = attempts.flatMap((attempt) => attempt.controls).filter((control) => control.error).length;
}

export function authoritativeAttemptForRun(workflow: WorkflowRun, runId: string): { node: WorkflowNode; attempt: NodeAttempt; authoritative: boolean } | undefined {
  for (const node of Object.values(workflow.nodes)) {
    const attempt = node.attempts.find((candidate) => candidate.packageRunId === runId);
    if (attempt) return { node, attempt, authoritative: currentAttempt(node)?.id === attempt.id };
  }
  return undefined;
}

export async function discoverExternalRuns(workflow: WorkflowRun): Promise<WorkflowRun["externalEvidence"]> {
  const attempts = Object.values(workflow.nodes).flatMap((node) => node.attempts);
  const knownSessions = new Set(attempts.map((attempt) => attempt.childSessionFile).filter((value): value is string => Boolean(value)));
  const attachedRunIds = new Set(attempts.map((attempt) => attempt.packageRunId).filter((value): value is string => Boolean(value)));
  const roots = new Set(attempts.map((attempt) => attempt.asyncDir ? dirname(attempt.asyncDir) : undefined).filter((value): value is string => Boolean(value)));
  const previous = new Map((workflow.externalEvidence ?? []).map((item) => [item.runId, item]));
  const evidence: WorkflowRun["externalEvidence"] = [];
  for (const root of roots) {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try { entries = await readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith("." ) || attachedRunIds.has(entry.name)) continue;
      const asyncDir = join(root, entry.name);
      try {
        const status = JSON.parse(await readFile(join(asyncDir, "status.json"), "utf8")) as RuntimeStatus;
        if (!status.runId || attachedRunIds.has(status.runId) || !status.sessionFile || !knownSessions.has(status.sessionFile)) continue;
        if (status.sessionIdentity?.workflowId) continue;
        evidence.push({ runId: status.runId, asyncDir, state: status.state, sessionFile: status.sessionFile, discoveredAt: previous.get(status.runId)?.discoveredAt ?? Date.now(), reason: "shared-child-session" });
      } catch { /* incomplete or unrelated runtime artifact */ }
    }
  }
  return evidence.sort((left, right) => left.runId.localeCompare(right.runId));
}
