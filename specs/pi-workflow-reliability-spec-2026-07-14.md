# Pi Workflow Reliability Spec

Status: Done — Safety Release A and Reliability Release B are installed and verified
Owner: Setup maintainers
Repository: `portable-pi-setup`
Target: the dependency-aware workflow extension and its pinned `pi-subagents` runtime

## Outcome

Pi workflows must remain correct when agents are paused, stopped, resumed, revived, or run in another worktree. The scheduler must never lose ownership of a live child, unblock a dependent from an unverified result, report a failed control as successful, or make the parent model ingest full workflow state merely to observe the fleet.

A user can launch a long-running DAG, leave the parent idle, inspect it through `/fleet`, safely intervene through workflow-owned controls, and receive one bounded notification when the workflow completes or genuinely needs a decision. Five quiet minutes do not interrupt a productive agent. The parent conversation remains small because reports and raw telemetry stay in artifacts.

This is a repair of the existing design. It is not a replacement scheduler or a general workflow language.

## Evidence behind the spec

The live Chalk run on 2026-07-14 exposed five load-bearing failures:

- `pi-subagents` stored the parent session file path in child status, while RPC stop compared it with the parent UUID. Two stop requests failed with `Async run ... was not found in the active session`, but the wrong-model workflow continued.
- The parent used direct `subagent resume` on workflow-owned nodes. Each resume created a new run ID outside the DAG, leaving the original nodes paused and the dependent reviewer permanently queued.
- A one-minute no-output heuristic was treated as a blocker. Productive workers were interrupted while reasoning or running validation.
- `workflow status` serialized the entire durable state, including prompts, raw snapshots, tool history, and completed reports. One response was 367,210 characters.
- The parent processed 3,807,211 cumulative tokens across 31 turns: 332,182 fresh input, 3,466,240 cached input, and 8,789 output. The final context was about 232,000 tokens and cost `$3.6577` before child costs.

These are acceptance-test fixtures, not historical commentary. The implementation must reproduce each failure before proving it fixed.

## Verified release evidence

Both releases run through the immutable `hhushhas/pi-subagents` commit `5cccd64d39a2e6a95ed557bde24dfcac1f17309e`, pinned identically in the repository and live Pi settings. The runtime package passed 991 unit tests, 465 integration tests, and its real Pi-session end-to-end test. The configuration passed strict typechecking and all 28 scheduler, migration, race, output-budget, and Fleet tests.

The live proof ran in `<temporary proof worktree>` from fresh Pi two isolated temporary sessions:

- Workflow `wf-mrkqx4hh-87cc4cb3` completed a three-node fan-out/fan-in DAG, then retried `a` as `attempt-2`; the replacement merge launched afterward with bindings `{a: attempt-2, b: attempt-1}`. Across the initial run and retry it recorded 29,732 child tokens, `$0.047878`, two bounded 189-byte notifications, and two parent wakes—one per successful terminal episode.
- Workflow `wf-mrkr39vr-2378a89e` causally paused under control `6f81d2a5-13a0-46a8-864a-e71ce1a7457a`, resumed from the paused child as `attempt-2`, and completed the expected file.
- Workflow `wf-mrkr63zv-913595c8` kept PID 63251 healthy and `running` through 5 minutes 16 seconds of intentional tool silence. No stale mutation or extra parent wake occurred.
- Workflow `wf-mrkrfjhu-06425ea1` stopped at workflow level under control `5d3fabb7-24ab-420a-8907-f0804702911d`; its PID exited and `stop-finished.txt` remained absent.
- Workflow `wf-mrkrjjcg-b14c5639` paused its parent, resumed it as `attempt-2`, and launched the dependent only after that success with `dependencyAttemptIds.parent = attempt-2`.
- Workflow `wf-mrkrn9en-092e75bf` retried a succeeded ancestor while its descendant was live. Control `3b4bf7f6-a1b1-48b7-ac74-2f7f339467b9` stopped the old descendant, then authoritative `attempt-2` executions completed with the descendant bound to `ancestor/attempt-2`.

The first proof session consumed 206,884 cumulative parent tokens across 22 assistant turns—30,664 fresh input, 175,104 cached input, 1,116 output, and `$0.274352`. Its initial three-node completion used one 189-byte notification and one parent wake. TTFB remains unavailable because the child runtime does not emit a trustworthy first-token timestamp. `/fleet` loaded in the real TUI with live, recorded, workflow, lineage, authority, provenance, metric, and guarded-control views.

## Scope

The repair includes:

- canonical child and parent identity across spawn, status, interrupt, stop, resume, recovery, and concurrent Pi sessions;
- workflow-owned pause, stop, resume, retry, and nudge;
- explicit execution working directories for workflows and nodes;
- bounded status projections and artifact-only raw state;
- event-only child completion handling for workflow-owned runs;
- conservative attention handling and Fleet controls that cannot act on stale attempts;
- schema migration for existing workflow state;
- focused unit, integration, and real Pi end-to-end proofs.

The repair does not include:

- a new workflow authoring language, loops, conditional expressions, or dynamic fan-out;
- distributed execution across machines;
- automatic model selection or budget optimization;
- production deployment or changes to users' project repositories;
- TTFB until the child runtime exposes a trustworthy first-token timestamp;
- deleting historical workflow runs automatically.

## Canonical language

- **Workflow**: a durable DAG owned by the Pi workflow extension.
- **Node**: one logical unit of work in the DAG.
- **Attempt**: one immutable execution record for a node.
- **Package run**: the concrete `pi-subagents` process identified by a run ID and async directory.
- **Resume**: continue a paused child session through a new package run while preserving node lineage.
- **Retry**: start a fresh child session as a new attempt.
- **Attention**: an informational signal that a run may need inspection. It is not permission to interrupt it.
- **Control accepted**: the runtime acknowledged a request. It is not a terminal state.
- **Control confirmed**: the persisted child artifact proves the requested terminal state.
- **Recorded agent**: any historical node attempt shown by Fleet.
- **Live agent**: a package run whose process and status artifact both indicate it is active.

## Non-negotiable invariants

1. A node has at most one authoritative live package run.
2. Every live package run controlled by a workflow is represented by the node's current attempt before the scheduler reports it running.
3. A dependent becomes ready only after every prerequisite has a persisted, successful terminal result.
4. A failed, rejected, or timed-out control is returned as an error. The state remains conservative and names the possibly live child.
5. Pause and stop are two-phase operations: requested first, confirmed only from a terminal artifact or authoritative runtime response.
6. Resume and retry never overwrite an earlier attempt. Lineage is append-only.
7. Direct `subagent` controls are forbidden for workflow-owned runs. A run revived outside workflow control is evidence-only and cannot release dependencies.
8. Quiet time alone never mutates a run.
9. Model-facing status never contains raw reports, full task briefs, transcripts, or unbounded tool history.
10. Fleet reads durable state and artifacts directly; displaying telemetry must not add it to the parent conversation.
11. A workflow executes in its declared worktree, regardless of the directory from which Pi was launched.
12. Another live Pi process may observe a workflow but cannot control or relaunch it.

## Runtime boundary and package strategy

Keep `pi-subagents` as the execution runtime. Maintain the smallest possible `hhushhas/pi-subagents` compatibility fork, pinned to an immutable commit in `settings.json`, until the fixes ship upstream. The fork must remain suitable for an upstream pull request and may contain only the capabilities this extension cannot provide itself.

The fork owns:

- one canonical session identity and capability contract used by spawn and every RPC control;
- idempotent spawn and lookup by operation ID;
- RPC support for resume and non-interrupting steer, with new run identity returned explicitly;
- control-causal lifecycle artifacts that distinguish natural completion, failure, pause, stop, timeout, and process loss;
- per-run `notificationMode: "event-only"` so workflow children emit lifecycle events without injecting their full reports or triggering parent turns;
- a configurable, bounded preview for ordinary non-workflow completion notifications.

The fork must not own DAG scheduling, persistence, dependency resolution, Fleet rendering, or workflow policy.

### Canonical session identity

Async status schema v2 stores both:

```ts
interface AsyncSessionIdentity {
  orchestratorSessionId: string;          // Pi UUID that created the run
  orchestratorSessionFile?: string;       // durable JSONL path
  workflowId?: string;
  nodeId?: string;
  attemptId?: string;
  workflowCapabilityHash?: string;        // SHA-256 only; plaintext is never written here
  ownerLeaseEpoch?: number;
}
```

The workflow store creates a random 256-bit control capability and persists it only in the mode-`0600` workflow state. Package artifacts store its hash. RPC ping and status are read-only; spawn, interrupt, stop, steer, and resume require the plaintext capability and verify its hash. The Pi UUID identifies the creating session but is not long-lived recovery authority.

Workflow ownership also carries a monotonically increasing lease epoch, a random lease ID, a state revision, and a heartbeat. All mutating scheduler writes run under a per-workflow exclusive lock and compare the expected state revision and lease epoch before replacement. Explicit recovery from another Pi session is allowed only after the previous heartbeat is stale, the previous owner process is proven dead, the user confirms takeover, and the recovering process atomically increments the lease epoch. PID alone never grants authority because PIDs can be reused.

The session file remains evidence and a recovery hint. During migration, a v1 run has no capability and is observation-only unless it completes naturally. It cannot be stopped, resumed, or adopted through a guessed session-file match. Ambiguous authority fails closed with an actionable error.

### RPC control result

Every mutating RPC response has a shared shape:

```ts
interface ControlResult {
  controlRequestId: string;
  accepted: boolean;
  runId: string;
  asyncDir: string;
  previousState: string;
  requestedState: string;
  replacementRunId?: string;
  replacementAsyncDir?: string;
  message: string;
}
```

`accepted: true` means only that the request was delivered. The scheduler continues showing `pausing` or `stopping` until the lifecycle artifact confirms that exact `controlRequestId`. An RPC rejection throws and becomes a tool error.

Async lifecycle artifacts append control requests and identify the terminal cause:

```ts
interface ControlRecord {
  controlRequestId: string;
  action: "pause" | "stop" | "steer" | "resume";
  requestedAt: number;
  acceptedAt?: number;
  confirmedAt?: number;
  error?: string;
}

interface TerminalRecord {
  reason: "completed" | "failed" | "paused" | "stopped" | "timed_out" | "process_lost";
  at: number;
  controlRequestId?: string;
}
```

A natural completion racing with stop is recorded as `completed`, not as confirmation that stop succeeded. The workflow prevents new downstream launches as soon as stop is requested, then reports that the node completed before termination took effect.

## Durable workflow model

Increment the workflow schema to v2. Separate the owner repository from the execution worktree and preserve attempt lineage:

```ts
interface WorkflowRunV2 {
  schemaVersion: 2;
  projectCwd: string;
  executionCwd: string;
  workflowCapability: string; // secret, omitted from every model-facing projection
  ownerLeaseId: string;
  ownerLeaseEpoch: number;
  stateRevision: number;
  // existing ownership, status, timestamps, concurrency, and nodes
}

interface WorkflowNodeSpecV2 {
  // existing fields
  cwd?: string; // relative to executionCwd; cannot escape it
}

interface AttemptBaseV2 {
  // existing immutable identity and telemetry
  id: string;
  childSessionFile?: string;
  dependencyAttemptIds: Record<string, string>;
  controls: Array<{
    controlRequestId: string;
    action: "pause" | "stop" | "resume" | "steer";
    requestedAt: number;
    acceptedAt?: number;
    confirmedAt?: number;
    error?: string;
  }>;
}

interface LaunchedAttemptV2 extends AttemptBaseV2 {
  kind: "initial" | "resume" | "retry";
  launchOperationId: string;
  previousAttemptId?: string;
  sourceRunId?: string;
}

interface LegacyAttemptV2 extends AttemptBaseV2 {
  kind: "legacy";
  controlAvailable: false;
  lookupAvailable: false;
}

type NodeAttemptV2 = LaunchedAttemptV2 | LegacyAttemptV2;
```

Workflow statuses add `pausing`, `stopping`, and terminal `failed`. `blocked` is reserved for recoverable ambiguity, an attention condition requiring a decision, or a dependency that cannot currently proceed. Partial workflow controls remain transitional until every targeted live node has a causal confirmation or an explicit error; the final status reports per-node outcomes.

Migration maps v1 `cwd` to both `projectCwd` and `executionCwd`, preserves all attempts as `kind: "legacy"`, and never fabricates operation IDs or relaunches work. Before migration, the store writes a byte-for-byte backup and a journal containing the source hash, target schema, and state revision. Migration is atomic and restartable. A failed or interrupted migration preserves the v1 file and disables controls. Migrated live v1 attempts are observation-only and cannot be taken over.

## Workflow creation and working directories

`workflow create` accepts an optional absolute `cwd`. It defaults to the active Pi directory. The extension resolves symlinks, requires an existing directory, and records it as `executionCwd`.

A node may optionally declare a relative `cwd` beneath the workflow execution directory. Absolute node paths and `..` escapes are rejected. Both the workflow root and node directory must already exist. The extension resolves their real paths and verifies that the node real path remains inside the workflow real path, so a symlink cannot escape containment. The scheduler passes the resolved node directory to `pi-subagents`; the status artifact must report the same directory before the node is considered running.

The parent repository remains `projectCwd`, so a Pi session launched in `chalk` can safely execute a workflow in `chalk-infra-m0-m2` without moving the workflow store or trusting prompt text to change directories.

## Lifecycle behavior

### Spawn

The scheduler generates and persists a `launchOperationId` before RPC spawn. The package records that operation ID before starting a process, treats it as an idempotency key, and exposes lookup by operation ID. Repeating spawn with the same operation ID returns the existing run instead of creating another.

After spawn, the scheduler atomically records the package run ID and async directory before exposing `running`. If RPC times out or the response is lost, it performs lookup by operation ID before any retry. If persistence fails after spawn, the node becomes `orphaned`, the returned or discovered run identity is included in the error, and the workflow never launches another attempt automatically.

### Pause

Pause requests interruption through workflow RPC, records `pausing`, and waits for a paused or terminal artifact. A failed request leaves the workflow blocked with the package run still treated as live. It never reports `paused` merely because the RPC call returned.

### Resume

Resume is valid only for a confirmed paused attempt. Before RPC resume, the scheduler persists a new attempt with a scheduler-generated `launchOperationId` and the source attempt/run lineage. RPC resume is idempotent by that operation ID, supports lookup after response loss, continues the same child session, and returns a replacement run ID and async directory. Its request and response include effective agent, model, thinking, execution directory, session file, timeout, notification mode, workflow/node/attempt provenance, source run ID, operation ID, and capability hash. The replacement lifecycle artifact must match every field before it becomes authoritative.

The scheduler appends a `kind: "resume"` attempt, persists its lineage, then considers it live. The original attempt remains paused. A resumed success records the exact prerequisite attempt IDs it consumed.

If resume times out, the scheduler looks up the persisted operation ID before retrying. If resume is unsupported or rejected, the node remains paused. The UI offers retry as a separate, explicit fresh-context action.

### Retry

Retry creates a fresh child session and appends `kind: "retry"`. Every node success records `dependencyAttemptIds`, binding its evidence to the exact prerequisite attempts it consumed.

Retrying a node with descendants requires explicit invalidation. The scheduler first stops every live descendant and waits for causal confirmation. If any descendant cannot be stopped, retry fails without launching. It then invalidates every descendant, including succeeded descendants, by retaining their historical attempts and returning their logical nodes to queued. A succeeded node is never retryable through a single unconfirmed keypress.

### Nudge

Nudge uses non-interrupting RPC steer only when the runtime confirms a registered intercom target. Failure to deliver a nudge changes no workflow state. Nudge never aliases to resume and never interrupts a live process.

### Externally revived runs

A generic `subagent resume` is outside workflow authority and cannot produce a workflow launch operation ID. The scheduler may display such a run as untracked evidence when its child session path overlaps a workflow, but it never adopts it, controls it, or releases dependencies from its result. Recovery requires the external run to finish naturally, followed by human review and an explicit workflow retry. This is intentionally less convenient than accepting forgeable lineage.

### Stop

Stop targets the current authoritative run and records a control request ID. The tool returns an error when RPC rejects the request. The node remains `stopping` until its terminal artifact reports `reason: "stopped"` with that request ID. A natural completion, failure, timeout, or unrelated pause is recorded accurately and cannot masquerade as stop confirmation. If confirmation does not arrive within a bounded reconciliation window, the workflow becomes blocked and shows the run ID, PID, async directory, control request ID, and next safe action.

### Completion

The scheduler consumes lifecycle events and status artifacts. A completion for a superseded attempt is recorded but cannot overwrite the current attempt or release dependents. Duplicate events are idempotent.

## Attention policy

Set the global `subagents.control.needsAttentionAfterMs` to five minutes. For workflow-owned runs, use event-only control notifications so the scheduler updates Fleet without waking the parent for ordinary quiet time.

Attention handling follows these rules:

- `needs_attention` adds a badge and timestamp; it does not change the node's lifecycle state.
- A currently running tool cannot be classified as idle. Long tools use their own timeout.
- Repeated mutating-tool failures may raise attention immediately, but still do not cause automatic interruption.
- The parent is awakened only for a question requiring a decision, a terminal failure, a control failure, or a workflow-level blocked state.
- The orchestration prompt explicitly forbids direct `subagent resume`, `interrupt`, or `stop` for workflow-owned runs.

## Compact model-facing status

`workflow status` returns a bounded projection, not the stored `WorkflowRun` object. It includes:

- workflow ID, name, status, owner, execution directory, concurrency, timestamps, and aggregate child cost/tokens;
- per-node ID, label, effective status, dependency IDs, current attempt ID/run ID, model, effort, elapsed time, last activity, compact token/cost totals, and a one-line error;
- suggested safe actions when blocked.

It excludes task text, raw status snapshots, result snapshots, transcript contents, full recent-output arrays, and full reports. Byte limits are measured as UTF-8 bytes over the complete model-visible tool result, including framing text. Workflow names, labels, paths, run IDs, dependency displays, errors, and action hints have explicit per-field caps. Truncation preserves IDs and status first, removes optional hints next, then shortens human text with a visible `… [truncated]` marker. The serialized response must remain below 32 KiB for a 64-node workflow.

`workflow inspect` accepts a node ID and returns bounded current-attempt detail below 8 KiB. Raw durable state is never printed into model context; the tool returns its local artifact path when deep inspection is required.

`workflow list` defaults to active, pausing, stopping, awaiting-resume, paused, blocked, and failed workflows. Historical succeeded/stopped workflows require `includeHistory: true`.

## Notification and parent-turn policy

Workflow-owned child spawns use `notificationMode: "event-only"`. Their completion reports remain in the output artifact and child session file. The DAG scheduler launches newly ready nodes without waking the parent.

The parent receives at most one short notification per workflow transition category for:

- workflow succeeded;
- workflow blocked or failed and needs a decision;
- explicit pause or stop confirmed.

Each notification is capped at 1 KiB and contains counts, failed/blocked node IDs, total child cost/tokens, and artifact paths. It never embeds a child report. Ordinary non-workflow subagents retain completion notifications, but their preview is capped and points to the artifact for the full result.

Notification dedupe uses `(workflowId, stateRevision, transitionCategory)`. Retries after delivery failure reuse the same key. The extension records attempted sends, successful sends, serialized UTF-8 bytes, and whether `triggerTurn` was requested. The successful-workflow budget is exactly one `triggerTurn: true` notification for the terminal success transition; node completions and repeated rendering trigger zero parent turns.

## Fleet behavior

Fleet must distinguish historical records from live processes. Its header shows separate counts, for example:

```text
Fleet · 1 live · 2 attention · 15 recorded · 4 workflows
```

Default view shows active, transitional, awaiting-resume, paused, blocked, and failed workflows plus recently completed workflows from the current session. A history toggle reveals older succeeded/stopped runs.

Each node shows:

- effective lifecycle state and a separate attention badge;
- current authoritative run ID and attempt lineage;
- whether the run is live, stale, superseded, foreign-owned, or an untracked external run;
- execution directory, model, effort, elapsed time, tokens, speed, cost, turns, tools, and bounded recent output;
- the exact dependency preventing a queued node from launching.

Controls are state-aware:

- resume is enabled only for a confirmed paused authoritative attempt;
- retry is distinct from resume and requires confirmation when it invalidates descendants;
- pause and stop are disabled for stale, superseded, or foreign-owned attempts;
- an untracked external run is read-only and explains that it cannot satisfy workflow dependencies;
- destructive or context-losing actions show a confirmation dialog;
- disabled actions explain why instead of silently doing nothing.

Fleet never invokes the generic `subagent` tool and never injects telemetry into the conversation.

## Prompt contract

Update `/orchestrate` so the parent agent follows these rules:

- Set workflow `cwd` explicitly when work occurs in another worktree.
- Use workflow actions for every workflow-owned child. Never call direct `subagent` controls on a workflow run ID.
- Treat attention as a reason to inspect, not to interrupt.
- Prefer Fleet and compact status. Do not request raw workflow state or paste report artifacts into the parent conversation.
- Let the scheduler launch dependents. Do not manually duplicate a queued node.
- If a child was revived outside the DAG, treat it as evidence-only; wait for it to finish, review its artifact, and use workflow retry rather than relying on it as a dependency.
- Report accepted controls as pending until confirmed.

## Telemetry and budgets

Persist workflow-level aggregates without copying full child objects:

- child input, output, cached tokens when available, total tokens, and USD cost;
- attempts, turns, tools, wall time, queue time, and control failures;
- notification count and serialized notification bytes;
- compact status response bytes;
- attention events by reason;
- parent wake count attributable to the workflow.

Raw per-attempt artifacts remain the source of truth. Aggregates are derived and can be rebuilt. No tracked file contains prompts, reports, credentials, or private project output.

The implementation gate uses these budgets:

- compact 64-node workflow status: at most 32 KiB;
- node inspection: at most 8 KiB;
- workflow notification: at most 1 KiB;
- ordinary subagent notification preview: at most 2 KiB;
- one parent wake for an entirely successful workflow, regardless of node count;
- zero parent wakes for quiet-time attention unless a genuine decision is requested.

## Failure behavior

- Missing or malformed status artifact after the spawn grace period makes the attempt orphaned and blocks the workflow; it does not launch a replacement.
- A live PID with an unreadable artifact is treated as possibly live until explicitly reconciled.
- A dead PID with a non-terminal artifact becomes orphaned with recovery instructions.
- RPC timeout, rejection, and unsupported capability are distinct errors and are visible in Fleet.
- Loss of the owner Pi process leaves active workflows awaiting explicit recovery. Nothing automatically relaunches.
- A second Pi process may read persisted state but cannot control it while the owner process lives.
- Schema migration failure preserves the original state file and disables controls for that workflow.
- Notification failure cannot change workflow lifecycle state.

## Implementation phases

Do not use the current workflow DAG to implement its own repair. Until Safety Release Phase A2 passes, one parent agent owns implementation; read-only scouts may inspect code but cannot control or modify the live runtime.

### Safety Release A — Stop the known damage

Release A deliberately disables context-preserving resume. It fixes control truth, working-directory isolation, attention, status size, notification size, and Fleet safety before adding more recovery power.

#### Phase A1 — Compatibility protocol

- [x] Reproduce the UUID/session-file stop mismatch in a package test.
- [x] Reproduce spawn's unknown-outcome window and stop-versus-natural-completion race.
- [x] Create the minimal `hhushhas/pi-subagents` fork with canonical identity, spawn operation IDs, lookup, control request IDs, terminal reasons, event-only notification mode, and bounded previews.
- [x] Make every rejected control surface as an error.
- [x] Prove idempotent spawn, pause, stop, lookup, and status against an isolated real Pi session.

Stop if spawn outcome or control causality remains ambiguous. Do not proceed by sending process signals from the workflow extension.

#### Phase A2 — Safe extension behavior

- [x] Add safety schema v2 with workflow capability, project/execution directories, state revision, initial lease identity, launch operation ID, runtime protocol version, and legacy attempt discrimination.
- [x] Migrate only quiescent v1 workflows through a byte-for-byte backup and restartable journal; retain live v1 runs as observation-only until they finish.
- [x] Separate project and execution directories; validate node-relative directories.
- [x] Make attention orthogonal to lifecycle state.
- [x] Replace raw status serialization with bounded projections and node inspection.
- [x] Suppress parent-turn notifications for workflow-owned child completions.
- [x] Update `/orchestrate` to forbid direct controls on workflow-owned children.
- [x] Add Fleet live/recorded counts, attention, stale-state labels, history filtering, and guarded pause/stop.
- [x] Disable resume and context-losing retry in the tool and Fleet with an explicit “available in Reliability Release B” explanation.
- [x] Add safety-release telemetry and documentation.

#### Phase A3 — Cutover and safety proof

- [x] Refuse cutover while any v1 child is queued or live; list exact run IDs and wait for natural termination.
- [x] Record runtime and RPC protocol versions on every new attempt.
- [x] Pin one immutable fork commit in repository settings only after package and extension gates pass.
- [x] Start a fresh Pi process, confirm no v1 live runs, then update live settings and verify the loaded commit/protocol.
- [x] Run unit, race, output-budget, and UI tests.
- [x] Run a real Pi workflow in a separate temporary git worktree.
- [x] Stop a live node and observe terminal confirmation without child continuation.
- [x] Produce a five-minute quiet period and prove it causes no interruption or parent wake.
- [x] Complete a multi-node workflow and prove only one bounded parent notification occurs.
- [x] Open Fleet and verify live, recorded, stale, and dependency states plus disabled unsafe controls.
- [x] Inspect the parent JSONL and report notification bytes, status bytes, wake count, tokens, and cost.

Safety Release A is independently shippable. Do not claim resume or cross-session takeover support after this release.

### Reliability Release B — Lineage and recovery

#### Phase B1 — Authority, migration, and lineage

- [x] Activate exclusive workflow locks, capability-authorized cross-session control, lease fencing, stale-owner confirmation, and atomic takeover over the Release A schema.
- [x] Extend migration and recovery tests across live-owner, dead-owner, stale-heartbeat, PID-reuse, and interrupted-write cases.
- [x] Add immutable attempt lineage, prerequisite-attempt bindings, control history, and workflow-level transitional states.
- [x] Add resume RPC with the complete effective-execution contract and matching artifact validation.
- [x] Add superseded-completion handling and read-only discovery of external runs.
- [x] Add safe descendant shutdown and invalidation for retry.
- [x] Add workflow-level aggregate telemetry.

#### Phase B2 — Recovery interface

- [x] Add workflow resume, steer, retry, and explicit cross-session takeover actions.
- [x] Add Fleet lineage, provenance, external/superseded labels, guarded takeover, and state-aware controls.
- [x] Update README and CHANGELOG with migration and recovery procedures.

#### Phase B3 — Full recovery proof

- [x] Pause and resume one node, then prove its dependent launches from the resumed attempt's success.
- [x] Lose a resume response and prove operation-ID lookup finds exactly one replacement child attached to the new attempt.
- [x] Simulate a lost spawn response and prove lookup finds exactly one child.
- [x] Retry a succeeded prerequisite and prove all descendants are stopped, invalidated, and rebound to new attempt IDs.
- [x] Discover an externally revived child as read-only evidence and prove it cannot release dependencies or receive workflow controls.
- [x] Kill the owner Pi process, perform an explicitly confirmed lease takeover, and prove two processes cannot acquire it.
- [x] Interrupt migration and prove the v1 backup remains readable and controls stay disabled.
- [x] Run the complete real Pi, package, scheduler, Fleet, migration, race, and cost gates.

## Agent ownership if implementation is delegated

After Safety Release Phase A1 is proven, the remaining work may use isolated lanes:

- **Runtime compatibility lane** owns only the `pi-subagents` fork, its RPC tests, and the pinned source reference.
- **Scheduler lane** owns `lib/workflows/model.ts`, `runtime.ts`, `rpc-client.ts`, `scheduler.ts`, `store.ts`, and their tests.
- **Interface lane** owns `extensions/dag-workflows.ts`, `fleet-overlay.ts`, `/orchestrate`, README, CHANGELOG, and interface tests.
- **Integration reviewer** runs only after all lanes finish. It modifies nothing and verifies cross-boundary contracts and the real Pi proof.

The runtime and scheduler lanes must agree on the RPC and identity types before working in parallel. The scheduler and interface lanes must agree on compact projection and action types. No lane edits another lane's files, and the parent agent performs final integration and commits.

## Required test matrix

Unit and integration tests must cover:

- UUID and session-file identity mismatch, including safe observation-only handling of v1 runs;
- spawn response loss followed by lookup and idempotent replay producing exactly one child;
- stop rejection reported as an error with the child still considered live;
- pause accepted but not yet confirmed, plus natural completion racing with pause/stop;
- pause followed by workflow resume producing a tracked replacement run;
- resume response loss followed by operation-ID lookup producing exactly one replacement run;
- resume preserving agent, model, thinking, cwd, session, timeout, notification, capability, and provenance fields;
- retry stopping live descendants and invalidating every historical descendant success safely;
- success evidence bound to exact prerequisite attempt IDs;
- externally revived runs visible as read-only evidence but unable to release dependencies or receive workflow controls;
- stale or superseded completions unable to release dependencies;
- stop, pause, and completion racing with spawn and persistence;
- two Pi processes observing one workflow without duplicate execution or lease takeover;
- stale-heartbeat takeover requiring a dead owner, explicit confirmation, capability, and atomic lease increment;
- quiet reasoning and a long-running tool not triggering mutation;
- repeated tool failure producing attention without interruption;
- explicit workflow and node working directories, including `..` and symlink escape rejection;
- 64 nodes with 100 KiB fake reports still producing status below 32 KiB;
- adversarial maximum-length names, paths, dependencies, and errors obeying UTF-8 byte budgets and truncation priorities;
- completion notifications containing paths and summaries but not report bodies;
- notification dedupe and exact `triggerTurn` counts;
- Fleet controls disabled for stale, foreign, and superseded attempts;
- schema migration preserving every historical attempt;
- migration interrupted before and after replacement, preserving the backup and journal;
- notification delivery failure leaving workflow state unchanged.

## Definition of done

### Safety Release A done

The safety release is done only when all of the following are observed from the installed live configuration:

1. A workflow launched from repository A executes entirely in declared worktree B.
2. Four independent children can run concurrently without creating duplicate attempts.
3. A lost spawn response is reconciled by operation ID without creating a second child.
4. A live node can be stopped; the artifact causally confirms the request, and the tool never reports a failed or naturally overtaken stop as successful.
5. Five quiet minutes do not interrupt a productive model or wake the parent.
6. A successful multi-node workflow wakes the parent once with a notification below 1 KiB.
7. Model-facing status remains below its byte budgets and contains no full report or task brief.
8. Fleet distinguishes live agents from historical records, cannot control stale attempts, and clearly disables deferred recovery actions.
9. The safety test suite, strict typecheck, diff check, package tests, and real Pi end-to-end proof pass.
10. README and CHANGELOG describe the installed safety behavior, fork pin, disabled recovery features, and remaining TTFB limitation.
11. The live settings and repository settings match, no generated artifacts are tracked, and unrelated user changes remain untouched.

### Reliability Release B done

The complete repair additionally requires:

1. A live node can be paused and resumed through workflow controls; Fleet follows the provenance-backed replacement run and its dependent launches after success.
2. Retrying a prerequisite stops and invalidates all descendants, then binds new successes to the new prerequisite attempt.
3. An externally revived child is visible as evidence but cannot be mistaken for an authoritative attempt or release a dependency.
4. A dead owner can be taken over explicitly, while a live or concurrently claimed owner cannot.
5. Workflow-level pausing, stopping, failed, blocked, and terminal notifications reflect partial outcomes accurately.
6. Migration is restartable, preserves a verified v1 backup, and never controls a live v1 run.
7. The complete package, migration, scheduler, Fleet, race, and real Pi recovery suites pass.
8. README and CHANGELOG describe lineage, migration, takeover, external-run handling, recovery, and remaining TTFB limitations.

No claim of completion is allowed from unit tests alone. The final handoff must include the workflow ID, run IDs, worktree path, terminal states, dependency timing, notification byte counts, parent wake count, token/cost measurement, exact commands, and observed results.

## Effort and stopping point

Safety Release A should be planned as one to two focused days because it includes a package protocol patch and real cutover proof, not merely extension edits. Reliability Release B should be planned as another two to four focused days for capability-backed lineage, idempotent recovery, lease fencing, migration, Fleet controls, and adversarial live proofs. If package changes expose deeper incompatibilities, preserve Release A and rescope Release B rather than weakening its invariants.

Stop after this spec's definition of done. Dynamic fan-out, advanced workflow authoring, TTFB instrumentation, and further visual polish belong to later specs.
