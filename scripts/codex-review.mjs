#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const valid = args[0] === "--uncommitted"
  ? args.length === 1
  : (args[0] === "--commit" || args[0] === "--base") && args.length === 2 && Boolean(args[1]);
if (!valid) {
  console.error("Usage: codex-review.mjs --uncommitted | --commit <sha> | --base <branch>");
  process.exit(2);
}

const child = spawn("codex", [
  "review", ...args,
  "-c", 'model="gpt-5.6-sol"',
  "-c", 'model_reasoning_effort="high"',
  "-c", "mcp_servers={}",
], { stdio: "inherit", shell: process.platform === "win32" });

let stopping = false;
function stop() {
  if (stopping || child.exitCode !== null) return;
  stopping = true;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  }
}

const timer = setTimeout(() => {
  console.error("Codex review exceeded 30 minutes and was terminated.");
  stop();
}, 30 * 60 * 1000);
timer.unref();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
child.once("error", (error) => {
  clearTimeout(timer);
  console.error(`Could not start Codex: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  clearTimeout(timer);
  process.exitCode = code ?? (signal ? 1 : 0);
});
