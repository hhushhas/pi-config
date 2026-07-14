import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ActiveClock, countCompactions, estimateHistoricalActiveMs } from "../lib/dashboard/metrics.ts";
import { renderFooter } from "../lib/dashboard/footer.ts";
import {
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
  WORKFLOW_INFO_CHANNEL,
  emptyGitInfoState,
  emptyModelInfoState,
  isGitInfoState,
  isModelInfoState,
  isWorkflowInfoState,
  type WorkflowInfoState,
} from "../lib/dashboard/state.ts";

const ASYNC_STARTED = "subagent:async-started";
const ASYNC_COMPLETE = "subagent:async-complete";
const RENDER_INTERVAL_MS = 1_000;
const PERSIST_INTERVAL_MS = 10_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function foregroundCount(args: unknown): number {
  if (!record(args) || args.async === true) return 0;
  if (typeof args.action === "string" && args.action !== "single") return 0;
  if (Array.isArray(args.tasks)) return Math.max(1, args.tasks.length);
  if (Array.isArray(args.chain)) {
    const first = args.chain[0];
    return record(first) && Array.isArray(first.parallel) ? Math.max(1, first.parallel.length) : 1;
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

export default function uiDashboard(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let model = emptyModelInfoState();
  let git = emptyGitInfoState();
  let workflows: WorkflowInfoState = { active: 0, runningAgents: 0 };
  let clock = new ActiveClock();
  let compactions = 0;
  let rootActive = false;
  let stateFile: string | undefined;
  let renderTimer: ReturnType<typeof setInterval> | undefined;
  let lastPersistedAt = 0;
  let requestRender: (() => void) | undefined;
  const foreground = new Map<string, number>();
  const asyncRuns = new Map<string, number>();

  const runningSubagents = () => [...foreground.values(), ...asyncRuns.values()].reduce((total, count) => total + count, 0);

  function syncClock(now = Date.now()): void {
    clock.setActive(rootActive || runningSubagents() > 0 || workflows.runningAgents > 0, now);
  }

  function persist(now = Date.now()): void {
    if (!stateFile) return;
    mkdirSync(dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ activeMs: clock.value(now), updatedAt: now })}\n`, "utf8");
    renameSync(temporary, stateFile);
    lastPersistedAt = now;
  }

  pi.events.on(MODEL_INFO_CHANNEL, (value) => {
    if (!isModelInfoState(value)) return;
    model = value;
    requestRender?.();
  });

  pi.events.on(GIT_INFO_CHANNEL, (value) => {
    if (!isGitInfoState(value)) return;
    git = value;
    requestRender?.();
  });

  pi.events.on(WORKFLOW_INFO_CHANNEL, (value) => {
    if (!isWorkflowInfoState(value)) return;
    workflows = value;
    syncClock();
    requestRender?.();
  });

  pi.events.on(ASYNC_STARTED, (value) => {
    if (!ctx || !record(value) || value.sessionId !== ctx.sessionManager.getSessionId() || typeof value.id !== "string") return;
    asyncRuns.set(value.id, asyncCount(value));
    syncClock();
    requestRender?.();
  });

  pi.events.on(ASYNC_COMPLETE, (value) => {
    if (!ctx || !record(value) || (typeof value.sessionId === "string" && value.sessionId !== ctx.sessionManager.getSessionId())) return;
    const id = typeof value.runId === "string" ? value.runId : typeof value.id === "string" ? value.id : undefined;
    if (!id) return;
    asyncRuns.delete(id);
    syncClock();
    requestRender?.();
  });

  pi.on("session_start", (_event, nextCtx) => {
    ctx = nextCtx;
    model = emptyModelInfoState();
    git = emptyGitInfoState();
    workflows = { active: 0, runningAgents: 0 };
    rootActive = false;
    foreground.clear();
    asyncRuns.clear();
    const entries = nextCtx.sessionManager.getBranch();
    compactions = countCompactions(entries);
    stateFile = join(getAgentDir(), "dashboard-session-metrics", `${nextCtx.sessionManager.getSessionId()}.json`);
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
    syncClock();
    requestRender?.();
  });

  pi.on("session_shutdown", (_event, shutdownCtx) => {
    rootActive = false;
    foreground.clear();
    asyncRuns.clear();
    workflows = { active: 0, runningAgents: 0 };
    syncClock();
    persist();
    if (renderTimer) clearInterval(renderTimer);
    renderTimer = undefined;
    requestRender = undefined;
    stateFile = undefined;
    ctx = undefined;
    if (shutdownCtx.mode === "tui") shutdownCtx.ui.setFooter(undefined);
  });
}
