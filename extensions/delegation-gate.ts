import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type DelegationGroup = "subagents" | "harnesses" | "workflows";

interface DelegationGateState {
  enabledGroups: DelegationGroup[];
}

export const DELEGATION_STATE_TYPE = "delegation-gate-state";

export const DELEGATION_TOOLS: Record<DelegationGroup, readonly string[]> = {
  subagents: ["subagent", "wait", "subagent_supervisor", "intercom"],
  harnesses: ["subagent_spawn", "subagent_wait", "subagent_cancel", "subagent_check", "subagent_list"],
  workflows: ["workflow"],
};

const GROUP_LABELS: Record<DelegationGroup, string> = {
  subagents: "Pi role subagents",
  harnesses: "cross-harness agents",
  workflows: "dependency workflows",
};

const ALL_DELEGATION_TOOLS = new Set(Object.values(DELEGATION_TOOLS).flat());

export function normalizeDelegationGroups(value: unknown): DelegationGroup[] {
  if (!Array.isArray(value)) return [];
  const valid = new Set<DelegationGroup>(["subagents", "harnesses", "workflows"]);
  return [...new Set(value.filter((item): item is DelegationGroup => typeof item === "string" && valid.has(item as DelegationGroup)))];
}

export function activeToolsForDelegation(activeTools: readonly string[], enabledGroups: readonly DelegationGroup[]): string[] {
  const next = activeTools.filter((name) => !ALL_DELEGATION_TOOLS.has(name));
  for (const group of enabledGroups) next.push(...DELEGATION_TOOLS[group]);
  return [...new Set(next)];
}

function restoreState(ctx: ExtensionContext): DelegationGroup[] {
  let restored: DelegationGroup[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== DELEGATION_STATE_TYPE) continue;
    restored = normalizeDelegationGroups((entry.data as DelegationGateState | undefined)?.enabledGroups);
  }
  return restored;
}

function formatStatus(enabledGroups: readonly DelegationGroup[]): string {
  if (enabledGroups.length === 0) return "Delegation tools are off for this session.";
  return `Delegation enabled: ${enabledGroups.map((group) => GROUP_LABELS[group]).join(", ")}.`;
}

const ROUTING_LINES: Record<DelegationGroup, string> = {
  subagents: "- `subagent` is for role-based Pi agents, parallel reviews, and ordinary chains.",
  harnesses: "- `subagent_spawn` is for one-off work where choosing Pi, Claude Code, or Codex as the child harness matters.",
  workflows: "- `workflow` is only for durable dependency-aware DAGs explicitly requested by the user.",
};

export function delegationRoutingGuidance(enabledGroups: readonly DelegationGroup[]): string | undefined {
  if (enabledGroups.length < 2) return undefined;
  return [
    "Session-scoped delegation routing:",
    ...enabledGroups.map((group) => ROUTING_LINES[group]),
    "Use the narrowest enabled surface that matches the request; do not substitute one delegation system for another.",
  ].join("\n");
}

export default function delegationGate(pi: ExtensionAPI) {
  // pi-subagents children already receive a deliberately restricted tool set
  // from their parent launch contract. Do not override that contract here.
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  let enabledGroups: DelegationGroup[] = [];

  const apply = (ctx?: ExtensionContext) => {
    pi.setActiveTools(activeToolsForDelegation(pi.getActiveTools(), enabledGroups));
    ctx?.ui.setStatus("delegation-gate", enabledGroups.length > 0 ? `delegation: ${enabledGroups.join("+")}` : undefined);
  };

  const persist = () => {
    pi.appendEntry<DelegationGateState>(DELEGATION_STATE_TYPE, { enabledGroups: [...enabledGroups] });
  };

  const setGroup = (group: DelegationGroup, enabled: boolean, ctx: ExtensionContext) => {
    const next = new Set(enabledGroups);
    if (enabled) next.add(group);
    else next.delete(group);
    enabledGroups = [...next];
    apply(ctx);
    persist();
    ctx.ui.notify(formatStatus(enabledGroups), "info");
  };

  const registerGroupCommands = (group: DelegationGroup) => {
    pi.registerCommand(`enable-${group}`, {
      description: `Enable ${GROUP_LABELS[group]} tools for this session`,
      handler: async (_args, ctx) => setGroup(group, true, ctx),
    });
    pi.registerCommand(`disable-${group}`, {
      description: `Disable ${GROUP_LABELS[group]} tools for this session`,
      handler: async (_args, ctx) => setGroup(group, false, ctx),
    });
  };

  registerGroupCommands("subagents");
  registerGroupCommands("harnesses");
  registerGroupCommands("workflows");

  pi.registerCommand("delegation-off", {
    description: "Disable every delegation tool for this session",
    handler: async (_args, ctx) => {
      enabledGroups = [];
      apply(ctx);
      persist();
      ctx.ui.notify(formatStatus(enabledGroups), "info");
    },
  });

  pi.registerCommand("delegation-status", {
    description: "Show delegation tools enabled for this session",
    handler: async (_args, ctx) => ctx.ui.notify(formatStatus(enabledGroups), "info"),
  });

  pi.on("session_start", (_event, ctx) => {
    enabledGroups = restoreState(ctx);
    apply(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    enabledGroups = restoreState(ctx);
    apply(ctx);
  });

  pi.on("before_agent_start", (event) => {
    const guidance = delegationRoutingGuidance(enabledGroups);
    if (!guidance) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("delegation-gate", undefined);
  });
}
