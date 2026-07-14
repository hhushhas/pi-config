import { currentAttempt, effectiveNodeStatus, type WorkflowRun } from "./model.ts";

const TRUNCATED = "… [truncated]";

function truncate(value: string | undefined, maxChars: number): string | undefined {
  if (!value || value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - TRUNCATED.length))}${TRUNCATED}`;
}

function encodeBounded(value: unknown, maxBytes: number): string {
  let text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const wrapper = value as { nodes?: unknown[]; workflows?: unknown[]; hints?: unknown };
  if (wrapper && typeof wrapper === "object") delete wrapper.hints;
  const collection = Array.isArray(wrapper.nodes) ? wrapper.nodes : Array.isArray(wrapper.workflows) ? wrapper.workflows : undefined;
  if (collection) {
    while (collection.length > 0 && Buffer.byteLength(JSON.stringify(value, null, 2), "utf8") > maxBytes - 128) collection.pop();
    collection.push({ truncated: true });
  }
  text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return JSON.stringify({ truncated: true, message: `Projection exceeded ${maxBytes} UTF-8 bytes; use node inspection for a narrower view.` });
}

export function listProjection(workflows: WorkflowRun[], includeHistory = false): string {
  const visible = includeHistory ? workflows : workflows.filter((workflow) => !["succeeded", "stopped"].includes(workflow.status));
  return encodeBounded({ workflows: visible.map((workflow) => ({
    id: workflow.id,
    name: truncate(workflow.name, 120),
    status: workflow.status,
    executionCwd: truncate(workflow.executionCwd, 240),
    succeeded: Object.values(workflow.nodes).filter((node) => node.status === "succeeded").length,
    total: Object.keys(workflow.nodes).length,
    live: Object.values(workflow.nodes).filter((node) => ["launching", "running", "pausing", "stopping"].includes(node.status)).length,
    costUsd: workflow.telemetry.costUsd,
    totalTokens: workflow.telemetry.totalTokens,
    updatedAt: workflow.updatedAt,
  })) }, 32 * 1024);
}

export function statusProjection(workflow: WorkflowRun): string {
  const projection = {
    id: workflow.id,
    name: truncate(workflow.name, 120),
    status: workflow.status,
    owner: { sessionId: truncate(workflow.ownerSessionId, 96), processId: workflow.ownerProcessId, leaseEpoch: workflow.ownerLeaseEpoch, heartbeatAt: workflow.ownerHeartbeatAt },
    executionCwd: truncate(workflow.executionCwd, 240),
    maxConcurrency: workflow.maxConcurrency,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    telemetry: workflow.telemetry,
    externalEvidence: (workflow.externalEvidence ?? []).map((item) => ({ runId: item.runId, state: item.state, asyncDir: truncate(item.asyncDir, 240), reason: item.reason })),
    nodes: Object.values(workflow.nodes).map((node) => {
      const attempt = currentAttempt(node);
      return {
        id: node.spec.id,
        label: truncate(node.spec.label ?? node.spec.id, 120),
        status: effectiveNodeStatus(workflow, node),
        dependsOn: node.spec.dependsOn,
        cwd: truncate(node.spec.cwd, 160),
        attemptId: attempt?.id,
        runId: attempt?.packageRunId,
        kind: attempt?.kind,
        model: truncate(attempt?.telemetry?.model ?? node.spec.model, 100),
        thinking: attempt?.telemetry?.thinking ?? node.spec.thinking,
        elapsedMs: attempt?.startedAt ? (attempt.endedAt ?? Date.now()) - attempt.startedAt : undefined,
        lastActivityAt: attempt?.telemetry?.lastActivityAt,
        attention: attempt?.telemetry?.activityState,
        tokens: attempt?.telemetry?.totalTokens,
        cost: attempt?.telemetry?.totalCost,
        error: truncate(attempt?.error, 240),
      };
    }),
    hints: workflow.status === "blocked" ? ["Inspect the blocked node, then use workflow resume, retry, stop, or explicit takeover as appropriate."] : undefined,
  };
  const text = encodeBounded(projection, 32 * 1024);
  workflow.telemetry.lastStatusBytes = Buffer.byteLength(text, "utf8");
  return text;
}

export function inspectProjection(workflow: WorkflowRun, nodeId: string): string {
  const node = workflow.nodes[nodeId];
  if (!node) throw new Error(`Node '${nodeId}' was not found.`);
  const attempt = currentAttempt(node);
  return encodeBounded({
    workflowId: workflow.id,
    node: {
      id: node.spec.id,
      label: truncate(node.spec.label ?? node.spec.id, 120),
      status: effectiveNodeStatus(workflow, node),
      dependsOn: node.spec.dependsOn,
      executionCwd: truncate(node.spec.cwd ? `${workflow.executionCwd}/${node.spec.cwd}` : workflow.executionCwd, 320),
      authoritativeAttemptId: node.authoritativeAttemptId,
    },
    attempt: attempt ? {
      id: attempt.id,
      kind: attempt.kind,
      runId: attempt.packageRunId,
      asyncDir: truncate(attempt.asyncDir, 320),
      sessionFile: truncate(attempt.childSessionFile, 320),
      sourceRunId: attempt.kind !== "legacy" ? attempt.sourceRunId : undefined,
      previousAttemptId: attempt.kind !== "legacy" ? attempt.previousAttemptId : undefined,
      dependencyAttemptIds: attempt.dependencyAttemptIds,
      state: attempt.state,
      requestedAt: attempt.requestedAt,
      startedAt: attempt.startedAt,
      endedAt: attempt.endedAt,
      telemetry: attempt.telemetry,
      controls: attempt.controls.slice(-20).map((control) => ({ ...control, error: truncate(control.error, 240) })),
      error: truncate(attempt.error, 320),
    } : undefined,
    externalEvidence: (workflow.externalEvidence ?? []).filter((item) => item.sessionFile === attempt?.childSessionFile).map((item) => ({ runId: item.runId, state: item.state, asyncDir: truncate(item.asyncDir, 320), authority: "read-only external evidence" })),
    statePath: `${workflow.projectCwd} (workflow state is stored under the Pi agent workflow-runs directory)`,
  }, 8 * 1024);
}
