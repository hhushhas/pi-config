import { isAbsolute } from "node:path";

export const WORKFLOW_SCHEMA_VERSION = 2 as const;

export const WORKFLOW_HARNESSES = ["pi", "claude", "codex", "grok"] as const;
export type WorkflowHarness = typeof WORKFLOW_HARNESSES[number];

export type WorkflowRunStatus =
  | "active"
  | "pausing"
  | "stopping"
  | "awaiting_resume"
  | "paused"
  | "succeeded"
  | "blocked"
  | "failed"
  | "stopped";

export type WorkflowNodeStatus =
  | "queued"
  | "launching"
  | "running"
  | "pausing"
  | "stopping"
  | "succeeded"
  | "failed"
  | "paused"
  | "orphaned"
  | "stopped"
  | "invalidated";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

export interface WorkflowNodeSpec {
  id: string;
  label?: string;
  /** Durable execution backend. Omitted preserves the historical Pi role runtime. */
  harness?: WorkflowHarness;
  agent: string;
  task: string;
  dependsOn: string[];
  cwd?: string;
  model?: string;
  thinking?: ThinkingLevel;
  timeoutMs?: number;
}

export interface CostSnapshot {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AttemptTelemetry {
  state?: string;
  startedAt?: number;
  endedAt?: number;
  lastActivityAt?: number;
  activityState?: "active_long_running" | "needs_attention";
  currentTool?: string;
  currentPath?: string;
  turnCount?: number;
  toolCount?: number;
  totalTokens?: { input: number; output: number; total: number };
  totalCost?: CostSnapshot;
  model?: string;
  thinking?: string;
  terminalReason?: "completed" | "failed" | "paused" | "stopped" | "timed_out" | "process_lost";
  terminalControlRequestId?: string;
}

export interface AttemptControl {
  controlRequestId: string;
  action: "pause" | "stop" | "resume" | "steer";
  requestedAt: number;
  acceptedAt?: number;
  confirmedAt?: number;
  error?: string;
}

interface AttemptBaseV2 {
  id: string;
  rpcRequestId: string;
  packageRunId?: string;
  asyncDir?: string;
  pid?: number;
  ownerSessionId: string;
  requestedAt: number;
  startedAt?: number;
  endedAt?: number;
  state: Exclude<WorkflowNodeStatus, "queued">;
  sessionRoot: string;
  childSessionFile?: string;
  dependencyAttemptIds: Record<string, string>;
  controls: AttemptControl[];
  telemetry?: AttemptTelemetry;
  completionSeen?: boolean;
  error?: string;
}

export interface LaunchedAttemptV2 extends AttemptBaseV2 {
  kind: "initial" | "resume" | "retry";
  launchOperationId: string;
  previousAttemptId?: string;
  sourceRunId?: string;
  runtimeProtocolVersion: 2;
  artifactVersion: 2;
  launchLeaseEpoch: number;
  expectedExecution: {
    harness?: WorkflowHarness;
    agent: string;
    model?: string;
    thinking?: string;
    cwd: string;
    timeoutMs?: number;
    notificationMode: "event-only";
  };
}

export interface LegacyAttemptV2 extends AttemptBaseV2 {
  kind: "legacy";
  controlAvailable: false;
  lookupAvailable: false;
}

export type NodeAttempt = LaunchedAttemptV2 | LegacyAttemptV2;

export interface WorkflowNode {
  spec: WorkflowNodeSpec;
  status: WorkflowNodeStatus;
  attempts: NodeAttempt[];
  authoritativeAttemptId?: string;
  invalidatedAt?: number;
  invalidatedByAttemptId?: string;
}

export interface WorkflowTelemetry {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  attempts: number;
  turns: number;
  tools: number;
  wallTimeMs: number;
  queueTimeMs: number;
  controlFailures: number;
  attentionEvents: number;
  notificationCount: number;
  notificationBytes: number;
  parentWakeCount: number;
  lastStatusBytes: number;
}

export interface NotificationRecord {
  key: string;
  category: "succeeded" | "blocked" | "failed" | "paused" | "stopped";
  attemptedAt: number;
  deliveredAt?: number;
  bytes: number;
  triggerTurn: boolean;
  message: string;
  error?: string;
}

export interface WorkflowRun {
  schemaVersion: 2;
  id: string;
  name: string;
  projectCwd: string;
  executionCwd: string;
  /** Compatibility alias for pre-v2 display code; always equals executionCwd. */
  cwd: string;
  workflowCapability: string;
  ownerSessionId: string;
  ownerProcessId?: number;
  ownerHeartbeatAt?: number;
  ownerSessionFile?: string;
  ownerLeaseId: string;
  ownerLeaseEpoch: number;
  stateRevision: number;
  status: WorkflowRunStatus;
  maxConcurrency: number;
  createdAt: number;
  updatedAt: number;
  runtimeContract: {
    rpcVersion: 2;
    artifactVersion: 2;
  };
  controlsDisabled?: string;
  takeoverRequired?: boolean;
  nodes: Record<string, WorkflowNode>;
  telemetry: WorkflowTelemetry;
  notifications: NotificationRecord[];
  externalEvidence: Array<{
    runId: string;
    asyncDir: string;
    state: string;
    sessionFile: string;
    discoveredAt: number;
    reason: "shared-child-session";
  }>;
}

export interface WorkflowDefinition {
  name: string;
  cwd?: string;
  nodes: Array<Omit<WorkflowNodeSpec, "dependsOn"> & { dependsOn?: string[] }>;
  maxConcurrency?: number;
}

const TERMINAL_FAILURES = new Set<WorkflowNodeStatus>(["failed", "paused", "orphaned", "stopped", "invalidated"]);

export function validateDefinition(definition: WorkflowDefinition): WorkflowNodeSpec[] {
  const name = definition.name.trim();
  if (!name) throw new Error("Workflow name is required.");
  if (definition.nodes.length === 0) throw new Error("A workflow needs at least one node.");
  if (definition.nodes.length > 64) throw new Error("A workflow may contain at most 64 nodes.");
  const maxConcurrency = definition.maxConcurrency ?? 4;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8) {
    throw new Error("maxConcurrency must be an integer from 1 to 8.");
  }
  const ids = new Set<string>();
  const nodes = definition.nodes.map((node) => {
    const id = node.id.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new Error(`Invalid node id '${node.id}'. Use 1-64 letters, numbers, underscores, or hyphens.`);
    if (ids.has(id)) throw new Error(`Duplicate node id '${id}'.`);
    if (!node.agent.trim()) throw new Error(`Node '${id}' needs an agent role.`);
    if (node.harness !== undefined && !(WORKFLOW_HARNESSES as readonly string[]).includes(node.harness)) throw new Error(`Node '${id}' has unsupported harness '${node.harness}'.`);
    if (!node.task.trim()) throw new Error(`Node '${id}' needs a task.`);
    if (node.cwd !== undefined && (!node.cwd.trim() || isAbsolute(node.cwd) || node.cwd.split(/[\\/]+/).includes(".."))) {
      throw new Error(`Node '${id}' cwd must be a relative path contained by the workflow execution directory.`);
    }
    if (node.thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(node.thinking)) throw new Error(`Node '${id}' has unsupported reasoning effort '${node.thinking}'.`);
    ids.add(id);
    return { ...node, id, dependsOn: [...new Set(node.dependsOn ?? [])] };
  });
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Node '${node.id}' depends on unknown node '${dependency}'.`);
      if (dependency === node.id) throw new Error(`Node '${node.id}' cannot depend on itself.`);
    }
  }
  topologicalNodeIds(Object.fromEntries(nodes.map((node) => [node.id, { spec: node }])));
  return nodes;
}

export function topologicalNodeIds(nodes: Record<string, Pick<WorkflowNode, "spec">>): string[] {
  const indegree = new Map(Object.keys(nodes).map((id) => [id, 0]));
  const dependents = new Map(Object.keys(nodes).map((id) => [id, [] as string[]]));
  for (const node of Object.values(nodes)) {
    indegree.set(node.spec.id, node.spec.dependsOn.length);
    for (const dependency of node.spec.dependsOn) dependents.get(dependency)?.push(node.spec.id);
  }
  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id).sort();
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const count = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, count);
      if (count === 0) ready.push(dependent);
    }
    ready.sort();
  }
  if (ordered.length !== Object.keys(nodes).length) throw new Error("Workflow dependencies contain a cycle.");
  return ordered;
}

export function currentAttempt(node: WorkflowNode): NodeAttempt | undefined {
  if (node.authoritativeAttemptId) return node.attempts.find((attempt) => attempt.id === node.authoritativeAttemptId);
  if (node.invalidatedAt !== undefined) return undefined;
  return node.attempts.at(-1);
}

export function successfulAuthoritativeAttempt(node: WorkflowNode): NodeAttempt | undefined {
  const attempt = currentAttempt(node);
  const unresolvedControl = attempt?.controls.some((control) => ["pause", "stop"].includes(control.action) && !control.confirmedAt);
  return attempt?.state === "succeeded" && attempt.completionSeen && !unresolvedControl ? attempt : undefined;
}

export function effectiveNodeStatus(workflow: WorkflowRun, node: WorkflowNode): WorkflowNodeStatus | "blocked" {
  if (node.status !== "queued") return node.status;
  const dependencies = node.spec.dependsOn.map((id) => workflow.nodes[id]?.status);
  return dependencies.some((status) => status && TERMINAL_FAILURES.has(status)) ? "blocked" : "queued";
}

export function readyNodeIds(workflow: WorkflowRun): string[] {
  return topologicalNodeIds(workflow.nodes).filter((id) => {
    const node = workflow.nodes[id];
    return node.status === "queued" && node.spec.dependsOn.every((dependency) => successfulAuthoritativeAttempt(workflow.nodes[dependency]) !== undefined);
  });
}

export function deriveWorkflowStatus(workflow: WorkflowRun): WorkflowRunStatus {
  const nodes = Object.values(workflow.nodes);
  if (nodes.every((node) => node.status === "succeeded")) return "succeeded";
  const hasLiveNode = nodes.some((node) => ["running", "launching", "pausing", "stopping"].includes(node.status));
  if (workflow.status === "pausing") return hasLiveNode ? "pausing" : "paused";
  if (workflow.status === "stopping") return hasLiveNode ? "stopping" : "stopped";
  if (["awaiting_resume", "paused", "stopped", "failed"].includes(workflow.status)) return workflow.status;
  if (hasLiveNode) return "active";
  if (readyNodeIds(workflow).length > 0) return "active";
  return "blocked";
}

export function descendantsOf(workflow: WorkflowRun, nodeId: string): string[] {
  const result = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const node of Object.values(workflow.nodes)) {
      if (!result.has(node.spec.id) && node.spec.dependsOn.includes(current)) {
        result.add(node.spec.id);
        queue.push(node.spec.id);
      }
    }
  }
  return [...result];
}

export function emptyTelemetry(): WorkflowTelemetry {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, attempts: 0, turns: 0, tools: 0, wallTimeMs: 0, queueTimeMs: 0, controlFailures: 0, attentionEvents: 0, notificationCount: 0, notificationBytes: 0, parentWakeCount: 0, lastStatusBytes: 0 };
}
