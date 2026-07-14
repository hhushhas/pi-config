interface TimestampedEntry {
  type: string;
  timestamp: string;
  message?: { role?: string; stopReason?: string };
}

export interface SessionMetricsSnapshot {
  activeMs: number;
  compactions: number;
  runningSubagents: number;
}

export function countCompactions(entries: readonly TimestampedEntry[]): number {
  return entries.filter((entry) => entry.type === "compaction").length;
}

export function estimateHistoricalActiveMs(entries: readonly TimestampedEntry[]): number {
  let activeSince: number | undefined;
  let activeMs = 0;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const at = Date.parse(entry.timestamp);
    if (!Number.isFinite(at)) continue;
    if (entry.message?.role === "user") activeSince ??= at;
    if (entry.message?.role !== "assistant" || entry.message.stopReason === "toolUse") continue;
    if (activeSince !== undefined) activeMs += Math.max(0, at - activeSince);
    activeSince = undefined;
  }

  return activeMs;
}

export class ActiveClock {
  private accumulatedMs: number;
  private activeSince: number | undefined;

  constructor(initialMs = 0) {
    this.accumulatedMs = initialMs;
  }

  setActive(active: boolean, now = Date.now()): void {
    if (active && this.activeSince === undefined) this.activeSince = now;
    if (active || this.activeSince === undefined) return;
    this.accumulatedMs += Math.max(0, now - this.activeSince);
    this.activeSince = undefined;
  }

  value(now = Date.now()): number {
    return this.accumulatedMs + (this.activeSince === undefined ? 0 : Math.max(0, now - this.activeSince));
  }

  isActive(): boolean {
    return this.activeSince !== undefined;
  }
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}
