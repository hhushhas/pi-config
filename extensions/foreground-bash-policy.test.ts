import assert from "node:assert/strict";
import test from "node:test";
import {
  addBackgroundRetryHint,
  applyDefaultBashTimeout,
  DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS,
  FOREGROUND_TIMEOUT_RETRY_HINT,
} from "./foreground-bash-policy.ts";

test("foreground bash gets the 180-second default only when timeout is omitted", () => {
  const input: { command: string; timeout?: number } = { command: "pnpm test" };
  applyDefaultBashTimeout(input);
  assert.equal(input.timeout, DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS);
});

test("an explicit foreground bash timeout wins, including zero", () => {
  const custom = { command: "sleep 1", timeout: 900 };
  const zero = { command: "true", timeout: 0 };
  applyDefaultBashTimeout(custom);
  applyDefaultBashTimeout(zero);
  assert.equal(custom.timeout, 900);
  assert.equal(zero.timeout, 0);
});

test("only timeout failures receive the intentional background retry hint", () => {
  const timeout = addBackgroundRetryHint("output\n\nCommand timed out after 180 seconds");
  assert.ok(timeout.includes(FOREGROUND_TIMEOUT_RETRY_HINT));
  assert.match(timeout, /ask the user to run \/enable-bg-terminal.*bg_start is unavailable/);
  assert.equal(addBackgroundRetryHint(timeout), timeout, "hint is not duplicated");
  assert.equal(addBackgroundRetryHint("Command exited with code 1"), "Command exited with code 1");
});
