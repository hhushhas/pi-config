import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { THINKING_LEVELS, type NodeAttempt, type NodeStatusSnapshot, type ThinkingLevel, type WorkflowNode } from "./model.ts";

export function normalizedModel(
  model: string | undefined,
  thinking: ThinkingLevel | undefined,
  fallback?: string,
): string | undefined {
  const resolved = model ?? fallback;
  if (!resolved || !thinking || new RegExp(`:(${THINKING_LEVELS.join("|")})$`).test(resolved)) return resolved;
  return `${resolved}:${thinking}`;
}

export function resultState(result: Record<string, unknown>): NodeAttempt["state"] {
  if (result.state === "paused") return "paused";
  return result.success === true || result.state === "complete" ? "succeeded" : "failed";
}

export async function refreshAttemptFromDisk(node: WorkflowNode, attempt: NodeAttempt): Promise<boolean> {
  try {
    const raw = await readFile(join(attempt.asyncDir!, "status.json"), "utf8");
    const snapshot = JSON.parse(raw) as NodeStatusSnapshot;
    const snapshotChanged = JSON.stringify(attempt.statusSnapshot) !== JSON.stringify(snapshot);
    attempt.statusSnapshot = snapshot;
    const previous = node.status;
    if (attempt.stopRequested && ["complete", "failed", "paused"].includes(snapshot.state ?? "")) node.status = "stopped";
    else if (attempt.pauseRequested && ["complete", "failed", "paused"].includes(snapshot.state ?? "")) node.status = "paused";
    else if (snapshot.state === "complete") node.status = "succeeded";
    else if (snapshot.state === "failed") node.status = "failed";
    else if (snapshot.state === "paused") node.status = "paused";
    else if (attempt.stopRequested) node.status = "stopping";
    else if (attempt.pauseRequested) node.status = "pausing";
    else node.status = "running";
    attempt.state = node.status;
    attempt.startedAt ??= snapshot.startedAt;
    attempt.endedAt = snapshot.endedAt;
    return snapshotChanged || previous !== node.status;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (Date.now() - attempt.requestedAt < 5000) return false;
    node.status = "orphaned";
    attempt.state = "orphaned";
    attempt.endedAt = Date.now();
    attempt.error = "The pi-subagents status artifact is missing.";
    return true;
  }
}
