export const MODEL_INFO_CHANNEL = "dashboard:model-info";
export const GIT_INFO_CHANNEL = "dashboard:git-info";
export const REFRESH_CHANNEL = "dashboard:refresh";
export const WORKFLOW_INFO_CHANNEL = "dashboard:workflow-info";

export interface ModelInfoState {
  provider: string;
  modelId: string;
  thinking: string;
  contextWindow: number;
  contextPercent: number | null;
  cost: number;
  tokensPerSecond: number | null;
}

export interface GitInfoState {
  branch: string | null;
  changedFiles: number;
  pullRequest: { number: number; url: string } | null;
}

export interface WorkflowInfoState {
  active: number;
  runningAgents: number;
  name?: string;
  completed?: number;
  total?: number;
}

export function emptyModelInfoState(): ModelInfoState {
  return {
    provider: "",
    modelId: "no-model",
    thinking: "off",
    contextWindow: 0,
    contextPercent: null,
    cost: 0,
    tokensPerSecond: null,
  };
}

export function emptyGitInfoState(): GitInfoState {
  return { branch: null, changedFiles: 0, pullRequest: null };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isModelInfoState(value: unknown): value is ModelInfoState {
  return record(value)
    && typeof value.provider === "string"
    && typeof value.modelId === "string"
    && typeof value.thinking === "string"
    && typeof value.contextWindow === "number"
    && (value.contextPercent === null || typeof value.contextPercent === "number")
    && typeof value.cost === "number"
    && (value.tokensPerSecond === null || typeof value.tokensPerSecond === "number");
}

export function isGitInfoState(value: unknown): value is GitInfoState {
  if (!record(value) || (value.branch !== null && typeof value.branch !== "string") || typeof value.changedFiles !== "number") return false;
  return value.pullRequest === null || (record(value.pullRequest) && typeof value.pullRequest.number === "number" && typeof value.pullRequest.url === "string");
}

export function isWorkflowInfoState(value: unknown): value is WorkflowInfoState {
  return record(value)
    && typeof value.active === "number"
    && typeof value.runningAgents === "number"
    && (value.name === undefined || typeof value.name === "string")
    && (value.completed === undefined || typeof value.completed === "number")
    && (value.total === undefined || typeof value.total === "number");
}
