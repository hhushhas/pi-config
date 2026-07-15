import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { BACKGROUND_TERMINAL_TOOLS } from "./index.ts";

test("worker role allowlist loads and enables the background-terminal tools", () => {
  const settings = JSON.parse(fs.readFileSync(new URL("../../settings.json", import.meta.url), "utf8"));
  const tools: string[] = settings.subagents.agentOverrides.worker.tools;
  for (const name of BACKGROUND_TERMINAL_TOOLS) assert.ok(tools.includes(name), `${name} is enabled`);
});
