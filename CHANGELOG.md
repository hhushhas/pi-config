# Changelog

## 2026-07-14

- Captured the working Pi configuration in a private source-of-truth repository.
- Removed bundled workflow prompts while retaining their underlying Context7 and subagent capabilities.
- Added manually invoked `/debrief` and `/orchestrate` prompt templates.
- Reduced global agent instructions to basic working, research, verification, and safety rules.
- Added durable dependency-aware DAG workflows over the existing `pi-subagents` runtime, including per-node model and effort overrides, bounded concurrency, pause, stop, retry, and explicit restart recovery.
- Added `/fleet`, a responsive Pi-native overview of dependencies, ownership, lineage, lifecycle, attention, metrics, current activity, external evidence, and recovery controls.
- Replaced the workflow runtime boundary with capability-authorized protocol v2 from the `hhushhas/pi-subagents` fork: idempotent launch lookup, causal pause/stop, acknowledged steering, context-preserving resume, event-only child completion, canonical session identity, and quiet-run safety.
- Migrated workflow storage to schema v2 with byte-preserving v1 migration, kernel-locked revisions, lease fencing and dead-owner takeover, immutable attempt lineage, dependency-attempt bindings, external-run evidence, descendant-safe retry, and aggregate telemetry.
- Bounded model-facing workflow status, inspection, and notifications; serialized scheduler mutations to prevent interval races; and guarded Fleet actions by ownership, authority, lifecycle, and provenance.
- Verified both releases end to end in fresh Pi sessions: dependency ordering, five-minute quiet-run safety, causal pause/resume and stop, live-descendant retry and rebinding, bounded parent wakes, metrics, and the Fleet overlay all passed against the installed immutable runtime pin.
- Added a responsive custom footer that keeps session usage on the left and runtime/Git state on the right, with a separate activity row for non-idle working time, compaction count, live subagents, and workflow name/progress.
- Hardened footer lifecycle tracking across reloads, paused workflows, repeated task counts, and changing async parallel groups without leaking event listeners.
