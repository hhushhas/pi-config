export const WORKFLOW_SCHEMA_VERSION = 1 as const;

export type WorkflowRunStatus =
  | "active"
  | "awaiting_resume"
  | "paused"
  | "succeeded"
  | "blocked"
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
  | "stopped";

export interface WorkflowNodeSpec {
  id: string;
  label?: string;
  agent: string;
  task: string;
  dependsOn: string[];
  model?: string;
  thinking?: ThinkingLevel;
  timeoutMs?: number;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

export interface CostSnapshot {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface NodeStatusSnapshot {
  state?: string;
  startedAt?: number;
  endedAt?: number;
  lastActivityAt?: number;
  currentTool?: string;
  currentPath?: string;
  turnCount?: number;
  toolCount?: number;
  totalTokens?: { input: number; output: number; total: number };
  totalCost?: CostSnapshot;
  steps?: Array<{
    model?: string;
    thinking?: string;
    recentOutput?: string[];
    transcriptPath?: string;
    currentTool?: string;
    currentPath?: string;
    turnCount?: number;
    toolCount?: number;
    totalCost?: CostSnapshot;
    tokens?: { input: number; output: number; total: number };
  }>;
}

export interface NodeAttempt {
  id: string;
  rpcRequestId: string;
  packageRunId?: string;
  asyncDir?: string;
  ownerSessionId: string;
  requestedAt: number;
  startedAt?: number;
  endedAt?: number;
  state: Exclude<WorkflowNodeStatus, "queued">;
  sessionRoot: string;
  statusSnapshot?: NodeStatusSnapshot;
  resultSnapshot?: Record<string, unknown>;
  completionSeen?: boolean;
  pauseRequested?: boolean;
  stopRequested?: boolean;
  error?: string;
}

export interface WorkflowNode {
  spec: WorkflowNodeSpec;
  status: WorkflowNodeStatus;
  attempts: NodeAttempt[];
}

export interface WorkflowRun {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  id: string;
  name: string;
  cwd: string;
  ownerSessionId: string;
  ownerProcessId?: number;
  ownerHeartbeatAt?: number;
  ownerSessionFile?: string;
  status: WorkflowRunStatus;
  maxConcurrency: number;
  createdAt: number;
  updatedAt: number;
  nodes: Record<string, WorkflowNode>;
}

export interface WorkflowDefinition {
  name: string;
  nodes: Array<Omit<WorkflowNodeSpec, "dependsOn"> & { dependsOn?: string[] }>;
  maxConcurrency?: number;
}

const TERMINAL_FAILURES = new Set<WorkflowNodeStatus>(["failed", "paused", "orphaned", "stopped"]);

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
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
      throw new Error(`Invalid node id '${node.id}'. Use 1-64 letters, numbers, underscores, or hyphens.`);
    }
    if (ids.has(id)) throw new Error(`Duplicate node id '${id}'.`);
    if (!node.agent.trim()) throw new Error(`Node '${id}' needs an agent role.`);
    if (!node.task.trim()) throw new Error(`Node '${id}' needs a task.`);
    if (node.thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(node.thinking)) {
      throw new Error(`Node '${id}' has unsupported reasoning effort '${node.thinking}'.`);
    }
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

export function topologicalNodeIds(
  nodes: Record<string, Pick<WorkflowNode, "spec">>,
): string[] {
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

export function effectiveNodeStatus(workflow: WorkflowRun, node: WorkflowNode): WorkflowNodeStatus | "blocked" {
  if (node.status !== "queued") return node.status;
  const dependencies = node.spec.dependsOn.map((id) => workflow.nodes[id]?.status);
  return dependencies.some((status) => status && TERMINAL_FAILURES.has(status)) ? "blocked" : "queued";
}

export function readyNodeIds(workflow: WorkflowRun): string[] {
  return topologicalNodeIds(workflow.nodes).filter((id) => {
    const node = workflow.nodes[id];
    return node.status === "queued"
      && node.spec.dependsOn.every((dependency) => workflow.nodes[dependency]?.status === "succeeded");
  });
}

export function deriveWorkflowStatus(workflow: WorkflowRun): WorkflowRunStatus {
  const nodes = Object.values(workflow.nodes);
  if (nodes.every((node) => node.status === "succeeded")) return "succeeded";
  if (workflow.status === "awaiting_resume" || workflow.status === "paused" || workflow.status === "stopped") {
    return workflow.status;
  }
  if (nodes.some((node) => ["running", "launching", "pausing", "stopping"].includes(node.status))) return "active";
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

export function currentAttempt(node: WorkflowNode): NodeAttempt | undefined {
  return node.attempts.at(-1);
}
