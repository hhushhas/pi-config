import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FleetOverlay } from "../lib/workflows/fleet-overlay.ts";
import { SubagentRpcClient } from "../lib/workflows/rpc-client.ts";
import { WorkflowScheduler } from "../lib/workflows/scheduler.ts";
import { WorkflowStore } from "../lib/workflows/store.ts";
import { inspectProjection, listProjection, statusProjection } from "../lib/workflows/projection.ts";
import { WORKFLOW_INFO_CHANNEL } from "../lib/dashboard/state.ts";

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
  label: Type.Optional(Type.String({ description: "Short human-readable label." })),
  agent: Type.String({ description: "pi-subagents role, such as worker, scout, reviewer, or delegate." }),
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

function requireValue(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function modelName(ctx: ExtensionContext): string | undefined {
  if (!ctx.model) return undefined;
  return `${ctx.model.provider}/${ctx.model.id}`;
}

export default function (pi: ExtensionAPI) {
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
        async (message, level, triggerTurn) => {
          ctx.ui.notify(message, level);
          if (triggerTurn) pi.sendMessage({ customType: "workflow-notify", content: message, display: true }, { triggerTurn: true });
        },
      );
      unsubscribers = [
        pi.events.on("subagent:async-complete", (value) => scheduler?.handleCompletion(value)),
        pi.events.on("subagent:control-event", () => ctx.ui.setStatus("dag-workflows", "workflow attention")),
      ];
      await scheduler.initialize();

      const updateStatus = () => {
        const workflows = scheduler?.snapshot() ?? [];
        const active = workflows.filter((workflow) => workflow.status === "active").length;
        const waiting = workflows.filter((workflow) => workflow.status === "awaiting_resume").length;
        const live = workflows.filter((workflow) => Object.values(workflow.nodes).some((node) => ["launching", "running", "pausing", "stopping"].includes(node.status)));
        const single = live.length === 1 ? live[0] : undefined;
        pi.events.emit(WORKFLOW_INFO_CHANNEL, {
          active: live.length,
          runningAgents: live.reduce((total, workflow) => total + Object.values(workflow.nodes).filter((node) => ["launching", "running", "pausing", "stopping"].includes(node.status)).length, 0),
          ...(single ? {
            name: single.name,
            completed: Object.values(single.nodes).filter((node) => node.status === "succeeded").length,
            total: Object.keys(single.nodes).length,
          } : {}),
        });
        ctx.ui.setStatus("dag-workflows", active > 0 ? `${active} workflows active` : waiting > 0 ? `${waiting} workflows paused` : undefined);
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
      "Create and control durable dependency-aware subagent DAGs. Use only when Hasan explicitly asks for subagents/orchestration, invokes /orchestrate, or requests a dependency-aware workflow. Independent nodes run concurrently; dependent nodes wait for successful prerequisites.",
    parameters: WorkflowParams,
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
        overlayOptions: { width: "90%", minWidth: 48, maxHeight: "90%", anchor: "center", margin: 1 },
      });
    },
  });
}
