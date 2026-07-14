import assert from "node:assert/strict";
import test from "node:test";
import { ActiveClock, countCompactions, estimateHistoricalActiveMs, formatDuration } from "./metrics.ts";
import { foregroundCount } from "../../extensions/ui-dashboard.ts";

test("counts compactions and estimates completed active intervals", () => {
  const entries = [
    { type: "message", timestamp: "2026-07-14T10:00:00.000Z", message: { role: "user" } },
    { type: "message", timestamp: "2026-07-14T10:00:10.000Z", message: { role: "assistant", stopReason: "toolUse" } },
    { type: "compaction", timestamp: "2026-07-14T10:00:20.000Z" },
    { type: "message", timestamp: "2026-07-14T10:01:00.000Z", message: { role: "assistant", stopReason: "stop" } },
  ];

  assert.equal(countCompactions(entries), 1);
  assert.equal(estimateHistoricalActiveMs(entries), 60_000);
});

test("active clock accumulates only active wall time", () => {
  const clock = new ActiveClock(5_000);
  clock.setActive(true, 10_000);
  assert.equal(clock.value(15_000), 10_000);
  clock.setActive(false, 20_000);
  assert.equal(clock.value(50_000), 15_000);
  assert.equal(formatDuration(clock.value(50_000)), "15s");
});

test("foreground count expands repeated parallel tasks", () => {
  assert.equal(foregroundCount({ tasks: [{ agent: "reviewer", count: 4 }, { agent: "worker" }] }), 5);
  assert.equal(foregroundCount({ chain: [{ parallel: [{ agent: "reviewer", count: 3 }, { agent: "worker", count: 2 }] }] }), 5);
});
