import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { registerWorkflowNotificationRenderer, renderWorkflowNotification } from "../../extensions/dag-workflows.ts";
import type { WorkflowNotificationDetails } from "./scheduler.ts";

const theme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function details(status: WorkflowNotificationDetails["status"]): WorkflowNotificationDetails {
  return {
    workflowId: "wf-auth",
    name: "Authentication hardening",
    status,
    completed: status === "succeeded" ? 2 : 1,
    total: 2,
    failedNodeIds: status === "failed" || status === "blocked" ? ["review"] : [],
    harnesses: ["pi", "claude", "codex", "grok"],
    totalTokens: 1234,
    costUsd: 0.0123,
    statePath: "/tmp/workflow/state.json",
  };
}

test("workflow notification renderer registration uses structured terminal lifecycle details", () => {
  let renderer: ((message: any, options: { expanded: boolean }, theme: Theme) => any) | undefined;
  registerWorkflowNotificationRenderer({
    registerMessageRenderer(type: string, next: typeof renderer) {
      assert.equal(type, "workflow-notify");
      renderer = next;
    },
  } as never);
  assert.ok(renderer);
  const cases: Array<[WorkflowNotificationDetails["status"], string]> = [
    ["succeeded", "done"],
    ["failed", "failed"],
    ["blocked", "attention"],
    ["paused", "paused"],
    ["stopped", "stopped"],
  ];
  for (const [status, lifecycle] of cases) {
    const lines = renderer({
      content: "prose deliberately does not encode lifecycle",
      details: details(status),
    }, { expanded: false }, theme).render(120);
    assert.ok(lines.length <= 2);
    assert.match(lines[0] ?? "", new RegExp(lifecycle));
    assert.match(lines.join("\n"), new RegExp(`${status} ·`));
    assert.match(lines[0] ?? "", /workflow node · pi\/claude\/codex\/grok · wf-auth/);
  }
});

test("expanded workflow notifications stay bounded", () => {
  const message = Array.from({ length: 100 }, (_, index) => `notification line ${index}`).join("\n");
  const lines = renderWorkflowNotification(details("failed"), message, true, theme).render(80);
  assert.ok(lines.length <= 36);
  assert.match(lines.join("\n"), /bounded preview/);
});
