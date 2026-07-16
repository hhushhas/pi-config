// Block destructive shell commands with dcg.
// https://github.com/Dicklesworthstone/destructive_command_guard
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DCG_BIN = process.env.DCG_BIN?.trim() || "dcg";
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 1000;

type Decision = { deny: boolean; reason: string };

function dcgDecision(command: string): Promise<Decision> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";

    const finish = (decision: Decision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(decision);
    };

    const child = spawn(DCG_BIN, ["--robot", "test", command], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });

    // dcg has its own 200 ms evaluation budget. This outer timeout protects Pi
    // from a wedged process and deliberately fails open, matching dcg's hooks.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ deny: false, reason: "" });
    }, PROCESS_TIMEOUT_MS);

    child.on("error", () => finish({ deny: false, reason: "" }));
    child.on("close", (code) => {
      if (code !== 1) {
        finish({ deny: false, reason: "" });
        return;
      }

      let reason = "Blocked by dcg (destructive command).";
      try {
        const parsed = JSON.parse(stdout);
        if (parsed?.reason) reason = String(parsed.reason);
        if (parsed?.rule_id) reason += ` [${String(parsed.rule_id)}]`;
      } catch {
        // Keep the generic denial when robot output cannot be decoded.
      }
      finish({ deny: true, reason });
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;

    const command = String(event.input?.command ?? "");
    if (!command.trim()) return;

    const { deny, reason } = await dcgDecision(command);
    if (deny) return { block: true, reason };
  });
}
