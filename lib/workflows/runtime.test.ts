import assert from "node:assert/strict";
import test from "node:test";
import { normalizedModel } from "./runtime.ts";

test("normalizes only supported pi-subagents reasoning suffixes", () => {
  assert.equal(normalizedModel("openai-codex/gpt-5.6-sol", "off"), "openai-codex/gpt-5.6-sol:off");
  assert.equal(normalizedModel("openai-codex/gpt-5.6-sol:high", "low"), "openai-codex/gpt-5.6-sol:high");
});
