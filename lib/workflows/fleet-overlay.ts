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
  isControllable(workflowId: string): boolean;
  subscribe(listener: () => void): () => void;
  resume(workflowId: string, nodeId: string): Promise<void>;
  pause(workflowId: string): Promise<void>;
  stopNode(workflowId: string, nodeId: string): Promise<void>;
  retryNode(workflowId: string, nodeId: string): Promise<void>;
  takeover(workflowId: string, confirmation: { revision: number; leaseId: string; leaseEpoch: number; ownerProcessId?: number }): Promise<void>;
  confirm(title: string, message: string): Promise<boolean>;
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
  invalidated: "×",
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
  private showHistory = false;
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
    if (matchesKey(data, "h")) {
      this.showHistory = !this.showHistory;
      this.clampSelection();
      this.tui.requestRender();
      return;
    }

    const selected = this.entries()[this.selected];
    if (!selected || this.actionRunning) return;
    const attempt = currentAttempt(selected.node);
    const controllable = this.actions.isControllable(selected.workflow.id);
    const foreign = !controllable;
    if (matchesKey(data, "u")) {
      if (!controllable || selected.node.status !== "paused" || !attempt || attempt.kind === "legacy") return this.actions.notify("Resume is available only for a locally owned, confirmed paused authoritative v2 attempt.", "warning");
      void this.runAction(() => this.actions.resume(selected.workflow.id, selected.node.spec.id));
    } else if (matchesKey(data, "p")) {
      if (foreign || selected.node.status !== "running" || !attempt || attempt.kind === "legacy") return this.actions.notify("Pause is disabled for foreign, legacy, stale, or non-running attempts.", "warning");
      void this.runAction(() => this.actions.pause(selected.workflow.id));
    } else if (matchesKey(data, "r")) {
      if (!controllable || !attempt || attempt.kind === "legacy" || !["succeeded", "failed", "paused", "stopped"].includes(selected.node.status)) return this.actions.notify("Retry is disabled for foreign, legacy, live, stale, or non-terminal attempts.", "warning");
      void this.runAction(async () => {
        const confirmed = await this.actions.confirm("Retry node?", `Retry '${selected.node.spec.id}' and invalidate all descendant successes?`);
        if (confirmed) await this.actions.retryNode(selected.workflow.id, selected.node.spec.id);
      });
    } else if (matchesKey(data, "x")) {
      if (foreign || !["running", "launching"].includes(selected.node.status) || !attempt || attempt.kind === "legacy") return this.actions.notify("Stop is disabled for foreign, legacy, stale, or non-live attempts.", "warning");
      void this.runAction(async () => {
        const confirmed = await this.actions.confirm("Stop node?", `Stop authoritative run ${attempt.packageRunId ?? "unknown"}?`);
        if (confirmed) await this.actions.stopNode(selected.workflow.id, selected.node.spec.id);
      });
    } else if (matchesKey(data, "t")) {
      if (!foreign) return this.actions.notify("This workflow is already locally owned.", "warning");
      void this.runAction(async () => {
        const workflow = selected.workflow;
        const confirmed = await this.actions.confirm("Take over workflow?", `Take over ${workflow.id} only if owner PID ${workflow.ownerProcessId ?? "unknown"} is dead?`);
        if (confirmed) await this.actions.takeover(workflow.id, { revision: workflow.stateRevision, leaseId: workflow.ownerLeaseId, leaseEpoch: workflow.ownerLeaseEpoch, ownerProcessId: workflow.ownerProcessId });
      });
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 2);
    const entries = this.entries();
    const selected = entries[this.selected];
    const all = this.actions.snapshot();
    const live = all.flatMap((workflow) => Object.values(workflow.nodes)).filter((node) => ["launching", "running", "pausing", "stopping"].includes(node.status)).length;
    const attention = all.flatMap((workflow) => Object.values(workflow.nodes)).filter((node) => currentAttempt(node)?.telemetry?.activityState === "needs_attention").length;
    const recorded = all.flatMap((workflow) => Object.values(workflow.nodes)).reduce((sum, node) => sum + node.attempts.length, 0);
    const external = all.reduce((sum, workflow) => sum + (workflow.externalEvidence?.length ?? 0), 0);
    const title = ` Fleet · ${live} live · ${attention} attention · ${recorded} recorded · ${external} external · ${all.length} workflows `;
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
    lines.push(this.row(this.theme.fg("dim", ` ↑↓ select · tab pane · h history · u resume · p pause · r retry · x stop · t takeover · esc close${busy}`), innerWidth));
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
    return this.actions.snapshot().filter((workflow) => this.showHistory || !["succeeded", "stopped"].includes(workflow.status)).flatMap((workflow) => topologicalNodeIds(workflow.nodes).map((id) => ({
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
    const snapshot = attempt?.telemetry;
    const startedAt = attempt?.startedAt ?? snapshot?.startedAt;
    const endedAt = attempt?.endedAt ?? snapshot?.endedAt;
    const elapsed = startedAt ? (endedAt ?? Date.now()) - startedAt : undefined;
    const tokens = snapshot?.totalTokens;
    const cost = snapshot?.totalCost;
    const outputRate = tokens?.output && elapsed ? tokens.output / (elapsed / 1000) : undefined;
    const foreign = !this.actions.isControllable(workflow.id);
    const status = effectiveNodeStatus(workflow, node);
    const lines = [
      this.theme.bold(` ${node.spec.label ?? node.spec.id}`),
      ` ${this.statusColor(status, `${GLYPHS[status]} ${status}`)}${snapshot?.activityState === "needs_attention" ? " · attention" : ""} · ${node.spec.agent}`,
      ` deps       ${node.spec.dependsOn.join(", ") || "none"}`,
      ` lineage    ${attempt?.kind ?? "none"}${attempt && attempt.kind !== "legacy" && attempt.previousAttemptId ? ` ← ${attempt.previousAttemptId}` : ""}`,
      ` attempts   ${node.attempts.length} recorded · ${Math.max(0, node.attempts.length - 1)} superseded`,
      ` provenance ${attempt?.id ?? "—"}${attempt && attempt.kind !== "legacy" ? ` · lease ${attempt.launchLeaseEpoch}` : ""}`,
      ` authority  ${foreign ? "foreign-owned · read-only" : attempt?.kind === "legacy" ? "legacy · read-only" : "authoritative"}`,
      ` run        ${attempt?.packageRunId ?? "—"}`,
      ` cwd        ${node.spec.cwd ? `${workflow.executionCwd}/${node.spec.cwd}` : workflow.executionCwd}`,
      ` model      ${snapshot?.model ?? node.spec.model ?? "inherited"} · ${snapshot?.thinking ?? node.spec.thinking ?? "role default"}`,
      ` elapsed    ${formatDuration(elapsed)} · TTFB —`,
      ` tokens     ${formatTokens(tokens?.input)} in · ${formatTokens(tokens?.output)} out · ${formatTokens(tokens?.total)} total`,
      ` speed      ${outputRate === undefined ? "—" : `${outputRate.toFixed(1)} output tok/s`}`,
      ` cost       ${cost ? `$${cost.costUsd.toFixed(4)}` : "—"}`,
      ` steps      ${snapshot?.turnCount ?? "—"} turns · ${snapshot?.toolCount ?? "—"} tools`,
      ` current    ${snapshot?.currentTool ?? "—"}${snapshot?.currentPath ? ` · ${snapshot.currentPath}` : ""}`,
      ` terminal   ${snapshot?.terminalReason ?? "—"}${snapshot?.terminalControlRequestId ? ` · ${snapshot.terminalControlRequestId}` : ""}`,
      ` external   ${workflow.externalEvidence?.filter((item) => item.sessionFile === attempt?.childSessionFile).length ?? 0} read-only related runs`,
      this.theme.fg("borderMuted", " artifact"),
      ` ${this.theme.fg("dim", attempt?.asyncDir ?? "No runtime artifact yet.")}`,
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
