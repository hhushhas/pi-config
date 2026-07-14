import { homedir } from "node:os";
import { relative } from "node:path";
import type { ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration, type SessionMetricsSnapshot } from "./metrics.ts";
import type { GitInfoState, ModelInfoState, WorkflowInfoState } from "./state.ts";

export interface DashboardSnapshot {
  cwd: string;
  model: ModelInfoState;
  git: GitInfoState;
  metrics: SessionMetricsSnapshot;
  workflows: WorkflowInfoState;
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function formatDirectory(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
}

export function columns(left: string, right: string, width: number): string {
  if (!right) return truncateToWidth(left, width);
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap >= 1) return `${left}${" ".repeat(gap)}${right}`;
  const leftWidth = Math.max(1, Math.floor(width * 0.45));
  const fittedLeft = truncateToWidth(left, leftWidth);
  const fittedRight = truncateToWidth(right, Math.max(1, width - leftWidth - 1));
  return `${fittedLeft}${" ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(fittedRight)))}${fittedRight}`;
}

function usage(model: ModelInfoState): string {
  const percent = model.contextPercent === null ? "?" : `${Math.round(model.contextPercent)}`;
  const context = model.contextWindow > 0 ? formatTokens(model.contextWindow) : "?";
  const speed = model.tokensPerSecond === null ? "— tok/s" : `${Math.round(model.tokensPerSecond)} tok/s`;
  return `${percent}%/${context} · $${model.cost.toFixed(2)} · ${speed}`;
}

function gitSummary(git: GitInfoState): string {
  if (!git.branch) return "";
  const changed = `${git.changedFiles} ${git.changedFiles === 1 ? "file" : "files"} changed`;
  if (!git.pullRequest) return `${git.branch} · ${changed}`;
  const label = `PR #${git.pullRequest.number}`;
  const pullRequest = getCapabilities().hyperlinks ? hyperlink(label, git.pullRequest.url) : label;
  return `${git.branch} · ${changed} · ${pullRequest}`;
}

function orchestration(snapshot: DashboardSnapshot, theme: Theme): string {
  const agents = Math.max(snapshot.metrics.runningSubagents, snapshot.workflows.runningAgents);
  const agentText = agents > 0 ? `${agents} ${agents === 1 ? "agent" : "agents"}` : "";
  if (snapshot.workflows.active === 0) return agentText ? theme.fg("accent", `● ${agentText}`) : "";

  const workflowText = snapshot.workflows.active === 1 && snapshot.workflows.name
    ? `${snapshot.workflows.name}${snapshot.workflows.completed !== undefined && snapshot.workflows.total !== undefined ? ` ${snapshot.workflows.completed}/${snapshot.workflows.total}` : ""}`
    : `${snapshot.workflows.active} workflows`;
  return theme.fg("accent", `● ${agentText ? `${agentText} · ` : ""}${workflowText}`);
}

export function renderFooter(snapshot: DashboardSnapshot, footerData: ReadonlyFooterDataProvider, theme: Theme, width: number): string[] {
  const model = snapshot.model.provider ? `${snapshot.model.provider}/${snapshot.model.modelId} · ${snapshot.model.thinking}` : snapshot.model.modelId;
  const session = `active ${formatDuration(snapshot.metrics.activeMs)} · compact ${snapshot.metrics.compactions}`;
  const lines = [
    columns(theme.fg("text", formatDirectory(snapshot.cwd)), theme.fg("muted", model), width),
    columns(theme.fg("muted", usage(snapshot.model)), theme.fg("muted", gitSummary(snapshot.git)), width),
    columns(theme.fg("dim", session), orchestration(snapshot, theme), width),
  ];

  for (const [key, text] of [...footerData.getExtensionStatuses()].sort(([a], [b]) => a.localeCompare(b))) {
    if (key === "dag-workflows" && snapshot.workflows.active > 0) continue;
    for (const statusLine of text.split("\n")) lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
  }
  return lines;
}
