/**
 * TerminalManager — owns the registry of running/settled background
 * terminals.
 *
 * Each terminal is a raw `node:child_process` spawn (own process group on
 * POSIX, stdin ignored) whose stdout/stderr 'data' callbacks fold into two
 * bounded OutputBuffers. Closing a terminal's scope terminates its launched
 * process group on POSIX; Windows uses taskkill /T.
 *
 * The manager also exposes a synchronous `TerminalReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget kills without touching the Effect runtime.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Layer,
  Scope,
} from "effect";
import {
  ConcurrencyLimitError,
  formatExit,
  SpawnError,
  UnknownTerminalError,
  type TerminalSnapshot,
  type TerminalStatus,
} from "./domain.ts";
import { OutputBuffer } from "./output.ts";

export const MAX_RUNNING = 8;
export const MAX_TRACKED = 32;
const MAX_SETTLED_HISTORY = MAX_TRACKED * 4;
/** In-memory retained cap per stream; the spill file keeps the full capture. */
export const RETAINED_PER_STREAM = 2 * 1024 * 1024;
const STOP_TIMEOUT_MS = 5_000;
/** SIGTERM is normally enough; the second deadline covers a wedged process. */
const FORCE_KILL_AFTER_MS = 2_000;
/** After termination, how long to wait for the natural close→flush→settle
 * path before force-settling (a grandchild can hold the stdio pipes open). */
const SETTLE_GRACE_MS = 1_000;
/** Bound on waiting for spill WriteStreams to flush before settling; a hung
 * filesystem must not leave an exited entry "running" (and kill() waiting).
 * Terminate (≤2.5s) + settle grace (1s) + flush (1.5s) stays inside the 5s
 * scope-close bound, so teardown remains bounded end to end. */
const SPILL_FLUSH_TIMEOUT_MS = 1_500;
const ERROR_TEXT_MAX_LENGTH = 4_096;

function bounded(text: string) {
  return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

function boundedError(error: unknown) {
  return bounded(error instanceof Error ? error.message : String(error));
}

// --- Internal state -----------------------------------------------------------

/** Mutable snapshot; exposed to readers via the readonly TerminalSnapshot type.
 * stdout/stderr are getters over the live OutputBuffers. */
interface MutableSnapshot extends TerminalSnapshot {
  status: TerminalStatus;
  pid?: number;
  settledAt?: number;
  exitCode?: number;
  signal?: string;
  errorText?: string;
}

interface Entry {
  snapshot: MutableSnapshot;
  child: ChildProcess;
  scope: Scope.Closeable;
  stdoutBuf: OutputBuffer;
  stderrBuf: OutputBuffer;
  spillStreams: fs.WriteStream[];
  /** Set in the same synchronous effect that sends SIGTERM so a natural exit
   * before signaling keeps its truthful status. */
  killSignaled: boolean;
  /** The child emitted 'error' (spawn failure etc.); settles as "failed".
   * Kept separate from errorText, which also carries non-fatal notes
   * (spill failures) that must not flip a clean exit to "failed". */
  processErrored: boolean;
  /** 'exit' event observed (code/signal recorded). */
  exited: boolean;
  /** 'close' event observed (stdio flushed; the settle trigger). */
  stdioClosed: boolean;
  /** The owned process group was observed gone or was synchronously reaped.
   * Once true, late pruning/disposal must never signal its reusable group id. */
  groupCleanupComplete: boolean;
  /** A settle-after-spill-flush is in flight; don't start a second one. */
  settling: boolean;
  /** The shell exited; an immediate bounded scope close is queued to reap
   * surviving members of Pi's launched process group. */
  exitCleanupStarted: boolean;
  /** Completed exactly once when the entry settles. Kill callers and the scope
   * finalizer can all await the same result without missing a notification. */
  settled: Deferred.Deferred<void>;
}

export interface StartOptions {
  readonly command: string;
  readonly title: string;
  readonly cwd: string;
}

export interface KillResult {
  readonly id: string;
  readonly title: string;
  readonly status: TerminalStatus;
  /** True when the entry was still running when this kill began. */
  readonly wasRunning: boolean;
  /** True when this call initiated the termination AND the entry settled as
   * killed (a natural exit that won the race reports killed: false). */
  readonly killed: boolean;
  /** Final exit rendering ("exit 0", "SIGTERM", ...) captured at settle time,
   * so reports stay accurate even if the entry is pruned afterwards. */
  readonly exit: string;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface TerminalReadModel {
  list(): ReadonlyArray<TerminalSnapshot>;
  get(id: string): TerminalSnapshot | undefined;
  size(): number;
  /** Any-change notification (widget, /ps list). */
  subscribe(listener: () => void): () => void;
  /** Per-terminal notification (/ps detail view). */
  subscribeTo(id: string, listener: () => void): () => void;
  /** Fire-and-forget kill (dashboard/detail `x`). Not marked consumed: the
   * settle still flows back to the model as a follow-up message. */
  requestKill(id: string): void;
  /**
   * Register the settle hook. `consumed` is true when an active bg_kill is
   * collecting the result (so it must not also be delivered as a follow-up).
   */
  setOnSettled(
    hook: ((snap: TerminalSnapshot, consumed: boolean) => void) | undefined,
  ): void;
}

// --- Service --------------------------------------------------------------------

export interface TerminalManagerShape {
  start(
    options: StartOptions,
  ): Effect.Effect<TerminalSnapshot, SpawnError | ConcurrencyLimitError>;
  status(id: string): Effect.Effect<TerminalSnapshot, UnknownTerminalError>;
  /** Kill running terminals; resolves only after they have settled. */
  kill(ids: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<KillResult>>;
  readonly list: Effect.Effect<ReadonlyArray<TerminalSnapshot>>;
  readonly disposeAll: Effect.Effect<void>;
  readonly view: TerminalReadModel;
}

export class TerminalManager extends Context.Service<
  TerminalManager,
  TerminalManagerShape
>()("background-terminals/TerminalManager") {}

// --- Process helpers ------------------------------------------------------------

function shellInvocation(command: string) {
  if (process.platform === "win32") {
    const shell = process.env.ComSpec ?? "cmd.exe";
    // Match Node's exec() quoting contract: /s requires one outer quote pair,
    // and verbatim arguments prevent spawn() from escaping that pair again.
    return {
      shell,
      args: ["/d", "/s", "/c", `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { shell: "/bin/sh", args: ["-c", command], windowsVerbatimArguments: false };
}

/** Signal Pi's launched process group on POSIX. Windows uses taskkill /T.
 * Processes that create a new session are outside this ownership boundary. */
function signalOwnedProcesses(child: ChildProcess, signal: NodeJS.Signals) {
  if (process.platform === "win32" && child.pid) {
    try {
      const killer = spawn(
        "taskkill",
        [
          "/pid",
          String(child.pid),
          "/T",
          ...(signal === "SIGKILL" ? ["/F"] : []),
        ],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("error", () => {
        try {
          child.kill(signal);
        } catch {
          // Process may already be gone.
        }
      });
      killer.once("exit", (code) => {
        if (code === 0) return;
        try {
          child.kill(signal);
        } catch {
          // Process may already be gone.
        }
      });
      killer.unref();
      return;
    } catch {
      // Fall through to the direct signal when taskkill cannot be launched.
    }
  }
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group may already be gone; fall through to the direct signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process may already be gone.
  }
}

/** POSIX background terminals own a process group whose lifetime is independent
 * of the shell and its stdio. `close` is therefore not evidence that redirected
 * same-group descendants are gone. Windows keeps the prior stdio-based
 * fallback because taskkill /T owns discovery there. */
function ownedProcessesAlive(child: ChildProcess, stdioClosed: () => boolean) {
  if (process.platform === "win32" || !child.pid) return !stdioClosed();
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Poll process-group existence without retaining timers after interruption. */
function awaitOwnedProcessesExit(
  child: ChildProcess,
  stdioClosed: () => boolean,
) {
  return Effect.callback<void>((resume) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (!ownedProcessesAlive(child, stdioClosed)) {
        resume(Effect.void);
        return;
      }
      timer = setTimeout(check, 25);
    };
    check();
    return Effect.sync(() => {
      if (timer) clearTimeout(timer);
    });
  });
}

/** SIGTERM → deadline → SIGKILL for Pi's owned processes. On POSIX this
 * waits for launched-process-group disappearance, not shell/stdio closure. */
function terminateChild(
  child: ChildProcess,
  stdioClosed: () => boolean,
  onSignal: () => void,
) {
  return Effect.suspend(() => {
    if (!ownedProcessesAlive(child, stdioClosed)) return Effect.void;
    return Effect.gen(function* () {
      yield* Effect.sync(() => {
        onSignal();
        signalOwnedProcesses(child, "SIGTERM");
      });
      yield* awaitOwnedProcessesExit(child, stdioClosed).pipe(
        Effect.timeout(FORCE_KILL_AFTER_MS),
        Effect.ignore,
      );
      if (!ownedProcessesAlive(child, stdioClosed)) return;
      yield* Effect.sync(() => signalOwnedProcesses(child, "SIGKILL"));
      yield* awaitOwnedProcessesExit(child, stdioClosed).pipe(
        Effect.timeout(500),
        Effect.ignore,
      );
    });
  });
}

/** Capture a decoded stream in memory while piping it to disk. Node's pipe
 * contract pauses the readable when destination.write() returns false and
 * resumes only after drain, bounding the WriteStream queue under firehose
 * output. The destination stays open so settlement can end+flush it itself. */
export function pipeSpillWithBackpressure(
  source: Readable,
  destination: Writable | undefined,
  capture: (chunk: string) => void,
) {
  source.setEncoding("utf8");
  source.on("data", capture);
  if (destination) source.pipe(destination, { end: false });
}

// --- Implementation --------------------------------------------------------------

const makeManager = Effect.gen(function* () {
  // Scoped detached forker for sync contexts (read-model kills, process-event
  // settlement, pruning). Completed fibers remove themselves; manager scope
  // close interrupts any work that outlives the bounded disposeAll wait.
  const cleanupFibers = yield* FiberSet.make();
  const runCleanup = yield* FiberSet.runtime(cleanupFibers)();

  const entries = new Map<string, Entry>();
  /** Small immutable tombstones preserve truthful kill reports if pruning
   * races the tool boundary after an id was validated. */
  const settledHistory = new Map<
    string,
    Pick<KillResult, "title" | "status" | "exit">
  >();
  /** ids with an in-flight kill() collecting the result (settle → consumed). */
  const killInterest = new Map<string, number>();
  const listeners = new Set<() => void>();
  const idListeners = new Map<string, Set<() => void>>();
  let counter = 0;
  let reserved = 0;
  let disposed = false;
  let spillDir: string | undefined | null;
  let onSettled:
    ((snap: TerminalSnapshot, consumed: boolean) => void) | undefined;

  const notify = (id?: string) => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A failed widget/render listener must not corrupt lifecycle state.
      }
    }
    if (id) {
      for (const listener of idListeners.get(id) ?? []) {
        try {
          listener();
        } catch {
          // Same.
        }
      }
    }
  };

  const runningCount = () =>
    [...entries.values()].filter((e) => e.snapshot.status === "running").length;

  const addKillInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) killInterest.set(id, (killInterest.get(id) ?? 0) + 1);
  };
  const releaseKillInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const count = (killInterest.get(id) ?? 1) - 1;
      if (count <= 0) killInterest.delete(id);
      else killInterest.set(id, count);
    }
  };

  const closeEntryScope = (entry: Entry) =>
    Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);

  const pruneSettled = () => {
    if (entries.size <= MAX_TRACKED) return;
    const candidates = [...entries.values()]
      .filter(
        (e) =>
          e.snapshot.status !== "running" && !killInterest.has(e.snapshot.id),
      )
      .sort(
        (a, b) =>
          (a.snapshot.settledAt ?? a.snapshot.createdAt) -
          (b.snapshot.settledAt ?? b.snapshot.createdAt),
      );
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED) break;
      entries.delete(entry.snapshot.id);
      runCleanup(closeEntryScope(entry));
    }
  };

  /** End all spill streams; resolves when their buffers are flushed to disk
   * (bounded), so a settle notification never points at a partial file. */
  const flushSpillStreams = (entry: Entry) => {
    const streams = entry.spillStreams;
    entry.spillStreams = [];
    return Effect.forEach(
      streams,
      (stream) =>
        Effect.callback<void>((resume) => {
          const done = () => resume(Effect.void);
          try {
            stream.end(done);
          } catch {
            // Best effort; tmpdir contents are disposable.
            done();
          }
        }),
      { concurrency: "unbounded", discard: true },
    ).pipe(
      Effect.timeoutOrElse({
        duration: SPILL_FLUSH_TIMEOUT_MS,
        orElse: () =>
          Effect.sync(() => {
            entry.stdoutBuf.spillPath = undefined;
            entry.stderrBuf.spillPath = undefined;
            entry.snapshot.errorText ??=
              "Full-log spill flush timed out; full output may be incomplete";
          }),
      }),
    );
  };

  /** Single settle path — idempotent; kill vs natural exit vs error races are
   * resolved by whichever lands first (the second call is a no-op). */
  const settle = (entry: Entry) => {
    const s = entry.snapshot;
    if (s.status !== "running") return;
    s.settledAt = Date.now();
    s.status = entry.killSignaled
      ? "killed"
      : entry.processErrored
        ? "failed"
        : s.exitCode === 0
          ? "done"
          : "failed";
    settledHistory.set(s.id, {
      title: s.title,
      status: s.status,
      exit: formatExit(s),
    });
    while (settledHistory.size > MAX_SETTLED_HISTORY) {
      const oldest = settledHistory.keys().next().value;
      if (oldest === undefined) break;
      settledHistory.delete(oldest);
    }
    // Completing the Deferred can immediately resume kill waiters, whose
    // ensuring blocks release interest. Snapshot consumption first so the
    // settle hook observes the interest that existed when settlement won.
    const consumed = (killInterest.get(s.id) ?? 0) > 0;
    Deferred.doneUnsafe(entry.settled, Effect.void);
    notify(s.id);
    try {
      // During teardown, don't queue results into a shutting-down session.
      if (!disposed) onSettled?.(s, consumed);
    } catch {
      // The parent session may be unavailable; settlement stays final.
    }
    pruneSettled();
  };

  /** Flush the spill files, then settle: the completion follow-up (and the
   * kill() resolution) reference the spill path, so the full capture must be
   * on disk before anyone is told about it. Idempotent via `settling`. */
  const settleAfterFlush = (entry: Entry) => {
    if (entry.settling || entry.snapshot.status !== "running") return;
    entry.settling = true;
    runCleanup(
      flushSpillStreams(entry).pipe(
        Effect.andThen(Effect.sync(() => settle(entry))),
      ),
    );
  };

  const scheduleExitCleanup = (entry: Entry) => {
    if (entry.exitCleanupStarted) return;
    entry.exitCleanupStarted = true;
    // Close promptly at shell exit. The finalizer reaps any surviving owned
    // process group before its id can be reused, while `entry.exited` keeps
    // the shell's natural done/failed classification truthful.
    runCleanup(
      closeEntryScope(entry).pipe(
        Effect.timeout(STOP_TIMEOUT_MS),
        Effect.ignore,
      ),
    );
  };

  const resolveSpillDir = () => {
    if (spillDir !== undefined) return spillDir ?? undefined;
    try {
      const base = path.join(os.tmpdir(), "pi-background-terminals");
      fs.mkdirSync(base, { recursive: true, mode: 0o700 });
      fs.chmodSync(base, 0o700);
      spillDir = fs.mkdtempSync(path.join(base, "session-"));
      fs.chmodSync(spillDir, 0o700);
    } catch {
      spillDir = null;
    }
    return spillDir ?? undefined;
  };

  const makeSpill = (
    entry: () => Entry | undefined,
    id: string,
    stream: "stdout" | "stderr",
  ) => {
    const dir = resolveSpillDir();
    if (!dir) return undefined;
    const spillPath = path.join(dir, `${id}.${stream}.log`);
    try {
      const file = fs.createWriteStream(spillPath, {
        flags: "a",
        mode: 0o600,
      });
      file.on("error", (error) => {
        const current = entry();
        if (current) {
          const buf =
            stream === "stdout" ? current.stdoutBuf : current.stderrBuf;
          buf.spillPath = undefined;
          current.snapshot.errorText ??= bounded(
            `Full-log spill to ${spillPath} failed: ${boundedError(error)}`,
          );
        }
      });
      return { spillPath, file };
    } catch {
      return undefined;
    }
  };

  const start = (options: StartOptions) =>
    Effect.gen(function* () {
      // Reserve synchronously (before the first yield inside doStart) so
      // parallel tool calls cannot race past the cap.
      yield* Effect.suspend(
        (): Effect.Effect<void, SpawnError | ConcurrencyLimitError> => {
          if (disposed) {
            return new SpawnError({
              message: "Background terminal manager is shutting down.",
            });
          }
          if (runningCount() + reserved >= MAX_RUNNING) {
            return new ConcurrencyLimitError({
              message: `Max ${MAX_RUNNING} background terminals can run concurrently. Stop one with bg_kill before starting another.`,
            });
          }
          reserved++;
          return Effect.void;
        },
      );

      const doStart = Effect.gen(function* () {
        const { shell, args, windowsVerbatimArguments } = shellInvocation(options.command);
        const child = yield* Effect.try({
          try: () =>
            spawn(shell, args, {
              cwd: options.cwd,
              env: process.env,
              // stdin IGNORED: there is no input surface, ever. A process
              // that reads stdin sees EOF immediately.
              stdio: ["ignore", "pipe", "pipe"],
              // Own process group on POSIX; new-session daemons are outside it.
              detached: process.platform !== "win32",
              windowsVerbatimArguments: process.platform === "win32" && windowsVerbatimArguments,
            }),
          catch: (error) => new SpawnError({ message: boundedError(error) }),
        });

        const id = `bt-${++counter}`;
        const entryRef = () => entries.get(id);
        const stdoutSpill = makeSpill(entryRef, id, "stdout");
        const stderrSpill = makeSpill(entryRef, id, "stderr");
        const stdoutBuf = new OutputBuffer(RETAINED_PER_STREAM);
        const stderrBuf = new OutputBuffer(RETAINED_PER_STREAM);
        stdoutBuf.spillPath = stdoutSpill?.spillPath;
        stderrBuf.spillPath = stderrSpill?.spillPath;

        const snapshot: MutableSnapshot = {
          id,
          command: options.command,
          title: options.title,
          cwd: options.cwd,
          pid: child.pid,
          status: "running",
          createdAt: Date.now(),
          get stdout() {
            return stdoutBuf.view();
          },
          get stderr() {
            return stderrBuf.view();
          },
        };

        const scope = yield* Scope.make();
        const settled = yield* Deferred.make<void>();
        const entry: Entry = {
          snapshot,
          child,
          scope,
          stdoutBuf,
          stderrBuf,
          spillStreams: [stdoutSpill?.file, stderrSpill?.file].filter(
            (file): file is fs.WriteStream => file !== undefined,
          ),
          killSignaled: false,
          processErrored: false,
          exited: false,
          stdioClosed: false,
          groupCleanupComplete: false,
          settling: false,
          exitCleanupStarted: false,
          settled,
        };

        // Keep bounded decoded tails in memory and independently pipe the
        // same readable into its spill file so Node enforces backpressure.
        if (child.stdout) {
          pipeSpillWithBackpressure(child.stdout, stdoutSpill?.file, (chunk) => {
            stdoutBuf.push(chunk);
            notify(id);
          });
        }
        if (child.stderr) {
          pipeSpillWithBackpressure(child.stderr, stderrSpill?.file, (chunk) => {
            stderrBuf.push(chunk);
            notify(id);
          });
        }
        // Spawn failures (ENOENT etc.) arrive via 'error', not a throw. Node
        // still emits 'close' afterwards (with a bogus errno as code), so
        // record the failure here and let the close path do the one settle.
        child.once("error", (error) => {
          entry.processErrored = true;
          snapshot.errorText ??= boundedError(error);
          entry.exited = true;
          settleAfterFlush(entry);
          scheduleExitCleanup(entry);
        });
        // Record code/signal on 'exit'; settle on 'close' so the completion
        // notification always carries the final flushed output.
        child.once("exit", (code, signal) => {
          entry.exited = true;
          snapshot.exitCode = code ?? undefined;
          snapshot.signal = signal ?? undefined;
          // A same-group descendant can keep the pipes open after the shell
          // exits. Close the scope promptly to terminate the launched process
          // group and force a bounded settlement.
          scheduleExitCleanup(entry);
        });
        child.once("close", (code, signal) => {
          entry.exited = true;
          entry.stdioClosed = true;
          // Only trust close's code/signal when 'exit' never fired (a spawn
          // 'error' close reports the errno, e.g. -2, as its code).
          if (!entry.processErrored) {
            snapshot.exitCode ??= code ?? undefined;
            snapshot.signal ??= signal ?? undefined;
          }
          // A redirected same-group descendant can outlive both shell exit
          // and stdio close. Do not settle until Pi's group is reaped.
          if (ownedProcessesAlive(child, () => entry.stdioClosed)) {
            scheduleExitCleanup(entry);
          } else {
            entry.groupCleanupComplete = true;
            settleAfterFlush(entry);
          }
        });

        // One teardown path: kill(), requestKill, pruning, disposeAll, and
        // runtime.dispose() all converge on closing this scope.
        yield* Scope.provide(
          Effect.addFinalizer(() =>
            Effect.gen(function* () {
              // Only claim "killed" when we are actually about to signal a
              // live process; a natural exit that already happened (still
              // waiting on 'close') keeps its truthful done/failed status.
              if (!entry.groupCleanupComplete) {
                yield* terminateChild(
                  child,
                  () => entry.stdioClosed,
                  () => {
                    entry.killSignaled ||=
                      !entry.exited && entry.snapshot.status === "running";
                  },
                );
                entry.groupCleanupComplete = true;
              }
              // If stdio closed while the process group was still alive, the
              // close callback intentionally deferred settlement. The owned
              // group is gone now, so flush and settle rather than waiting for
              // an event that already happened.
              if (
                entry.snapshot.status === "running" &&
                entry.stdioClosed &&
                !entry.settling
              ) {
                entry.settling = true;
                yield* flushSpillStreams(entry);
                settle(entry);
              }
              // Otherwise give the natural close→flush→settle path a bounded
              // grace, then force settlement if stdio never closes.
              if (entry.snapshot.status === "running") {
                yield* Deferred.await(entry.settled).pipe(
                  Effect.timeout(SETTLE_GRACE_MS),
                  Effect.ignore,
                );
              }
              if (entry.snapshot.status === "running" && !entry.settling) {
                // Force the settle ourselves. When `settling` is set, the
                // close path's flush→settle is already in flight (bounded by
                // SPILL_FLUSH_TIMEOUT_MS) — settling here first would cite a
                // spill file that is still being flushed.
                if (!entry.stdioClosed) {
                  entry.snapshot.errorText ??=
                    "stdio did not close after termination; output may be incomplete";
                }
                entry.settling = true;
                yield* flushSpillStreams(entry);
                settle(entry);
              }
            }),
          ),
          scope,
        );

        // disposeAll may have swept the entries map while we were setting up;
        // an entry added after the sweep would never be torn down. Close our
        // own scope (kills the child) and fail instead (subagents precedent).
        if (disposed) {
          yield* closeEntryScope(entry);
          return yield* new SpawnError({
            message: "Background terminal manager shut down while starting.",
          });
        }
        entries.set(id, entry);
        notify(id);
        return snapshot as TerminalSnapshot;
      });

      // Uninterruptible: between spawn() and entries.set there must be no
      // window where an interrupt (tool abort, runtime dispose) leaves a
      // live child that no scope/registry knows about. All steps are sync.
      return yield* doStart.pipe(
        Effect.uninterruptible,
        Effect.ensuring(
          Effect.sync(() => {
            reserved--;
            notify();
          }),
        ),
      );
    });

  const status = (id: string) =>
    Effect.suspend(
      (): Effect.Effect<TerminalSnapshot, UnknownTerminalError> => {
        const entry = entries.get(id);
        if (!entry) {
          const known = [...entries.keys()];
          return new UnknownTerminalError({
            message: `Unknown terminal id "${id}". Known: ${known.join(", ") || "none"}.`,
          });
        }
        return Effect.succeed(entry.snapshot as TerminalSnapshot);
      },
    );

  /** Kill one running entry: close the scope — whose finalizer marks the kill
   * at the signal point, terminates Pi's owned processes, and force-settles —
   * in a DETACHED fiber. Once the flag is set the termination must actually
   * happen; a tool abort interrupting the caller cannot cancel it (this is
   * what makes "termination continues in the background" truthful). */
  const killEntry = (entry: Entry) =>
    Effect.sync(() => {
      if (entry.snapshot.status !== "running") return;
      runCleanup(
        closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        ),
      );
    });

  const kill = (ids: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      const byId = new Map(
        unique
          .map((id) => entries.get(id))
          .filter((entry): entry is Entry => entry !== undefined)
          .map((entry) => [entry.snapshot.id, entry]),
      );
      const running = [...byId.values()].filter(
        (entry) => entry.snapshot.status === "running",
      );
      const runningIds = running.map((entry) => entry.snapshot.id);
      // Mark consumed before signaling so this kill's settlements are not
      // ALSO queued as automatic follow-up messages to the model.
      addKillInterest(runningIds);
      const work = Effect.gen(function* () {
        yield* Effect.forEach(running, killEntry, {
          concurrency: "unbounded",
        });
        // Every caller waits on the entries that were running when its kill
        // began. Deferred completion cannot be missed and supports concurrent
        // overlapping/multi-id kill calls.
        yield* Effect.forEach(
          running,
          (entry) => Deferred.await(entry.settled),
          { concurrency: "unbounded", discard: true },
        );
        // Capture the report BEFORE the ensuring below releases interest and
        // prunes — a just-settled entry must not vanish out from under it.
        return unique.map((id): KillResult => {
          const snapshot = byId.get(id)?.snapshot;
          const history = settledHistory.get(id);
          const status = snapshot?.status ?? history?.status ?? "killed";
          const wasRunning = runningIds.includes(id);
          return {
            id,
            title: snapshot?.title ?? history?.title ?? "?",
            status,
            wasRunning,
            // A natural exit can win the race with our SIGTERM; report what
            // actually happened rather than claiming the kill did it.
            killed: wasRunning && status === "killed",
            exit: snapshot
              ? formatExit(snapshot)
              : (history?.exit ?? "unknown"),
          };
        });
      });
      return work.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseKillInterest(runningIds);
            pruneSettled();
          }),
        ),
      );
    });

  const disposeAll = Effect.gen(function* () {
    disposed = true;
    const all = [...entries.values()];
    entries.clear();
    yield* Effect.forEach(
      all,
      (entry) =>
        closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        ),
      { concurrency: "unbounded" },
    );
    // Detached kill/prune/flush work is scoped to the manager. Wait for it
    // within the shutdown bound; the FiberSet finalizer interrupts anything
    // still live when the manager scope closes, so cleanup cannot leak.
    yield* FiberSet.awaitEmpty(cleanupFibers).pipe(
      Effect.timeout(STOP_TIMEOUT_MS),
      Effect.ignore,
    );
    yield* Effect.sync(() => {
      const dir = spillDir;
      spillDir = null;
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });
    yield* Effect.sync(() => notify());
  });

  const view: TerminalReadModel = {
    list: () => [...entries.values()].map((entry) => entry.snapshot),
    get: (id) => entries.get(id)?.snapshot,
    size: () => entries.size,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeTo: (id, listener) => {
      let set = idListeners.get(id);
      if (!set) {
        set = new Set();
        idListeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) idListeners.delete(id);
      };
    },
    requestKill: (id) => {
      const entry = entries.get(id);
      if (!entry) return;
      // UI-initiated kills are not "consumed": the killed result still flows
      // back to the model as a follow-up message (subagents precedent).
      runCleanup(killEntry(entry).pipe(Effect.ignore));
    },
    setOnSettled: (hook) => {
      onSettled = hook;
    },
  };

  // Safety net: disposing the ManagedRuntime tears everything down even if
  // the extension forgot to call disposeAll explicitly.
  yield* Effect.addFinalizer(() => disposeAll);

  return TerminalManager.of({
    start,
    status,
    kill,
    list: Effect.sync(() => [...entries.values()].map((e) => e.snapshot)),
    disposeAll,
    view,
  });
});

export const TerminalManagerLive: Layer.Layer<TerminalManager> = Layer.effect(
  TerminalManager,
  makeManager,
);
