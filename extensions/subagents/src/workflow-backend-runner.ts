import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Exit, Effect, Scope, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "./backend.ts";
import { claudeBackend } from "./backends/claude.ts";
import { codexBackend } from "./backends/codex.ts";
import { grokBackend } from "./backends/grok.ts";
import type { ReasoningEffort, SubagentEvent, SubagentMeta } from "./domain.ts";

type Config = {
  runId: string; asyncDir: string; harness: "claude" | "codex" | "grok"; prompt: string; title: string; cwd: string;
  model?: string; reasoningEffort?: ReasoningEffort; timeoutMs?: number; capabilityHash: string;
  runtimeLaunch: { operationId: string; runId: string; kind: "spawn" | "resume"; provenance: { workflowId: string; nodeId: string; attemptId: string; ownerLeaseEpoch: number }; effectiveExecution: Record<string, unknown>; [key: string]: unknown };
};
type Control = { action: "pause" | "stop" | "steer" | "resume"; controlRequestId: string; message?: string; config?: Config };

const configFile = process.argv[2];
if (!configFile) throw new Error("runner config path is required");
let config = JSON.parse(readFileSync(configFile, "utf8")) as Config;
let state = "queued";
let startedAt = Date.now();
let endedAt: number | undefined;
let meta: SubagentMeta | undefined;
let turns = 0;
let toolCount = 0;
let tokens: number | undefined;
let currentTool: string | undefined;
let finalText = "";
let error: string | undefined;
let pendingTerminal: { action: "pause" | "stop"; controlRequestId: string } | undefined;
let terminal: { reason: string; at: number; controlRequestId?: string } | undefined;
let stopped = false;
let processingControl = false;
const handled = new Set<string>();

function atomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  chmodSync(file, 0o600);
  if (process.platform !== "win32") {
    const directory = openSync(dirname(file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
function bounded(value: string | undefined, bytes: number): string | undefined {
  if (!value) return value;
  let output = value;
  while (Buffer.byteLength(output, "utf8") > bytes) output = output.slice(0, Math.max(0, output.length - 256));
  return output === value ? output : `${output}… [truncated]`;
}
function statusPayload() {
  const provenance = config.runtimeLaunch.provenance;
  return {
    runId: config.runId, asyncDir: config.asyncDir, state, pid: process.pid, cwd: config.cwd, startedAt, ...(endedAt ? { endedAt } : {}), lastUpdate: Date.now(),
    turnCount: turns, toolCount, ...(tokens !== undefined ? { totalTokens: { input: 0, output: tokens, total: tokens } } : {}),
    ...(currentTool ? { currentTool } : {}), ...(meta?.modelLabel ? { model: meta.modelLabel } : {}), ...(meta?.sessionFilePath ? { sessionFile: meta.sessionFilePath } : {}),
    sessionIdentity: { orchestratorSessionId: "durable-workflow-backend", workflowId: provenance.workflowId, nodeId: provenance.nodeId, attemptId: provenance.attemptId, workflowCapabilityHash: config.capabilityHash, ownerLeaseEpoch: provenance.ownerLeaseEpoch },
    runtimeLaunch: config.runtimeLaunch, ...(terminal ? { terminal } : {}), ...(error ? { error: bounded(error, 4096) } : {}),
  };
}
function publish(): void { atomicJson(join(config.asyncDir, "status.json"), statusPayload()); }
function publishResult(): void {
  atomicJson(join(config.asyncDir, "result.json"), { runId: config.runId, state, success: terminal?.reason === "completed", terminal, output: bounded(finalText, 64 * 1024), error: bounded(error, 4096), sessionIdentity: statusPayload().sessionIdentity, runtimeLaunch: config.runtimeLaunch });
}
function finish(reason: "completed" | "failed" | "paused" | "stopped" | "timed_out", controlRequestId?: string): void {
  state = reason === "completed" ? "complete" : reason;
  endedAt = Date.now(); terminal = { reason, at: endedAt, ...(controlRequestId ? { controlRequestId } : {}) };
  publish(); publishResult();
}

const backend: SubagentBackend = { claude: claudeBackend, codex: codexBackend, grok: grokBackend }[config.harness];
if (!backend) throw new Error(`unsupported harness ${config.harness}`);
if (!(await Effect.runPromise(backend.available))) {
  error = `Backend '${config.harness}' is unavailable.`; finish("failed"); process.exitCode = 1;
} else {
  const scope = await Effect.runPromise(Scope.make());
  let session: SubagentSession;
  try {
    session = await Effect.runPromise(Scope.provide(backend.spawn({ prompt: config.prompt, title: config.title, cwd: config.cwd, model: config.model, reasoningEffort: config.reasoningEffort, parent: { parentCwd: config.cwd, projectTrusted: false } }), scope));
    meta = await Effect.runPromise(session.meta);
    state = "running"; publish();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught); finish("failed"); await Effect.runPromise(Scope.close(scope, Exit.void)); process.exitCode = 1;
    process.exit();
  }

  const onEvent = async (event: SubagentEvent) => {
    if (event._tag === "RunStarted") { state = "running"; terminal = undefined; endedAt = undefined; pendingTerminal = undefined; }
    if (event._tag === "AssistantMessage") {
      turns += 1;
      finalText = event.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") || finalText;
    }
    if (event._tag === "AssistantDelta" && event.kind === "text") finalText += event.delta;
    if (event._tag === "ToolStart") { toolCount += 1; currentTool = event.name; }
    if (event._tag === "ToolEnd") currentTool = undefined;
    if (event._tag === "UsageChanged") tokens = event.tokens ?? tokens;
    if (event._tag === "MetaChanged") meta = { ...(meta ?? { backend: config.harness }), ...event.meta };
    if (event._tag === "BackendError") error = event.message;
    if (event._tag === "RunSettled") {
      if (event.outcome._tag === "Completed") { finalText = event.outcome.finalText; finish("completed"); stopped = true; }
      else if (event.outcome._tag === "Interrupted" && pendingTerminal) {
        finish(pendingTerminal.action === "pause" ? "paused" : "stopped", pendingTerminal.controlRequestId);
        if (pendingTerminal.action === "stop") stopped = true;
      } else {
        error = event.outcome._tag === "Failed" ? event.outcome.errorText : "Run was interrupted without an authoritative workflow control.";
        finalText = event.outcome.partialText ?? finalText; finish("failed"); stopped = true;
      }
    } else publish();
  };
  const pump = Effect.runPromise(Stream.runForEach(session.events, (event) => Effect.promise(() => onEvent(event)))).catch((caught) => {
    if (!stopped) { error = caught instanceof Error ? caught.message : String(caught); finish("failed"); stopped = true; }
  });

  const processControls = async () => {
    if (processingControl) return;
    processingControl = true;
    try {
      const directory = join(config.asyncDir, "controls");
      if (!existsSync(directory)) return;
      for (const file of readdirSync(directory).sort()) {
        const path = join(directory, file);
        if (handled.has(path)) continue;
        const control = JSON.parse(readFileSync(path, "utf8")) as Control;
        if (control.action === "steer") {
          await Effect.runPromise(session.send(control.message ?? ""));
        } else if (control.action === "pause" || control.action === "stop") {
          if (terminal) { handled.add(path); continue; }
          pendingTerminal = { action: control.action, controlRequestId: control.controlRequestId };
          state = control.action === "pause" ? "pausing" : "stopping"; publish();
          await Effect.runPromise(session.interrupt);
        } else if (control.action === "resume") {
          if (terminal?.reason !== "paused" || !control.config) { handled.add(path); continue; }
          const next = control.config;
          config = next; state = "launching"; terminal = undefined; endedAt = undefined; finalText = ""; error = undefined; pendingTerminal = undefined;
          publish();
          await Effect.runPromise(session.send("Continue the assigned task from the paused session. Preserve prior context and finish the acceptance contract."));
          state = "running"; publish();
        }
        handled.add(path);
        // Keep the deterministic journal entry: it is the durable replay
        // receipt used to reject same-id/different-payload controls.
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught); publish();
    } finally { processingControl = false; }
  };
  const poll = setInterval(() => { void processControls(); }, 100);
  const timeout = config.timeoutMs ? setTimeout(() => {
    if (!terminal) { pendingTerminal = undefined; void Effect.runPromise(session.interrupt).finally(() => { finish("timed_out"); stopped = true; }); }
  }, config.timeoutMs) : undefined;
  while (!stopped) await new Promise((resolve) => setTimeout(resolve, 100));
  clearInterval(poll); if (timeout) clearTimeout(timeout);
  await Effect.runPromise(Scope.close(scope, Exit.void));
  await pump;
}
