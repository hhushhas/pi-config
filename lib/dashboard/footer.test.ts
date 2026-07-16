import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFooter } from "./footer.ts";

const theme = {
  fg: (_color: string, text: string) => text,
} as never;

const footerData = {
  getExtensionStatuses: () => new Map([["session-name", "Staging Infrastructure"]]),
} as never;

test("footer groups session and orchestration metrics without overflowing", () => {
  const snapshot = {
    cwd: "/tmp/project",
    model: { provider: "openai-codex", modelId: "gpt-5.6-sol", thinking: "medium", contextWindow: 372_000, contextPercent: 25, cost: 47.89, tokensPerSecond: 20 },
    git: { branch: "main", changedFiles: 4, pullRequest: null },
    metrics: { activeMs: 4_680_000, compactions: 3, runningSubagents: 4 },
    workflows: { active: 1, runningAgents: 3, name: "chalk-infra", completed: 3, total: 5 },
    directAgents: { runningAgents: 2 },
    attention: 0,
  };

  for (const width of [48, 80, 140]) {
    const lines = renderFooter(snapshot, footerData, theme, width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.match(lines[2] ?? "", /active 1h 18m/);
    assert.match(lines[2] ?? "", /6 agents/);
  }
});

test("footer keeps paused workflow status visible", () => {
  const pausedFooterData = { getExtensionStatuses: () => new Map([["dag-workflows", "1 workflow paused"]]) } as never;
  const lines = renderFooter({
    cwd: "/tmp/project",
    model: { provider: "", modelId: "no-model", thinking: "off", contextWindow: 0, contextPercent: null, cost: 0, tokensPerSecond: null },
    git: { branch: null, changedFiles: 0, pullRequest: null },
    metrics: { activeMs: 0, compactions: 0, runningSubagents: 0 },
    workflows: { active: 0, paused: 1, runningAgents: 0 },
    directAgents: { runningAgents: 0 },
    attention: 0,
  }, pausedFooterData, theme, 80);

  assert.equal(lines.at(-1), "1 workflow paused");
});
