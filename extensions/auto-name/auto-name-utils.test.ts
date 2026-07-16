import assert from "node:assert/strict";
import test from "node:test";
import { buildNameContext, extractNameFromResult, NAME_SYSTEM_PROMPT } from "./utils/auto-name-utils.ts";

test("vendored auto-name uses the canonical concise English prompt", () => {
  assert.match(NAME_SYSTEM_PROMPT, /concise English/);
  assert.equal(buildNameContext("ship the installer"), "User message: ship the installer");
  assert.equal(extractNameFromResult([{ type: "text", text: "Portable Pi Setup" }]), "Portable Pi Setup");
});
