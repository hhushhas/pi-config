import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

export type OrchestrationLifecycle =
  | "queued"
  | "running"
  | "attention"
  | "paused"
  | "done"
  | "failed"
  | "stopped";

const GLYPHS: Record<OrchestrationLifecycle, string> = {
  queued: "○",
  running: "●",
  attention: "!",
  paused: "Ⅱ",
  done: "✓",
  failed: "✗",
  stopped: "■",
};

export function lifecycleGlyph(status: OrchestrationLifecycle): string {
  return GLYPHS[status];
}

export function lifecycleColor(theme: Theme, status: OrchestrationLifecycle, text: string): string {
  if (status === "done") return theme.fg("success", text);
  if (status === "failed" || status === "stopped") return theme.fg("error", text);
  if (status === "attention" || status === "paused") return theme.fg("warning", text);
  if (status === "running") return theme.fg("accent", text);
  return theme.fg("muted", text);
}

export function padToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "…", true);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function orchestrationBorderSegment(theme: Theme, width: number, title: string): string {
  const label = title ? ` ${truncateToWidth(title, Math.max(0, width - 3))} ` : "";
  return theme.fg("border", "─")
    + (label ? theme.fg("text", label) : "")
    + theme.fg("border", "─".repeat(Math.max(0, width - 1 - visibleWidth(label))));
}

export interface InlineAgentCard {
  lifecycle: OrchestrationLifecycle;
  title: string;
  kind: "role agent" | "workflow node" | "direct agent";
  harness: string;
  identity?: string;
  elapsed?: string;
  activity?: string;
  output?: string;
  metadata?: string[];
}

/** Compact-by-default orchestration card with width- and output-bounded rendering. */
export function renderInlineAgentCard(theme: Theme, card: InlineAgentCard, expanded: boolean): Component {
  return {
    render(width: number): string[] {
      const status = lifecycleColor(theme, card.lifecycle, `${lifecycleGlyph(card.lifecycle)} ${card.lifecycle}`);
      const identity = [card.kind, card.harness, card.identity, card.elapsed].filter(Boolean).join(" · ");
      const lines = [
        truncateToWidth(`${status} ${theme.bold(card.title)} ${theme.fg("dim", `· ${identity}`)}`, width, "…", true),
      ];
      const activity = card.activity?.trim();
      if (activity) lines.push(truncateToWidth(`  ${theme.fg("muted", activity)}`, width, "…", true));
      if (!expanded) return lines.slice(0, 2);

      const outputLines = (card.output ?? "").split("\n").filter((line) => line.trim()).slice(0, 32);
      for (const line of outputLines) lines.push(truncateToWidth(`  ${theme.fg("toolOutput", line)}`, width, "…", true));
      if ((card.output ?? "").split("\n").filter((line) => line.trim()).length > outputLines.length) {
        lines.push(theme.fg("dim", "  … bounded preview; inspect the transcript or artifact for complete output"));
      }
      if (card.metadata?.length) lines.push(truncateToWidth(`  ${theme.fg("dim", card.metadata.join(" · "))}`, width, "…", true));
      return lines.slice(0, 36);
    },
    invalidate() {},
  };
}
