import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { ActiveClock, countCompactions, estimateHistoricalActiveMs } from "../lib/dashboard/metrics.ts";
import { renderFooter } from "../lib/dashboard/footer.ts";
import { renderInlineAgentCard, type OrchestrationLifecycle } from "../lib/orchestration/ui.ts";
import {
  DIRECT_AGENT_INFO_CHANNEL,
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
  WORKFLOW_INFO_CHANNEL,
  emptyGitInfoState,
  emptyModelInfoState,
  isDirectAgentInfoState,
  isGitInfoState,
  isModelInfoState,
  isWorkflowInfoState,
  type DirectAgentInfoState,
  type WorkflowInfoState,
} from "../lib/dashboard/state.ts";

const ASYNC_STARTED = "subagent:async-started";
const ASYNC_COMPLETE = "subagent:async-complete";
const ASYNC_DASHBOARD_REFRESH = "subagent:dashboard-refresh";
const ASYNC_DASHBOARD_SNAPSHOT = "subagent:dashboard-snapshot";
const CONTROL_EVENT = "subagent:control-event";
const ATTENTION_WIDGET_KEY = "orchestration-attention";
const RENDER_INTERVAL_MS = 1_000;
const PERSIST_INTERVAL_MS = 10_000;

interface RoleNotification {
  agent: string;
  status: "completed" | "failed" | "paused";
  output: string;
  taskInfo?: string;
  durationMs?: number;
  session?: string;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((item): item is { type: "text"; text: string } =>
    record(item) && item.type === "text" && typeof item.text === "string",
  ).map((item) => item.text).join("\n");
}

function roleNotification(details: unknown, content: string): RoleNotification {
  if (record(details)
    && typeof details.agent === "string"
    && ["completed", "failed", "paused"].includes(String(details.status))) {
    return {
      agent: details.agent,
      status: details.status as RoleNotification["status"],
      output: typeof details.resultPreview === "string" ? details.resultPreview : content,
      ...(typeof details.taskInfo === "string" ? { taskInfo: details.taskInfo } : {}),
      ...(typeof details.durationMs === "number" ? { durationMs: details.durationMs } : {}),
      ...(typeof details.sessionValue === "string" ? { session: details.sessionValue } : {}),
    };
  }
  const lines = content.split("\n");
  const single = (lines[0] ?? "").match(/^Background task (completed|failed|paused): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/);
  if (single) {
    return {
      agent: single[2] ?? "Pi role agent",
      status: single[1] as RoleNotification["status"],
      taskInfo: single[3],
      output: lines.slice(2).join("\n").trim() || "(no output)",
    };
  }
  const grouped = (lines[0] ?? "").match(/^Background tasks completed \((\d+)\):/);
  return {
    agent: grouped ? `${grouped[1]} Pi role agents` : "Pi role agent",
    status: "completed",
    output: (grouped ? lines.slice(2) : lines).join("\n").trim() || "(no output)",
  };
}

function roleLifecycle(status: RoleNotification["status"]): OrchestrationLifecycle {
  if (status === "completed") return "done";
  if (status === "paused") return "paused";
  return "failed";
}

export function registerRoleMessageRenderers(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
  pi.registerMessageRenderer("subagent-notify", (message, { expanded }, theme) => {
    const content = messageText(message.content);
    const details = roleNotification(message.details, content);
    return renderInlineAgentCard(theme, {
      lifecycle: roleLifecycle(details.status),
      title: details.agent,
      kind: "role agent",
      harness: "Pi",
      activity: `${details.status}${details.taskInfo ? ` · ${details.taskInfo}` : ""}`,
      output: details.output,
      metadata: [
        details.durationMs !== undefined ? `${Math.round(details.durationMs / 1000)}s` : "",
        details.session ?? "",
      ].filter(Boolean),
    }, expanded);
  });

  pi.registerMessageRenderer("subagent_control_notice", (message, { expanded }, theme) => {
    const details = record(message.details) ? message.details : {};
    const event = record(details.event) ? details.event : {};
    const agent = typeof event.agent === "string" ? event.agent : "Pi role agent";
    const content = messageText(message.content);
    const activity = typeof event.message === "string" ? event.message : content || "inspect the role agent";
    return renderInlineAgentCard(theme, {
      lifecycle: "attention",
      title: agent,
      kind: "role agent",
      harness: "Pi",
      identity: typeof event.runId === "string" ? event.runId : undefined,
      activity,
      output: content || activity,
      metadata: [
        typeof event.reason === "string" ? event.reason : "",
        typeof event.currentTool === "string" ? event.currentTool : "",
        typeof event.currentPath === "string" ? event.currentPath : "",
      ].filter(Boolean),
    }, expanded);
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function foregroundCount(args: unknown): number {
  if (!record(args) || args.async === true) return 0;
  if (typeof args.action === "string" && args.action !== "single") return 0;
  const taskCount = (task: unknown) => record(task) && typeof task.count === "number" && Number.isInteger(task.count) && task.count >= 1 ? task.count : 1;
  if (Array.isArray(args.tasks)) return Math.max(1, args.tasks.reduce((total, task) => total + taskCount(task), 0));
  if (Array.isArray(args.chain)) {
    const first = args.chain[0];
    return record(first) && Array.isArray(first.parallel)
      ? Math.max(1, first.parallel.reduce((total, task) => total + taskCount(task), 0))
      : 1;
  }
  return typeof args.agent === "string" ? 1 : 0;
}

function asyncCount(event: Record<string, unknown>): number {
  if (event.mode !== "parallel") return 1;
  const firstGroup = Array.isArray(event.parallelGroups) ? event.parallelGroups.find((group) => record(group) && group.stepIndex === 0) : undefined;
  return record(firstGroup) && typeof firstGroup.count === "number" ? Math.max(1, firstGroup.count) : 1;
}

function loadActiveMs(file: string, entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>): number {
  if (!existsSync(file)) return estimateHistoricalActiveMs(entries);
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { activeMs?: unknown };
    return typeof value.activeMs === "number" && value.activeMs >= 0 ? value.activeMs : estimateHistoricalActiveMs(entries);
  } catch {
    return estimateHistoricalActiveMs(entries);
  }
}

export default function uiDashboard(pi: ExtensionAPI, metricsRoot = join(getAgentDir(), "dashboard-session-metrics")) {
  registerRoleMessageRenderers(pi);
  let ctx: ExtensionContext | undefined;
  let model = emptyModelInfoState();
  let git = emptyGitInfoState();
  let workflows: WorkflowInfoState = { active: 0, runningAgents: 0 };
  let directAgents: DirectAgentInfoState = { runningAgents: 0 };
  let clock = new ActiveClock();
  let compactions = 0;
  let rootActive = false;
  let stateFile: string | undefined;
  let renderTimer: ReturnType<typeof setInterval> | undefined;
  let lastPersistedAt = 0;
  let requestRender: (() => void) | undefined;
  let asyncSnapshot = 0;
  let busUnsubscribes: Array<() => void> = [];
  const foreground = new Map<string, number>();
  const asyncRuns = new Map<string, number>();
  const attention = new Map<string, { source?: string; agent: string; message: string }>();
  let attentionWidgetSignature = "";

  const runningSubagents = () => {
    const foregroundTotal = [...foreground.values()].reduce((total, count) => total + count, 0);
    const eventTotal = [...asyncRuns.values()].reduce((total, count) => total + count, 0);
    return foregroundTotal + Math.max(eventTotal, asyncSnapshot);
  };

  function syncClock(now = Date.now()): void {
    clock.setActive(rootActive || runningSubagents() > 0 || workflows.runningAgents > 0 || directAgents.runningAgents > 0, now);
  }

  function persist(now = Date.now()): void {
    if (!stateFile) return;
    mkdirSync(dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ activeMs: clock.value(now), updatedAt: now })}\n`, "utf8");
    renameSync(temporary, stateFile);
    lastPersistedAt = now;
  }

  const handleModelInfo = (value: unknown) => {
    if (!isModelInfoState(value)) return;
    model = value;
    requestRender?.();
  };

  const handleGitInfo = (value: unknown) => {
    if (!isGitInfoState(value)) return;
    git = value;
    requestRender?.();
  };

  const updateAttentionWidget = () => {
    if (!ctx || ctx.mode !== "tui") return;
    const workflowAttention = workflows.attention ?? 0;
    const count = Math.max(attention.size, workflowAttention) + (directAgents.attention ?? 0);
    const latest = [...attention.values()].at(-1);
    const signature = `${count}:${latest?.agent ?? ""}:${latest?.message ?? ""}`;
    if (signature === attentionWidgetSignature) return;
    attentionWidgetSignature = signature;
    if (count === 0) {
      ctx.ui.setWidget(ATTENTION_WIDGET_KEY, undefined);
      return;
    }
    ctx.ui.setWidget(ATTENTION_WIDGET_KEY, (_tui, theme) => ({
      render(width: number) {
        const subject = latest ? `${latest.agent}: ${latest.message}` : "workflow node needs attention · /fleet inspect";
        return [truncateToWidth(`${theme.fg("warning", "! ")}${theme.bold(`${count} ${count === 1 ? "agent needs" : "agents need"} attention`)} ${theme.fg("muted", `· ${subject}`)}`, width, "…", true)];
      },
      invalidate() {},
    }));
  };

  const handleWorkflowInfo = (value: unknown) => {
    if (!isWorkflowInfoState(value)) return;
    workflows = value;
    syncClock();
    updateAttentionWidget();
    requestRender?.();
  };

  const handleDirectAgentInfo = (value: unknown) => {
    if (!isDirectAgentInfoState(value)) return;
    directAgents = value;
    syncClock();
    updateAttentionWidget();
    requestRender?.();
  };

  const handleControlEvent = (value: unknown) => {
    if (!record(value) || !record(value.event) || value.event.type !== "needs_attention") return;
    const runId = typeof value.event.runId === "string" ? value.event.runId : undefined;
    if (!runId) return;
    attention.set(runId, {
      source: typeof value.source === "string" ? value.source : undefined,
      agent: typeof value.event.agent === "string" ? value.event.agent : "agent",
      message: typeof value.event.message === "string" ? value.event.message : "inspect the run",
    });
    updateAttentionWidget();
    requestRender?.();
  };

  const handleAsyncStarted = (value: unknown) => {
    if (!ctx || !record(value) || value.sessionId !== ctx.sessionManager.getSessionId() || typeof value.id !== "string") return;
    asyncRuns.set(value.id, asyncCount(value));
    syncClock();
    requestRender?.();
  };

  const handleAsyncComplete = (value: unknown) => {
    if (!ctx || !record(value) || (typeof value.sessionId === "string" && value.sessionId !== ctx.sessionManager.getSessionId())) return;
    const id = typeof value.runId === "string" ? value.runId : typeof value.id === "string" ? value.id : undefined;
    if (!id) return;
    asyncRuns.delete(id);
    attention.delete(id);
    syncClock();
    updateAttentionWidget();
    requestRender?.();
  };

  const handleAsyncSnapshot = (value: unknown) => {
    if (!ctx || !record(value) || value.sessionId !== ctx.sessionManager.getSessionId() || typeof value.runningAgents !== "number") return;
    asyncSnapshot = Math.max(0, value.runningAgents);
    syncClock();
    requestRender?.();
  };

  function subscribeBus(): void {
    for (const unsubscribe of busUnsubscribes) unsubscribe();
    busUnsubscribes = [
      pi.events.on(MODEL_INFO_CHANNEL, handleModelInfo),
      pi.events.on(GIT_INFO_CHANNEL, handleGitInfo),
      pi.events.on(WORKFLOW_INFO_CHANNEL, handleWorkflowInfo),
      pi.events.on(DIRECT_AGENT_INFO_CHANNEL, handleDirectAgentInfo),
      pi.events.on(ASYNC_STARTED, handleAsyncStarted),
      pi.events.on(ASYNC_COMPLETE, handleAsyncComplete),
      pi.events.on(ASYNC_DASHBOARD_SNAPSHOT, handleAsyncSnapshot),
      pi.events.on(CONTROL_EVENT, handleControlEvent),
    ];
  }

  pi.on("session_start", (_event, nextCtx) => {
    ctx = nextCtx;
    model = emptyModelInfoState();
    git = emptyGitInfoState();
    workflows = { active: 0, runningAgents: 0 };
    directAgents = { runningAgents: 0 };
    rootActive = false;
    foreground.clear();
    asyncRuns.clear();
    attention.clear();
    attentionWidgetSignature = "";
    asyncSnapshot = 0;
    subscribeBus();
    const entries = nextCtx.sessionManager.getBranch();
    compactions = countCompactions(entries);
    stateFile = join(metricsRoot, `${nextCtx.sessionManager.getSessionId()}.json`);
    clock = new ActiveClock(loadActiveMs(stateFile, entries));

    if (renderTimer) clearInterval(renderTimer);
    if (nextCtx.mode === "tui") {
      nextCtx.ui.setFooter((tui, theme, footerData) => {
        requestRender = () => tui.requestRender();
        return {
          invalidate() {},
          render(width: number) {
            return renderFooter({
              cwd: nextCtx.cwd,
              model,
              git,
              metrics: { activeMs: clock.value(), compactions, runningSubagents: runningSubagents() },
              workflows,
              directAgents,
              attention: attention.size,
            }, footerData, theme, width);
          },
        };
      });
    }

    renderTimer = setInterval(() => {
      const now = Date.now();
      if (clock.isActive()) requestRender?.();
      if (now - lastPersistedAt >= PERSIST_INTERVAL_MS) persist(now);
    }, RENDER_INTERVAL_MS);
    pi.events.emit(REFRESH_CHANNEL, undefined);
    pi.events.emit(ASYNC_DASHBOARD_REFRESH, undefined);
  });

  pi.on("agent_start", () => {
    rootActive = true;
    syncClock();
  });

  pi.on("agent_settled", () => {
    rootActive = false;
    syncClock();
    persist();
  });

  pi.on("session_compact", (_event, eventCtx) => {
    compactions = countCompactions(eventCtx.sessionManager.getBranch());
    requestRender?.();
  });

  pi.on("tool_execution_start", (event) => {
    if (event.toolName !== "subagent") return;
    const count = foregroundCount(event.args);
    if (count === 0) return;
    foreground.set(event.toolCallId, count);
    syncClock();
    requestRender?.();
  });

  pi.on("tool_execution_end", (event) => {
    if (!foreground.delete(event.toolCallId)) return;
    for (const [runId, item] of attention) {
      if (item.source === "foreground") attention.delete(runId);
    }
    syncClock();
    updateAttentionWidget();
    requestRender?.();
  });

  pi.on("session_shutdown", (_event, shutdownCtx) => {
    rootActive = false;
    foreground.clear();
    asyncRuns.clear();
    asyncSnapshot = 0;
    workflows = { active: 0, runningAgents: 0 };
    directAgents = { runningAgents: 0 };
    attention.clear();
    attentionWidgetSignature = "";
    if (shutdownCtx.mode === "tui") shutdownCtx.ui.setWidget(ATTENTION_WIDGET_KEY, undefined);
    syncClock();
    persist();
    if (renderTimer) clearInterval(renderTimer);
    renderTimer = undefined;
    requestRender = undefined;
    for (const unsubscribe of busUnsubscribes) unsubscribe();
    busUnsubscribes = [];
    stateFile = undefined;
    ctx = undefined;
    if (shutdownCtx.mode === "tui") shutdownCtx.ui.setFooter(undefined);
  });
}
