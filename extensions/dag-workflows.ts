import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FleetOverlay } from "../lib/workflows/fleet-overlay.ts";
import { SubagentRpcClient } from "../lib/workflows/rpc-client.ts";
import { WorkflowScheduler, type WorkflowNotificationDetails } from "../lib/workflows/scheduler.ts";
import { WorkflowStore } from "../lib/workflows/store.ts";
import { inspectProjection, listProjection, statusProjection } from "../lib/workflows/projection.ts";
import { WORKFLOW_INFO_CHANNEL } from "../lib/dashboard/state.ts";
import { currentAttempt } from "../lib/workflows/model.ts";
import { renderInlineAgentCard, type OrchestrationLifecycle } from "../lib/orchestration/ui.ts";

const ThinkingSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
]);

const NodeSchema = Type.Object({
  id: Type.String({ description: "Stable node ID used by dependencies." }),
  harness: Type.Optional(Type.Union([
    Type.Literal("pi"), Type.Literal("claude"), Type.Literal("codex"), Type.Literal("grok"),
  ], { description: "Durable node backend. Omit for the compatible Pi role runtime; external harnesses run through the durable workflow backend bridge, never session-local subagent_spawn." })),
  label: Type.Optional(Type.String({ description: "Short human-readable label." })),
  agent: Type.String({ description: "Agent role/instruction profile. Pi resolves a pi-subagents role; external harnesses persist the value as execution provenance." }),
  task: Type.String({ description: "Self-contained task brief for this node." }),
  dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Node IDs that must succeed first." })),
  model: Type.Optional(Type.String({ description: "Per-node provider/model override." })),
  thinking: Type.Optional(ThinkingSchema),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  cwd: Type.Optional(Type.String({ description: "Relative working directory beneath the workflow cwd." })),
});

const WorkflowParams = Type.Object({
  action: Type.Union([
    Type.Literal("create"),
    Type.Literal("list"),
    Type.Literal("status"),
    Type.Literal("inspect"),
    Type.Literal("resume"),
    Type.Literal("pause"),
    Type.Literal("stop"),
    Type.Literal("retry"),
    Type.Literal("nudge"),
    Type.Literal("takeover"),
  ]),
  workflowId: Type.Optional(Type.String()),
  nodeId: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  nodes: Type.Optional(Type.Array(NodeSchema, { maxItems: 64 })),
  maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
  cwd: Type.Optional(Type.String({ description: "Absolute execution directory; defaults to the active Pi cwd." })),
  includeHistory: Type.Optional(Type.Boolean()),
  message: Type.Optional(Type.String()),
  confirm: Type.Optional(Type.Boolean()),
});

interface WorkflowToolDetails {
  action: string;
  workflowId?: string;
  status?: string;
}

export function renderWorkflowNotification(
  details: WorkflowNotificationDetails,
  message: string,
  expanded: boolean,
  theme: Parameters<typeof renderInlineAgentCard>[0],
) {
  const lifecycle: OrchestrationLifecycle = details.status === "succeeded"
    ? "done"
    : details.status === "paused"
      ? "paused"
      : details.status === "stopped"
        ? "stopped"
        : details.status === "blocked"
          ? "attention"
          : "failed";
  return renderInlineAgentCard(theme, {
    lifecycle,
    title: details.name,
    kind: "workflow node",
    harness: details.harnesses.join("/") || "Pi",
    identity: details.workflowId,
    activity: `${details.status} · ${details.completed}/${details.total} nodes succeeded${details.failedNodeIds.length ? ` · failed ${details.failedNodeIds.join(", ")}` : ""}`,
    output: message,
    metadata: [`${details.totalTokens} tokens`, `$${details.costUsd.toFixed(4)}`, details.statePath],
  }, expanded);
}

export function registerWorkflowNotificationRenderer(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
  pi.registerMessageRenderer<WorkflowNotificationDetails>("workflow-notify", (message, { expanded }, theme) => {
    const details = message.details as WorkflowNotificationDetails | undefined;
    if (!details) return undefined;
    const content = typeof message.content === "string" ? message.content : "";
    return renderWorkflowNotification(details, content, expanded, theme);
  });
}

function requireValue(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function modelName(ctx: ExtensionContext): string | undefined {
  if (!ctx.model) return undefined;
  return `${ctx.model.provider}/${ctx.model.id}`;
}

export default function (pi: ExtensionAPI) {
  registerWorkflowNotificationRenderer(pi);
  let scheduler: WorkflowScheduler | undefined;
  let rpc: SubagentRpcClient | undefined;
  let promptController: AbortController | undefined;
  let unsubscribers: Array<() => void> = [];
  let statusUnsubscribe: (() => void) | undefined;

  const shutdown = () => {
    promptController?.abort();
    promptController = undefined;
    statusUnsubscribe?.();
    statusUnsubscribe = undefined;
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers = [];
    scheduler?.dispose();
    scheduler = undefined;
    rpc?.dispose();
    rpc = undefined;
  };

  pi.on("session_start", async (event, ctx) => {
    shutdown();
    promptController = new AbortController();
    rpc = new SubagentRpcClient(pi.events);
    try {
      const ping = await rpc.waitForSession();
      const sessionId = ping.session.sessionId;
      if (!sessionId) throw new Error("pi-subagents RPC has no active session ID.");
      const store = new WorkflowStore(join(getAgentDir(), "workflow-runs"), ctx.cwd);
      scheduler = new WorkflowScheduler(
        rpc,
        store,
        sessionId,
        ping.session.sessionFile ?? undefined,
        modelName(ctx),
        async (message, level, triggerTurn, details) => {
          ctx.ui.notify(message, level);
          if (triggerTurn) {
            pi.sendMessage({ customType: "workflow-notify", content: message, display: true, details }, { triggerTurn: true });
          }
        },
      );
      unsubscribers = [
        pi.events.on("subagent:async-complete", (value) => scheduler?.handleCompletion(value)),
      ];
      await scheduler.initialize();

      const updateStatus = () => {
        const workflows = scheduler?.snapshot() ?? [];
        const waiting = workflows.filter((workflow) => ["awaiting_resume", "paused"].includes(workflow.status)).length;
        const live = workflows.filter((workflow) => Object.values(workflow.nodes).some((node) => ["launching", "running", "pausing", "stopping"].includes(node.status)));
        const single = live.length === 1 ? live[0] : undefined;
        const attention = workflows.reduce((total, workflow) => total + Object.values(workflow.nodes).filter((node) => currentAttempt(node)?.telemetry?.activityState === "needs_attention").length, 0);
        pi.events.emit(WORKFLOW_INFO_CHANNEL, {
          active: live.length,
          paused: waiting,
          attention,
          runningAgents: live.reduce((total, workflow) => total + Object.values(workflow.nodes).filter((node) => ["launching", "running", "pausing", "stopping"].includes(node.status)).length, 0),
          ...(single ? {
            name: single.name,
            completed: Object.values(single.nodes).filter((node) => node.status === "succeeded").length,
            total: Object.keys(single.nodes).length,
          } : {}),
        });
        // Routine workflow progress belongs to the aggregate dashboard footer.
        ctx.ui.setStatus("dag-workflows", undefined);
      };
      statusUnsubscribe = scheduler.subscribe(updateStatus);
      updateStatus();

      void event;
    } catch (error) {
      ctx.ui.notify(`DAG workflows unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
      shutdown();
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("dag-workflows", undefined);
    pi.events.emit(WORKFLOW_INFO_CHANNEL, { active: 0, runningAgents: 0 });
    shutdown();
  });

  pi.registerTool<typeof WorkflowParams, WorkflowToolDetails>({
    name: "workflow",
    label: "Dependency-aware workflow",
    description:
      "Create and control durable dependency-aware agent DAGs across Pi, Claude Code, Codex, and Grok. Set a node harness only for an external backend; omission preserves Pi role execution. All nodes use persisted attempts, idempotent launch lookup, lease fencing, causal controls, and artifact reconciliation; this tool never delegates durable nodes through session-local subagent_spawn. Independent nodes run concurrently; dependent nodes wait for successful authoritative prerequisites.",
    parameters: WorkflowParams,
    renderCall(params, theme) {
      const harnesses = [...new Set((params.nodes ?? []).map((node) => node.harness ?? "pi"))];
      return renderInlineAgentCard(theme, {
        lifecycle: "running",
        title: params.action === "create" ? (params.name?.trim() || "dependency workflow") : `${params.action} workflow`,
        kind: "workflow node",
        harness: harnesses.length > 0 ? harnesses.join("/") : "Pi",
        identity: params.workflowId ?? `${params.nodes?.length ?? 0} nodes`,
        activity: params.nodeId ? `target ${params.nodeId}` : "durable dependency and authority controls",
      }, false);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as WorkflowToolDetails | undefined;
      const failed = (result as { isError?: boolean }).isError === true;
      const lifecycle: OrchestrationLifecycle = failed || details?.status === "failed"
        ? "failed"
        : details?.status === "paused" || details?.status === "awaiting_resume"
          ? "paused"
          : details?.status === "stopped"
            ? "stopped"
            : details?.status === "active" || details?.status === "pausing" || details?.status === "stopping"
              ? "running"
              : "done";
      const output = result.content.find((item) => item.type === "text")?.text ?? "";
      return renderInlineAgentCard(theme, {
        lifecycle,
        title: details?.workflowId ? `Workflow ${details.workflowId}` : "Dependency workflow",
        kind: "workflow node",
        harness: "Pi/Claude/Codex/Grok",
        identity: details?.action,
        activity: details?.status ?? (failed ? "request failed" : "request accepted"),
        output,
        metadata: ["dependency", "lineage", "pause/retry", "authority"],
      }, expanded);
    },
    async execute(_toolCallId, params) {
      if (!scheduler) {
        return {
          content: [{ type: "text", text: "DAG workflow runtime is not initialized." }],
          details: { action: params.action },
          isError: true,
        };
      }
      try {
        if (params.action === "create") {
          const workflow = await scheduler.create({
            name: requireValue(params.name, "name"),
            nodes: params.nodes ?? [],
            maxConcurrency: params.maxConcurrency,
            cwd: params.cwd,
          });
          return {
            content: [{ type: "text", text: `Started workflow ${workflow.id} (${workflow.name}) with ${Object.keys(workflow.nodes).length} nodes.` }],
            details: { action: params.action, workflowId: workflow.id, status: workflow.status },
          };
        }
        if (params.action === "list") {
          return {
            content: [{ type: "text", text: listProjection(scheduler.snapshot(), params.includeHistory === true) }],
            details: { action: params.action },
          };
        }

        const workflowId = requireValue(params.workflowId, "workflowId");
        if (params.action === "status") {
          const workflow = scheduler.get(workflowId);
          return {
            content: [{ type: "text", text: statusProjection(workflow) }],
            details: { action: params.action, workflowId, status: workflow.status },
          };
        }
        if (params.action === "inspect") {
          const workflow = scheduler.get(workflowId);
          return { content: [{ type: "text", text: inspectProjection(workflow, requireValue(params.nodeId, "nodeId")) }], details: { action: params.action, workflowId, status: workflow.status } };
        }
        if (params.action === "resume") await scheduler.resume(workflowId, requireValue(params.nodeId, "nodeId"));
        if (params.action === "pause") await scheduler.pause(workflowId);
        if (params.action === "stop") {
          if (params.nodeId) await scheduler.stopNode(workflowId, params.nodeId);
          else await scheduler.stopWorkflow(workflowId);
        }
        if (params.action === "retry") await scheduler.retryNode(workflowId, requireValue(params.nodeId, "nodeId"));
        if (params.action === "nudge") await scheduler.nudgeNode(workflowId, requireValue(params.nodeId, "nodeId"), requireValue(params.message, "message"));
        if (params.action === "takeover") {
          const workflow = scheduler.get(workflowId);
          if (params.confirm !== true) throw new Error(`Takeover requires confirm:true after inspecting owner PID ${workflow.ownerProcessId ?? "unknown"}, lease epoch ${workflow.ownerLeaseEpoch}, and revision ${workflow.stateRevision}.`);
          await scheduler.takeover(workflowId, { revision: workflow.stateRevision, leaseId: workflow.ownerLeaseId, leaseEpoch: workflow.ownerLeaseEpoch, ownerProcessId: workflow.ownerProcessId });
        }
        return {
          content: [{ type: "text", text: `${params.action} accepted for workflow ${workflowId}; any terminal control remains pending until its artifact confirms the exact request.` }],
          details: { action: params.action, workflowId },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { action: params.action, workflowId: params.workflowId },
          isError: true,
        };
      }
    },
  });

  pi.registerCommand("fleet", {
    description: "Open the dependency graph and live subagent fleet",
    handler: async (_args, ctx) => {
      if (!scheduler) {
        ctx.ui.notify("DAG workflow runtime is not initialized.", "error");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The fleet screen requires Pi's interactive TUI.", "warning");
        return;
      }
      await ctx.ui.custom<void>((tui, theme, keybindings, done) => new FleetOverlay(
        tui,
        theme,
        keybindings,
        done,
        {
          snapshot: () => scheduler!.snapshot(),
          isControllable: (workflowId) => !scheduler!.isForeignOwned(workflowId) && !scheduler!.get(workflowId).controlsDisabled,
          subscribe: (listener) => scheduler!.subscribe(listener),
          resume: (workflowId, nodeId) => scheduler!.resume(workflowId, nodeId),
          pause: (workflowId) => scheduler!.pause(workflowId),
          stopNode: (workflowId, nodeId) => scheduler!.stopNode(workflowId, nodeId),
          retryNode: (workflowId, nodeId) => scheduler!.retryNode(workflowId, nodeId),
          takeover: (workflowId, confirmation) => scheduler!.takeover(workflowId, confirmation),
          confirm: (title, message) => ctx.ui.confirm(title, message),
          notify: (message, level) => ctx.ui.notify(message, level),
        },
      ), {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" },
      });
    },
  });
}
