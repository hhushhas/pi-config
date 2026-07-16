# Changelog

## 2026-07-16

- Converted the live Pi configuration into the versioned `portable-pi-setup` package with an explicit extension, prompt, and skill manifest; machine-relative settings; pinned package and CLI versions; a production shrinkwrap; and a restricted publish allowlist.
- Added a cross-platform installer that backs up managed live resources, preserves credentials and mutable state, installs real skill files instead of symlinks, and provisions the canonical settings, keybindings, support templates, visual examples, and Reading Room.
- Added a doctor command and distribution tests for resource parity, path portability, owner-name removal, private-state preservation, package placement, and settings pins.
- Replaced the macOS-only `/usr/bin/lockf` workflow lock with `proper-lockfile`, made directory durability handling Windows-safe, corrected Windows absolute-path and migration-backup handling, corrected `cmd.exe /s` verbatim quoting, and made process fixtures and POSIX-mode assertions portable in the cross-platform gate.
- Packaged the live destructive-command guard with PATH-based executable discovery, fixed `/orchestrate` frontmatter, made Codex review timeouts cross-platform, and removed owner names, account profiles, and absolute home paths from the distributable setup.
- Vendored the MIT-declared auto-name 0.3.3 extension with the live concise-English naming patch and portable agent-directory resolution, eliminating the last cache-only behavior change.

## 2026-07-15

- Vendored and adapted Ben Davis's background-terminal implementation at `d8534d7e6ec6609b7e684a8a0eb2e7a0195115ba`, including backpressured private full-output spills, bounded model-visible tails, exactly-once completion delivery, launched-process-group termination, `/ps`, and session-shutdown cleanup.
- Added enabled-by-default, session-persistent `/enable-bg-terminal` and `/disable-bg-terminal` capability controls plus `/stop` for authoritative all-terminal settlement without duplicate completion messages.
- Added a 180-second omitted-only default to Pi's foreground Bash calls in parent and Pi-backed child sessions, preserving explicit timeouts and Pi's normal cleanup while directing intentionally long work to unbounded `bg_start` processes.
- Added the official Grok Build CLI as a fourth direct subagent harness over ACP, reusing the signed-in X subscription with model, reasoning, streaming transcript, tool activity, usage, continuation, and cancellation support.
- Stopped unrelated or merely long-running subagent control events from leaving the footer stuck on `workflow attention`; only `needs_attention` from an authoritative workflow child now sets it.
- Removed the three-minute Pi-child tool-call timeout so role and cross-harness children run without completion budgets by default, and documented that default directly in both delegation tool descriptions.
- Vendored `ask_user` into the durable local package and added Tab/`n` per-option notes while preserving immediate Enter selection, Escape restoration, the free-form fallback, structured result details, and the public tool schema.
- Added session-scoped delegation gates: role subagents, cross-harness agents, and dependency workflows now start hidden and are enabled cumulatively through dedicated slash commands.
- Changed worker subagents to fresh context by default and configured the main `subagent` tool to use a concise custom description.
- Added Ben Davis's full-screen `/subagents` dashboard and conversation takeover, including live transcript rendering, scrolling, steering and follow-up input, status metrics, and abort controls.
- Added session-local Pi, Claude Code, and Codex subagent backends behind `subagent_spawn`, with automatic event-driven result delivery, exact supported reasoning overrides, and a four-run cap that remains reserved across queued continuations.
- Takeover follow-ups now report rejected sends in place and retain the user's input for retry.
- Kept direct multi-harness children separate from durable `/fleet` workflows so the new in-memory registry cannot bypass DAG dependency, ownership, recovery, or authority guarantees.
- Pinned and documented the multi-harness dependencies, added focused and credential-backed live tests, updated the active Pi package configuration, and verified the Codex takeover flow in a fresh interactive Pi session.

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
