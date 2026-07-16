import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderInlineAgentCard } from "./ui.ts";

const theme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

test("shared inline cards are compact by default and width bounded", () => {
  const card = renderInlineAgentCard(theme, {
    lifecycle: "running",
    title: "Implement a very long authentication hardening change",
    kind: "workflow node",
    harness: "Codex",
    identity: "worker",
    activity: "editing lib/auth/session.ts with a deliberately long activity description",
    output: Array.from({ length: 50 }, (_, index) => `output line ${index}`).join("\n"),
  }, false);

  for (const width of [24, 48, 100]) {
    const lines = card.render(width);
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
});

test("expanded inline cards retain bounded output", () => {
  const card = renderInlineAgentCard(theme, {
    lifecycle: "done",
    title: "Review",
    kind: "direct agent",
    harness: "Claude",
    output: Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"),
  }, true);
  assert.ok(card.render(80).length <= 36);
  assert.match(card.render(80).join("\n"), /bounded preview/);
});
