/**
 * Grok backend — official Grok Build CLI over Agent Client Protocol (ACP).
 *
 * One scoped `grok agent stdio` process owns one persistent Grok session. The
 * process reuses the user's official Grok Build authentication, so this backend
 * consumes subscription allowance rather than the separately billed xAI API.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import type {
  ReasoningEffort,
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  TranscriptPart,
} from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const INTERRUPT_FALLBACK_MS = 2_000;
const FORCE_KILL_AFTER_MS = 2_000;
const PREVIEW_MAX_LENGTH = 1_024;
const STDOUT_BUFFER_MAX_BYTES = 4 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

interface PendingRequest {
  readonly resolve: (result: JsonRecord) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
}

interface ToolState {
  name: string;
  output?: string;
}

let cachedGrokBinary: string | null | undefined;

function executable(file: string) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveGrokBinary() {
  if (cachedGrokBinary !== undefined) return cachedGrokBinary ?? undefined;
  const names = process.platform === "win32" ? ["grok.exe", "grok.cmd"] : ["grok"];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (executable(candidate)) {
        cachedGrokBinary = candidate;
        return candidate;
      }
    }
  }
  cachedGrokBinary = null;
  return undefined;
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function records(value: unknown) {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is JsonRecord => item !== undefined)
    : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeJson(value: unknown) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : text.slice(0, PREVIEW_MAX_LENGTH);
  } catch {
    return undefined;
  }
}

function firstLine(value: unknown) {
  if (typeof value !== "string") return undefined;
  const line = value.split("\n").find((candidate) => candidate.trim());
  return line?.trim().slice(0, PREVIEW_MAX_LENGTH);
}

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4096);
}

function protocolError(value: unknown) {
  const error = record(value);
  return boundedError(
    stringValue(error?.message) ?? safeJson(value) ?? "Grok ACP request failed",
  );
}

/** Grok 4.5 currently exposes low, medium, and high reasoning effort. */
export function grokReasoningEffort(effort: ReasoningEffort | undefined) {
  switch (effort) {
    case "off":
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    case undefined:
      return undefined;
  }
}

function contentText(value: unknown) {
  return records(value)
    .map((item) => {
      if (stringValue(item.type) === "content") {
        return stringValue(record(item.content)?.text);
      }
      if (stringValue(item.type) === "diff") {
        return stringValue(item.path);
      }
      return undefined;
    })
    .filter((text): text is string => text !== undefined && text.length > 0)
    .join("\n");
}

function modelState(value: unknown) {
  const state = record(value);
  const modelLabel = stringValue(state?.currentModelId);
  const selected = records(state?.availableModels).find(
    (candidate) => stringValue(candidate.modelId) === modelLabel,
  );
  const contextWindow = numberValue(record(selected?._meta)?.totalContextTokens);
  return { modelLabel, contextWindow };
}

function toolName(update: JsonRecord) {
  const metadata = record(record(update._meta)?.["x.ai/tool"]);
  return (
    stringValue(metadata?.name) ??
    stringValue(update.title) ??
    stringValue(update.kind) ??
    "tool"
  );
}

function toolFailed(status: string | undefined, update: JsonRecord) {
  const raw = record(update.rawOutput);
  const exitCode = numberValue(raw?.exit_code);
  return status === "failed" || (exitCode !== undefined && exitCode !== 0);
}

const makeGrokSession = (
  task: SpawnTask,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const binary = resolveGrokBinary();
    if (!binary) {
      return yield* new SpawnError({
        message: "grok executable was not found on PATH.",
      });
    }

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit = (event: SubagentEvent) => Queue.offerUnsafe(events, event);
    const effort = grokReasoningEffort(task.reasoningEffort);
    const args = [
      "--no-auto-update",
      "agent",
      "--no-leader",
      "--always-approve",
      ...(task.model ? ["--model", task.model] : []),
      ...(effort ? ["--reasoning-effort", effort] : []),
      "stdio",
    ];

    const child = yield* Effect.try({
      try: () =>
        spawn(binary, args, {
          cwd: task.cwd,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        }),
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });

    const state = {
      closed: false,
      closing: false,
      exited: false,
      activeRun: false,
      interruptRequested: false,
      runSerial: 0,
      finalText: "",
      thinkingText: "",
      pendingPrompts: [] as string[],
      nextRequestId: 0,
      stderr: "",
      sessionId: undefined as string | undefined,
      meta: {
        backend: "grok",
        modelLabel: task.model,
      } satisfies SubagentMeta as SubagentMeta,
      interruptTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    const pendingRequests = new Map<number, PendingRequest>();
    const pendingPermissions = new Set<number | string>();
    const tools = new Map<string, ToolState>();

    const writeMessage = (message: JsonRecord) => {
      if (state.closed || !child.stdin.writable) return false;
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    };

    const request = (
      method: string,
      params: JsonRecord,
      timeoutMs: number | undefined = REQUEST_TIMEOUT_MS,
    ) =>
      new Promise<JsonRecord>((resolve, reject) => {
        if (state.closed) {
          reject(new Error("Grok ACP process is closed."));
          return;
        }
        const id = ++state.nextRequestId;
        const timer =
          timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                pendingRequests.delete(id);
                reject(new Error(`Grok ACP request ${method} timed out.`));
              }, timeoutMs);
        pendingRequests.set(id, { resolve, reject, timer });
        if (!writeMessage({ jsonrpc: "2.0", id, method, params })) {
          if (timer) clearTimeout(timer);
          pendingRequests.delete(id);
          reject(new Error("Grok ACP stdin is closed."));
        }
      });

    const notify = (method: string, params: JsonRecord) =>
      writeMessage({ jsonrpc: "2.0", method, params });

    const rejectPending = (message: string) => {
      for (const pending of pendingRequests.values()) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new Error(message));
      }
      pendingRequests.clear();
    };

    const queuedView = () =>
      state.pendingPrompts.map((text) => ({ text, kind: "follow-up" as const }));

    const finalizeAssistant = () => {
      const parts: TranscriptPart[] = [];
      if (state.thinkingText) {
        parts.push({ type: "thinking", text: state.thinkingText });
      }
      if (state.finalText) parts.push({ type: "text", text: state.finalText });
      if (parts.length > 0) emit({ _tag: "AssistantMessage", parts });
    };

    const startNextQueued = () => {
      if (state.closed || state.activeRun) return;
      const next = state.pendingPrompts.shift();
      if (next === undefined) return;
      emit({ _tag: "QueueChanged", queued: queuedView() });
      startRun(next);
    };

    const settleRun = (outcome: RunOutcome, serial = state.runSerial) => {
      if (!state.activeRun || serial !== state.runSerial) return;
      if (state.interruptTimer) clearTimeout(state.interruptTimer);
      state.interruptTimer = undefined;
      finalizeAssistant();
      state.activeRun = false;
      state.interruptRequested = false;
      tools.clear();
      emit({ _tag: "RunSettled", outcome });
      queueMicrotask(startNextQueued);
    };

    const handleToolStart = (update: JsonRecord) => {
      const id = stringValue(update.toolCallId);
      if (!id) return;
      const name = toolName(update);
      const argsPreview = safeJson(update.rawInput);
      const existing = tools.get(id);
      if (existing) {
        existing.name = name;
        return;
      }
      tools.set(id, { name });
      emit({
        _tag: "AssistantMessage",
        parts: [{ type: "toolCall", toolId: id, name, argsPreview }],
      });
      emit({ _tag: "ToolStart", toolId: id, name, argsPreview });
    };

    const handleToolUpdate = (update: JsonRecord) => {
      const id = stringValue(update.toolCallId);
      if (!id) return;
      if (!tools.has(id)) handleToolStart(update);
      const tool = tools.get(id);
      if (!tool) return;
      const output = contentText(update.content) || stringValue(record(update.rawOutput)?.output_for_prompt);
      if (output) tool.output = output;
      const status = stringValue(update.status);
      if (status === "completed" || status === "failed") {
        tools.delete(id);
        emit({
          _tag: "ToolEnd",
          toolId: id,
          name: tool.name,
          isError: toolFailed(status, update),
          outputPreview: firstLine(tool.output),
        });
      } else if (tool.output) {
        emit({
          _tag: "ToolUpdate",
          toolId: id,
          outputPreview: firstLine(tool.output),
        });
      }
    };

    const handleSessionUpdate = (params: JsonRecord) => {
      if (stringValue(params.sessionId) !== state.sessionId || !state.activeRun) return;
      const update = record(params.update);
      if (!update) return;
      const type = stringValue(update.sessionUpdate);
      const text = stringValue(record(update.content)?.text);
      switch (type) {
        case "agent_message_chunk":
          if (text) {
            state.finalText += text;
            emit({ _tag: "AssistantDelta", kind: "text", delta: text });
          }
          break;
        case "agent_thought_chunk":
          if (text) {
            state.thinkingText += text;
            emit({ _tag: "AssistantDelta", kind: "thinking", delta: text });
          }
          break;
        case "tool_call":
          handleToolStart(update);
          break;
        case "tool_call_update":
          handleToolUpdate(update);
          break;
        case "usage_update": {
          const tokens = numberValue(update.used);
          const contextWindow = numberValue(update.size);
          if (contextWindow !== undefined) {
            state.meta = { ...state.meta, contextWindow };
            emit({ _tag: "MetaChanged", meta: { contextWindow } });
          }
          emit({ _tag: "UsageChanged", tokens, contextWindow });
          break;
        }
      }
      const tokens = numberValue(record(params._meta)?.totalTokens);
      if (tokens !== undefined) {
        emit({
          _tag: "UsageChanged",
          tokens,
          contextWindow: state.meta.contextWindow,
        });
      }
    };

    const handleServerRequest = (message: JsonRecord) => {
      const id = message.id;
      if (typeof id !== "number" && typeof id !== "string") return;
      const method = stringValue(message.method);
      if (method === "session/request_permission") {
        pendingPermissions.add(id);
        const options = records(record(message.params)?.options);
        const selected =
          options.find((option) => stringValue(option.kind) === "allow_always") ??
          options.find((option) => stringValue(option.kind) === "allow_once");
        const optionId = stringValue(selected?.optionId);
        writeMessage({
          jsonrpc: "2.0",
          id,
          result: {
            outcome:
              state.interruptRequested || !optionId
                ? { outcome: "cancelled" }
                : { outcome: "selected", optionId },
          },
        });
        pendingPermissions.delete(id);
        return;
      }
      writeMessage({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Unsupported headless client request: ${method ?? "unknown"}`,
        },
      });
    };

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        emit({
          _tag: "BackendError",
          message: `Invalid Grok ACP line: ${line.slice(0, 512)}`,
        });
        return;
      }
      const message = record(parsed);
      if (!message) return;
      const id = numberValue(message.id);
      if (id !== undefined && pendingRequests.has(id)) {
        const pending = pendingRequests.get(id);
        if (!pending) return;
        pendingRequests.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        if (message.error !== undefined) pending.reject(new Error(protocolError(message.error)));
        else pending.resolve(record(message.result) ?? {});
        return;
      }
      if (message.id !== undefined && message.method !== undefined) {
        handleServerRequest(message);
      } else if (stringValue(message.method) === "session/update") {
        handleSessionUpdate(record(message.params) ?? {});
      }
    };

    const failForProcessExit = (detail: string) => {
      if (state.exited) return;
      state.exited = true;
      rejectPending(detail);
      if (state.closing) return;
      state.closed = true;
      state.pendingPrompts = [];
      emit({ _tag: "QueueChanged", queued: [] });
      if (state.activeRun) {
        settleRun(
          state.interruptRequested
            ? { _tag: "Interrupted", partialText: state.finalText || undefined }
            : {
                _tag: "Failed",
                errorText: boundedError(detail),
                partialText: state.finalText || undefined,
              },
        );
      }
      Queue.endUnsafe(events);
    };

    let stdoutBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      while (true) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
      }
      if (stdoutBuffer.length > STDOUT_BUFFER_MAX_BYTES) {
        stdoutBuffer = "";
        void terminateChild(child, () => state.exited);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      state.stderr = `${state.stderr}${chunk}`.slice(-4096);
    });
    child.once("error", (error) =>
      failForProcessExit(`Grok ACP process failed: ${boundedError(error)}`),
    );
    child.once("exit", (code, signal) => {
      const suffix = firstLine(state.stderr);
      failForProcessExit(
        `Grok ACP process exited (${signal ?? `code ${code ?? "unknown"}`})${suffix ? `: ${suffix}` : ""}`,
      );
    });

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (state.closing) return;
        state.closing = true;
        if (state.interruptTimer) clearTimeout(state.interruptTimer);
        if (state.activeRun) {
          notify("session/cancel", { sessionId: state.sessionId });
          settleRun({
            _tag: "Interrupted",
            partialText: state.finalText || undefined,
          });
        }
        state.closed = true;
        rejectPending("Grok session closed.");
        await terminateChild(child, () => state.exited);
        Queue.endUnsafe(events);
      }),
    );

    const sessionResult = yield* Effect.tryPromise({
      try: async () => {
        const initialized = await request("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "pi-subagents", version: "2.0.0" },
          clientCapabilities: {},
        });
        const authMethods = records(initialized.authMethods);
        const authIds = authMethods
          .map((method) => stringValue(method.id))
          .filter((id): id is string => id !== undefined);
        const preferredAuth = authIds.includes("cached_token")
          ? "cached_token"
          : authIds.includes("xai.api_key")
            ? "xai.api_key"
            : undefined;
        if (!preferredAuth) {
          throw new Error(
            "No non-interactive Grok authentication is available. Run `grok login` first.",
          );
        }
        await request("authenticate", {
          methodId: preferredAuth,
          _meta: { headless: true },
        });
        return request("session/new", {
          cwd: task.cwd,
          mcpServers: [],
        });
      },
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });

    const sessionId = stringValue(sessionResult.sessionId);
    if (!sessionId) {
      return yield* new SpawnError({ message: "Grok session/new returned no session id." });
    }
    state.sessionId = sessionId;
    const models = modelState(sessionResult.models);
    const sessionDetail = record(record(sessionResult._meta)?.["x.ai/sessionDetail"]);
    const sessionCwd = stringValue(sessionDetail?.cwd) ?? task.cwd;
    state.meta = {
      backend: "grok",
      modelLabel: models.modelLabel ?? task.model,
      contextWindow: models.contextWindow,
      nativeSessionId: sessionId,
      sessionFilePath: path.join(
        os.homedir(),
        ".grok",
        "sessions",
        encodeURIComponent(sessionCwd),
        sessionId,
      ),
    };
    emit({ _tag: "MetaChanged", meta: state.meta });

    function startRun(text: string) {
      if (state.closed || state.activeRun || !state.sessionId) return;
      const serial = ++state.runSerial;
      state.activeRun = true;
      state.interruptRequested = false;
      state.finalText = "";
      state.thinkingText = "";
      emit({ _tag: "UserMessage", text });
      emit({ _tag: "RunStarted" });

      void request(
        "session/prompt",
        {
          sessionId: state.sessionId,
          prompt: [{ type: "text", text }],
        },
        undefined,
      ).then(
        (result) => {
          if (!state.activeRun || serial !== state.runSerial) return;
          const resultMeta = record(result._meta);
          const modelLabel = stringValue(resultMeta?.modelId);
          if (modelLabel && modelLabel !== state.meta.modelLabel) {
            state.meta = { ...state.meta, modelLabel };
            emit({ _tag: "MetaChanged", meta: { modelLabel } });
          }
          emit({
            _tag: "UsageChanged",
            tokens: numberValue(resultMeta?.totalTokens),
            contextWindow: state.meta.contextWindow,
          });
          const stopReason = stringValue(result.stopReason);
          if (state.interruptRequested || stopReason === "cancelled") {
            settleRun(
              { _tag: "Interrupted", partialText: state.finalText || undefined },
              serial,
            );
          } else if (stopReason === "end_turn" || stopReason === "max_tokens") {
            settleRun({ _tag: "Completed", finalText: state.finalText }, serial);
          } else {
            settleRun(
              {
                _tag: "Failed",
                errorText: `Grok stopped with reason: ${stopReason ?? "unknown"}`,
                partialText: state.finalText || undefined,
              },
              serial,
            );
          }
        },
        (error) => {
          if (!state.activeRun || serial !== state.runSerial) return;
          settleRun(
            state.interruptRequested
              ? { _tag: "Interrupted", partialText: state.finalText || undefined }
              : {
                  _tag: "Failed",
                  errorText: boundedError(error),
                  partialText: state.finalText || undefined,
                },
            serial,
          );
        },
      );
    }

    startRun(task.prompt);

    return {
      meta: Effect.sync(() => state.meta),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
          if (state.closed) {
            return new SendError({ message: "Subagent session is closed." });
          }
          if (state.activeRun) {
            state.pendingPrompts.push(text);
            emit({ _tag: "QueueChanged", queued: queuedView() });
            return Effect.void;
          }
          return Effect.sync(() => startRun(text));
        }),
      interrupt: Effect.promise(async () => {
        if (state.closed || !state.activeRun || !state.sessionId) return;
        const serial = state.runSerial;
        state.pendingPrompts = [];
        emit({ _tag: "QueueChanged", queued: [] });
        state.interruptRequested = true;
        for (const id of pendingPermissions) {
          writeMessage({
            jsonrpc: "2.0",
            id,
            result: { outcome: { outcome: "cancelled" } },
          });
        }
        pendingPermissions.clear();
        notify("session/cancel", { sessionId: state.sessionId });
        if (state.interruptTimer) clearTimeout(state.interruptTimer);
        state.interruptTimer = setTimeout(() => {
          if (state.activeRun && serial === state.runSerial) {
            settleRun(
              { _tag: "Interrupted", partialText: state.finalText || undefined },
              serial,
            );
            void terminateChild(child, () => state.exited);
          }
        }, INTERRUPT_FALLBACK_MS);
      }),
    } satisfies SubagentSession;
  });

function killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Process group may already be gone; signal the direct child below.
    }
  }
  child.kill(signal);
}

function terminateChild(
  child: ChildProcessWithoutNullStreams,
  exited: () => boolean,
) {
  if (exited()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let lastTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (lastTimer) clearTimeout(lastTimer);
      resolve();
    };
    child.once("exit", finish);
    killTree(child, "SIGTERM");
    forceTimer = setTimeout(() => {
      if (!exited()) killTree(child, "SIGKILL");
    }, FORCE_KILL_AFTER_MS);
    lastTimer = setTimeout(finish, FORCE_KILL_AFTER_MS + 500);
  });
}

export const grokBackend: SubagentBackend = {
  name: "grok",
  capabilities: {
    steering: false,
    modelSelection: true,
    reasoningEffort: true,
  },
  available: Effect.sync(() => resolveGrokBinary() !== undefined),
  spawn: makeGrokSession,
};
