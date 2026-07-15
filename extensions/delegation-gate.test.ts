import assert from "node:assert/strict";
import test from "node:test";
import { activeToolsForDelegation, delegationRoutingGuidance, normalizeDelegationGroups } from "./delegation-gate.ts";

test("delegation is off by default and removes every managed tool", () => {
  const active = ["read", "subagent", "subagent_spawn", "workflow", "bash"];
  assert.deepEqual(activeToolsForDelegation(active, []), ["read", "bash"]);
});

test("delegation groups accumulate without duplicating tools", () => {
  const active = ["read", "subagent", "subagent_wait"];
  assert.deepEqual(activeToolsForDelegation(active, ["subagents", "harnesses"]), [
    "read",
    "subagent",
    "wait",
    "subagent_supervisor",
    "intercom",
    "subagent_spawn",
    "subagent_wait",
    "subagent_cancel",
    "subagent_check",
    "subagent_list",
  ]);
});

test("state normalization drops unknown and duplicate groups", () => {
  assert.deepEqual(normalizeDelegationGroups(["workflows", "unknown", "workflows", "harnesses"]), [
    "workflows",
    "harnesses",
  ]);
  assert.deepEqual(normalizeDelegationGroups("subagents"), []);
});

test("routing guidance names only the cumulatively enabled systems", () => {
  assert.equal(delegationRoutingGuidance(["subagents"]), undefined);
  const guidance = delegationRoutingGuidance(["subagents", "harnesses"]);
  assert.match(guidance ?? "", /`subagent`/);
  assert.match(guidance ?? "", /`subagent_spawn`/);
  assert.doesNotMatch(guidance ?? "", /`workflow`/);
});
