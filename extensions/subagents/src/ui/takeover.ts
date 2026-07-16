import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  lifecycleColor,
  lifecycleGlyph,
  orchestrationBorderSegment,
  padToWidth,
  type OrchestrationLifecycle,
} from "../../../../lib/orchestration/ui.ts";
import { formatElapsed, type SubagentSnapshot } from "../domain.ts";
import { formatContextUtilization } from "../format.ts";
import type { SubagentReadModel } from "../manager.ts";
import { buildTranscriptLines } from "./transcript.ts";

const WIDE_MIN_WIDTH = 100;
const TRANSCRIPT_SCROLL_STEP = 6;

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
): string {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

function lifecycle(snap: SubagentSnapshot): OrchestrationLifecycle {
  if (snap.status === "done") return "done";
  if (snap.status === "error") return "failed";
  return "running";
}

export interface DashboardSelection {
  id?: string;
  index: number;
}

export function reconcileDashboardSelection(
  selection: DashboardSelection,
  subs: ReadonlyArray<Pick<SubagentSnapshot, "id">>,
) {
  const stableIndex = selection.id
    ? subs.findIndex((snap) => snap.id === selection.id)
    : -1;
  selection.index = stableIndex >= 0
    ? stableIndex
    : Math.min(Math.max(0, selection.index), Math.max(0, subs.length - 1));
  selection.id = subs[selection.index]?.id;
}

export async function openSubagentPicker(
  ctx: ExtensionCommandContext,
  view: SubagentReadModel,
) {
  if (view.size() === 0) {
    ctx.ui.notify("No subagents", "info");
    return;
  }
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      new DirectAgentsOverlay(tui, theme, keybindings, view, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}

/** Responsive direct-agent list, transcript, takeover editor, and honest controls. */
export class DirectAgentsOverlay implements Component, Focusable {
  private readonly selection: DashboardSelection = { index: 0 };
  private readonly input = new Input();
  private closed = false;
  private detailMode = false;
  private takeoverActive = false;
  private sendPending = false;
  private sendError?: string;
  private scrollOffset = 0;
  private lastWidth = 80;
  private ticker: ReturnType<typeof setInterval>;
  private unsubscribe: () => void;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private _focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly view: SubagentReadModel,
    private readonly done: (value: null) => void,
  ) {
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.unsubscribe = view.subscribe(() => this.scheduleRender());
    this.input.onSubmit = (value) => this.submit(value);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.takeoverActive;
  }

  handleInput(data: string): void {
    const subs = this.subs();
    const selected = subs[this.selection.index];

    if (this.keybindings.matches(data, "app.clear")) {
      if (selected?.status === "running") this.view.requestAbort(selected.id);
      return;
    }

    if (this.takeoverActive) {
      if (this.keybindings.matches(data, "app.interrupt") || this.keybindings.matches(data, "tui.select.cancel")) {
        this.takeoverActive = false;
        this.input.focused = false;
        if (this.lastWidth < WIDE_MIN_WIDTH) this.detailMode = false;
        this.tui.requestRender();
        return;
      }
      if (this.handleScroll(data)) return;
      if (!this.sendPending) {
        this.sendError = undefined;
        this.input.handleInput(data);
      }
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.lastWidth < WIDE_MIN_WIDTH && this.detailMode) {
        this.detailMode = false;
        this.tui.requestRender();
      } else {
        this.close();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      this.move(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      this.move(1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (!selected) return;
      this.detailMode = true;
      this.takeoverActive = true;
      this.input.focused = this._focused;
      this.scrollOffset = 0;
      this.tui.requestRender();
      return;
    }
    if (data === "x" && selected?.status === "running") {
      this.view.requestAbort(selected.id);
    }
  }

  render(width: number): string[] {
    this.lastWidth = width;
    if (width >= WIDE_MIN_WIDTH) this.detailMode = false;
    else if (this.takeoverActive) this.detailMode = true;
    const subs = this.subs();
    const selected = subs[this.selection.index];
    const rows = this.tui.terminal.rows || 30;
    const bodyHeight = Math.max(6, rows - 5);
    const innerWidth = Math.max(1, width - 2);
    const live = subs.filter((snap) => snap.status === "running").length;
    const failed = subs.filter((snap) => snap.status === "error").length;

    const headerLeft = this.theme.fg("accent", this.theme.bold("Agents"));
    const headerRight = this.theme.fg("muted", `${live} live · ${failed} failed · ${subs.length} direct`);
    const gap = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4);
    const lines = [truncateToWidth(`  ${headerLeft}${" ".repeat(gap)}${headerRight}  `, width, "…", true)];
    const panelTitle = width < WIDE_MIN_WIDTH && this.detailMode
      ? `agent details · ${selected?.title ?? "none"}`
      : `direct agents · ${subs.length} shown`;
    lines.push(this.border("╭") + orchestrationBorderSegment(this.theme, innerWidth, panelTitle) + this.border("╮"));

    let body: string[];
    if (!selected) body = [this.theme.fg("muted", " No direct agents yet.")];
    else if (width >= WIDE_MIN_WIDTH) body = this.renderWide(subs, selected, innerWidth, bodyHeight);
    else if (this.detailMode) body = this.renderDetail(selected, innerWidth, bodyHeight);
    else body = this.renderList(subs, innerWidth, bodyHeight);
    while (body.length < bodyHeight) body.push("");
    lines.push(...body.slice(0, bodyHeight).map((line) => this.row(line, innerWidth)));
    lines.push(this.border("╰") + this.border("─".repeat(innerWidth)) + this.border("╯"));

    const back = configuredKeys(this.keybindings, "tui.select.cancel");
    const confirm = configuredKeys(this.keybindings, "tui.select.confirm");
    const submit = configuredKeys(this.keybindings, "tui.input.submit");
    const cancel = configuredKeys(this.keybindings, "app.clear");
    const navigation = width < WIDE_MIN_WIDTH
      ? this.detailMode ? `${back} back · ${cancel} cancel` : `↑↓/jk select · ${confirm} inspect/take over · x cancel · ${back} close`
      : this.takeoverActive ? `${submit} follow-up · ${back} leave editor · ${cancel} cancel` : `↑↓/jk select · ${confirm} take over · x cancel · ${back} close`;
    lines.push(truncateToWidth(this.theme.fg("dim", `  ${navigation}`), width, "…", true));
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  dispose(): void {
    this.cleanup();
  }

  private subs(): ReadonlyArray<SubagentSnapshot> {
    const subs = this.view.list();
    reconcileDashboardSelection(this.selection, subs);
    return subs;
  }

  private move(delta: number) {
    const subs = this.subs();
    if (subs.length === 0) return;
    this.selection.index = (this.selection.index + delta + subs.length) % subs.length;
    this.selection.id = subs[this.selection.index]?.id;
    this.scrollOffset = 0;
    this.sendError = undefined;
    this.tui.requestRender();
  }

  private renderWide(
    subs: ReadonlyArray<SubagentSnapshot>,
    selected: SubagentSnapshot,
    width: number,
    height: number,
  ): string[] {
    const leftWidth = Math.max(36, Math.floor(width * 0.42));
    const rightWidth = Math.max(1, width - leftWidth - 1);
    const left = this.renderList(subs, leftWidth, height);
    const right = this.renderDetail(selected, rightWidth, height);
    return Array.from({ length: height }, (_, index) =>
      `${padToWidth(left[index] ?? "", leftWidth)}${this.theme.fg("borderMuted", "│")}${padToWidth(right[index] ?? "", rightWidth)}`,
    );
  }

  private renderList(subs: ReadonlyArray<SubagentSnapshot>, width: number, height: number): string[] {
    const rows: string[] = [];
    for (let index = 0; index < subs.length; index++) {
      const snap = subs[index];
      const state = lifecycle(snap);
      const glyph = lifecycleColor(this.theme, state, lifecycleGlyph(state));
      const harness = this.theme.fg("accent", snap.backend);
      const utilization = formatContextUtilization(snap.usage);
      const meta = [harness, snap.meta.modelLabel ?? "?", utilization, formatElapsed(snap)].filter(Boolean).join(this.theme.fg("dim", " · "));
      const title = truncateToWidth(` ${glyph} ${snap.title}`, Math.max(1, width - 1), "…", true);
      const line = `${title}\n   ${this.theme.fg("muted", meta)}`;
      const parts = line.split("\n");
      if (index === this.selection.index) {
        rows.push(...parts.map((part) => this.theme.bg("selectedBg", padToWidth(part, width))));
      } else rows.push(...parts);
    }
    const selectedLine = this.selection.index * 2;
    const start = Math.max(0, Math.min(selectedLine - Math.floor(height / 2), Math.max(0, rows.length - height)));
    return rows.slice(start, start + height).map((line) => truncateToWidth(line, width, "…", true));
  }

  private renderDetail(snap: SubagentSnapshot, width: number, height: number): string[] {
    const state = lifecycle(snap);
    const utilization = formatContextUtilization(snap.usage);
    const lines = [
      ` ${lifecycleColor(this.theme, state, `${lifecycleGlyph(state)} ${state}`)} ${this.theme.bold(snap.title)}`,
      ` ${this.theme.fg("accent", snap.backend)} · direct agent · ${snap.id}`,
      ` model    ${snap.meta.modelLabel ?? "?"}`,
      ` elapsed  ${formatElapsed(snap)}${utilization ? ` · ${utilization}` : ""}`,
      ` cwd      ${snap.cwd}`,
      ` controls ${snap.status === "running" ? "follow-up/takeover · cancel" : "follow-up/continue"}`,
      this.theme.fg("borderMuted", " transcript"),
    ];

    const editorRows = this.takeoverActive ? 3 : 1;
    const transcriptHeight = Math.max(1, height - lines.length - editorRows);
    const transcript = buildTranscriptLines(snap, Math.max(10, width - 2), this.theme);
    const maxOffset = Math.max(0, transcript.length - transcriptHeight);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    const end = transcript.length - this.scrollOffset;
    const visible = transcript.slice(Math.max(0, end - transcriptHeight), end);
    lines.push(...(visible.length > 0 ? visible.map((line) => ` ${line}`) : [this.theme.fg("dim", " (no output yet)")]));
    while (lines.length < height - editorRows) lines.push("");

    if (this.takeoverActive) {
      if (this.sendPending) lines.push(this.theme.fg("warning", " sending follow-up…"));
      else if (this.sendError) lines.push(truncateToWidth(this.theme.fg("error", ` send failed: ${this.sendError}`), width, "…", true));
      else lines.push(this.theme.fg("dim", this.scrollOffset > 0 ? ` ${this.scrollOffset} lines below · ↓/pgdn` : " takeover editor"));
      lines.push(...this.input.render(Math.max(1, width - 1)).map((line) => ` ${line}`));
    } else {
      lines.push(this.theme.fg("dim", " enter to take over or send a follow-up"));
    }
    return lines.slice(0, height).map((line) => truncateToWidth(line, width, "…", true));
  }

  private handleScroll(data: string): boolean {
    if (this.keybindings.matches(data, "tui.editor.cursorUp")) this.scrollOffset += TRANSCRIPT_SCROLL_STEP;
    else if (this.keybindings.matches(data, "tui.editor.cursorDown")) this.scrollOffset = Math.max(0, this.scrollOffset - TRANSCRIPT_SCROLL_STEP);
    else if (this.keybindings.matches(data, "tui.editor.pageUp")) this.scrollOffset += Math.max(6, (this.tui.terminal.rows || 30) - 12);
    else if (this.keybindings.matches(data, "tui.editor.pageDown")) this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(6, (this.tui.terminal.rows || 30) - 12));
    else return false;
    this.tui.requestRender();
    return true;
  }

  private submit(value: string) {
    const text = value.trim();
    const id = this.selection.id;
    if (!text || !id || this.sendPending) return;
    this.sendPending = true;
    this.sendError = undefined;
    this.tui.requestRender();
    void this.view.requestSend(id, text).then(
      () => {
        if (this.closed) return;
        this.input.setValue("");
        this.sendPending = false;
        this.scrollOffset = 0;
        this.tui.requestRender();
      },
      (error: unknown) => {
        if (this.closed) return;
        this.sendPending = false;
        this.sendError = (error instanceof Error ? error.message : String(error)).slice(0, 4096);
        this.tui.requestRender();
      },
    );
  }

  private scheduleRender() {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, 50);
  }

  private cleanup(): boolean {
    if (this.closed) return false;
    this.closed = true;
    clearInterval(this.ticker);
    this.unsubscribe();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    return true;
  }

  private close() {
    if (this.cleanup()) this.done(null);
  }

  private row(text: string, width: number): string {
    return this.border("│") + padToWidth(text, width) + this.border("│");
  }

  private border(text: string): string {
    return this.theme.fg("border", text);
  }
}
