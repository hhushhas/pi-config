import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  currentAttempt,
  effectiveNodeStatus,
  topologicalNodeIds,
  type WorkflowNode,
  type WorkflowRun,
} from "./model.ts";

export interface FleetActions {
  snapshot(): WorkflowRun[];
  subscribe(listener: () => void): () => void;
  resume(workflowId: string): Promise<void>;
  pause(workflowId: string): Promise<void>;
  stopNode(workflowId: string, nodeId: string): Promise<void>;
  retryNode(workflowId: string, nodeId: string): Promise<void>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

interface NodeRef {
  workflow: WorkflowRun;
  node: WorkflowNode;
}

const GLYPHS: Record<string, string> = {
  queued: "○",
  blocked: "◆",
  launching: "◐",
  running: "●",
  pausing: "◑",
  stopping: "◒",
  succeeded: "✓",
  failed: "✗",
  paused: "Ⅱ",
  orphaned: "?",
  stopped: "■",
};

function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined || milliseconds < 0) return "—";
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined) return "—";
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function padAnsi(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "…", true);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export class FleetOverlay implements Component {
  private selected = 0;
  private detailsOnly = false;
  private disposed = false;
  private actionRunning = false;
  private readonly unsubscribe: () => void;
  private readonly renderTimer: NodeJS.Timeout;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
    private readonly actions: FleetActions,
  ) {
    this.unsubscribe = actions.subscribe(() => {
      if (this.disposed) return;
      this.clampSelection();
      this.tui.requestRender();
    });
    this.renderTimer = setInterval(() => {
      if (!this.disposed) this.tui.requestRender();
    }, 1000);
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.selected = Math.max(0, this.selected - 1);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.selected = Math.min(Math.max(0, this.entries().length - 1), this.selected + 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "tab")) {
      this.detailsOnly = !this.detailsOnly;
      this.tui.requestRender();
      return;
    }

    const selected = this.entries()[this.selected];
    if (!selected || this.actionRunning) return;
    if (matchesKey(data, "u")) void this.runAction(() => this.actions.resume(selected.workflow.id));
    else if (matchesKey(data, "p")) void this.runAction(() => this.actions.pause(selected.workflow.id));
    else if (matchesKey(data, "r")) void this.runAction(() => this.actions.retryNode(selected.workflow.id, selected.node.spec.id));
    else if (matchesKey(data, "x")) void this.runAction(() => this.actions.stopNode(selected.workflow.id, selected.node.spec.id));
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 2);
    const entries = this.entries();
    const selected = entries[this.selected];
    const title = ` Fleet · ${this.actions.snapshot().length} workflows · ${entries.length} agents `;
    const lines = [
      this.border("╭") + this.theme.fg("accent", padAnsi(title, innerWidth)) + this.border("╮"),
    ];

    if (!selected) {
      lines.push(this.row(this.theme.fg("muted", " No workflow runs yet."), innerWidth));
    } else if (width >= 100 && !this.detailsOnly) {
      lines.push(...this.renderWide(entries, selected, innerWidth));
    } else if (this.detailsOnly) {
      lines.push(...this.renderDetails(selected, innerWidth, 18).map((line) => this.row(line, innerWidth)));
    } else {
      lines.push(...this.renderList(entries, innerWidth, 15).map((line) => this.row(line, innerWidth)));
      lines.push(this.row(this.theme.fg("borderMuted", "─".repeat(innerWidth)), innerWidth));
      lines.push(...this.renderDetails(selected, innerWidth, 7).map((line) => this.row(line, innerWidth)));
    }

    const busy = this.actionRunning ? " · action running" : "";
    lines.push(this.row(this.theme.fg("dim", ` ↑↓ select · tab pane · u resume · p pause · r retry · x stop · esc close${busy}`), innerWidth));
    lines.push(this.border("╰") + this.border("─".repeat(innerWidth)) + this.border("╯"));
    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    this.disposed = true;
    clearInterval(this.renderTimer);
    this.unsubscribe();
  }

  private entries(): NodeRef[] {
    return this.actions.snapshot().flatMap((workflow) => topologicalNodeIds(workflow.nodes).map((id) => ({
      workflow,
      node: workflow.nodes[id],
    })));
  }

  private renderWide(entries: NodeRef[], selected: NodeRef, width: number): string[] {
    const leftWidth = Math.max(36, Math.floor(width * 0.48));
    const rightWidth = width - leftWidth - 1;
    const left = this.renderList(entries, leftWidth, 20);
    const right = this.renderDetails(selected, rightWidth, 20);
    const height = Math.max(left.length, right.length);
    return Array.from({ length: height }, (_, index) => this.row(
      `${padAnsi(left[index] ?? "", leftWidth)}${this.theme.fg("borderMuted", "│")}${padAnsi(right[index] ?? "", rightWidth)}`,
      width,
    ));
  }

  private renderList(entries: NodeRef[], width: number, limit: number): string[] {
    const start = Math.max(0, Math.min(this.selected - Math.floor(limit / 2), entries.length - limit));
    let previousWorkflow = "";
    const lines: string[] = [];
    for (let index = start; index < Math.min(entries.length, start + limit); index++) {
      const entry = entries[index];
      if (entry.workflow.id !== previousWorkflow) {
        lines.push(this.theme.bold(` ${entry.workflow.name}  ${this.theme.fg("dim", entry.workflow.status)}`));
        previousWorkflow = entry.workflow.id;
      }
      const status = effectiveNodeStatus(entry.workflow, entry.node);
      const dependency = entry.node.spec.dependsOn.length > 0 ? ` ← ${entry.node.spec.dependsOn.join(",")}` : "";
      const label = entry.node.spec.label ?? entry.node.spec.id;
      const text = ` ${GLYPHS[status] ?? "?"} ${label}${dependency}`;
      const colored = this.statusColor(status, text);
      lines.push(index === this.selected ? this.theme.bg("selectedBg", padAnsi(colored, width)) : colored);
    }
    return lines;
  }

  private renderDetails({ workflow, node }: NodeRef, width: number, limit: number): string[] {
    const attempt = currentAttempt(node);
    const snapshot = attempt?.statusSnapshot;
    const step = snapshot?.steps?.[0];
    const startedAt = attempt?.startedAt ?? snapshot?.startedAt;
    const endedAt = attempt?.endedAt ?? snapshot?.endedAt;
    const elapsed = startedAt ? (endedAt ?? Date.now()) - startedAt : undefined;
    const tokens = snapshot?.totalTokens ?? step?.tokens;
    const cost = snapshot?.totalCost ?? step?.totalCost;
    const outputRate = tokens?.output && elapsed ? tokens.output / (elapsed / 1000) : undefined;
    const logs = step?.recentOutput?.slice(-Math.max(1, limit - 11)) ?? [];
    const status = effectiveNodeStatus(workflow, node);
    const lines = [
      this.theme.bold(` ${node.spec.label ?? node.spec.id}`),
      ` ${this.statusColor(status, `${GLYPHS[status]} ${status}`)} · ${node.spec.agent}`,
      ` deps       ${node.spec.dependsOn.join(", ") || "none"}`,
      ` model      ${step?.model ?? node.spec.model ?? "inherited"} · ${step?.thinking ?? node.spec.thinking ?? "role default"}`,
      ` elapsed    ${formatDuration(elapsed)} · TTFB —`,
      ` tokens     ${formatTokens(tokens?.input)} in · ${formatTokens(tokens?.output)} out · ${formatTokens(tokens?.total)} total`,
      ` speed      ${outputRate === undefined ? "—" : `${outputRate.toFixed(1)} output tok/s`}`,
      ` cost       ${cost ? `$${cost.costUsd.toFixed(4)}` : "—"}`,
      ` steps      ${snapshot?.turnCount ?? step?.turnCount ?? "—"} turns · ${snapshot?.toolCount ?? step?.toolCount ?? "—"} tools`,
      ` current    ${snapshot?.currentTool ?? step?.currentTool ?? "—"}${snapshot?.currentPath ?? step?.currentPath ? ` · ${snapshot?.currentPath ?? step?.currentPath}` : ""}`,
      this.theme.fg("borderMuted", " log tail"),
      ...(logs.length > 0 ? logs.map((line) => ` ${this.theme.fg("dim", line)}`) : [` ${this.theme.fg("muted", "No output yet.")}`]),
    ];
    return lines.slice(0, limit).map((line) => truncateToWidth(line, width, "…", true));
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    this.actionRunning = true;
    this.tui.requestRender();
    try {
      await action();
    } catch (error) {
      this.actions.notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.actionRunning = false;
      if (!this.disposed) this.tui.requestRender();
    }
  }

  private clampSelection(): void {
    this.selected = Math.min(this.selected, Math.max(0, this.entries().length - 1));
  }

  private statusColor(status: string, text: string): string {
    if (status === "succeeded") return this.theme.fg("success", text);
    if (status === "failed" || status === "orphaned" || status === "stopped") return this.theme.fg("error", text);
    if (status === "running" || status === "launching" || status === "pausing" || status === "stopping") return this.theme.fg("accent", text);
    if (status === "blocked" || status === "paused") return this.theme.fg("warning", text);
    return this.theme.fg("muted", text);
  }

  private row(text: string, width: number): string {
    return this.border("│") + padAnsi(text, width) + this.border("│");
  }

  private border(text: string): string {
    return this.theme.fg("border", text);
  }
}
