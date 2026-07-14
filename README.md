# Hasan's Pi configuration

This private repository is the source of truth for Hasan's global Pi setup. It keeps the useful capabilities—Context7, Firecrawl, automatic session naming, Codex image generation, selected UI improvements, and the subagent runtime—without exposing a large ambient workflow surface to every conversation.

The live configuration is installed at `~/.pi/agent`. Secrets, authentication, sessions, package caches, and generated images are deliberately excluded from Git.

## Current behavior

Pi 0.80.6 defaults to `openai-codex/gpt-5.6-sol` at medium reasoning. Automatic naming uses Luna at minimal reasoning. Codex image generation defaults to Sol at medium reasoning and uses the existing Codex login rather than an OpenAI API key.

The global `AGENTS.md` contains only basic working, research, verification, and safety rules. Delegation is off by instruction unless Hasan explicitly asks for it or invokes `/orchestrate`. Skills remain manually available as `/skill:name`, but `manual-only-skills.ts` removes the ambient skill catalog from the model's system prompt.

Two custom prompt templates are intentionally exposed:

- `/debrief [scope]` produces a verified guided walkthrough. It is a prompt template, so it runs only when typed.
- `/orchestrate <task>` authorizes subagent delegation for that request and supplies the coordination rules.

`/orchestrate` can now create durable dependency-aware workflows through the `workflow` tool. Each node names its prerequisites; ready independent nodes run concurrently, while a dependent node launches only after every prerequisite succeeds. The scheduler caps all workflow activity at four agents globally and accepts a per-workflow limit from one to eight. Each node may override its role, model, reasoning effort, and timeout.

`/fleet` opens a responsive Pi-native overlay for live agents, recorded attempts, and read-only external evidence. It shows dependencies, lineage, ownership, queue and run state, attention, model and effort, elapsed time, tokens, output speed, cost, turns, tool calls, current activity, and causal terminal reasons. Use the arrow keys to select, `tab` to switch panes, `h` to include terminal workflow history, `u` to resume, `p` to pause, `r` to retry a terminal node, `x` to stop it, and `t` to request an explicitly confirmed dead-owner takeover. Unsafe actions are disabled for legacy, foreign, superseded, stale, and non-authoritative attempts.

The custom footer groups related information instead of flattening it into one status string. Directory, context usage, cost, and speed stay on the left; model/effort and Git state stay on the right. A separate activity row shows accumulated non-idle working time and compaction count on the left, then conditionally shows live subagents and active workflow progress on the right. Active time is wall-clock time during which the parent or one of its owned children is running, so user idle time is excluded and parallel children do not multiply the total. Checkpoints live outside Git under `~/.pi/agent/dashboard-session-metrics/` so the count survives reloads.

The package recipes `/c7-docs`, `/gather-context-and-clarify`, `/parallel-cleanup`, `/parallel-context-build`, `/parallel-handoff-plan`, `/parallel-research`, `/parallel-review`, and `/review-loop` are filtered out. This removes menu clutter only. Context7's `resolve-library-id` and `query-docs` tools and the `pi-subagents` engine remain loaded.

## Resource map

| Repository path | Live path | Purpose |
| --- | --- | --- |
| `settings.json` | `~/.pi/agent/settings.json` | Models, UI, packages, prompt filters, disabled roles |
| `AGENTS.md` | `~/.pi/agent/AGENTS.md` | Minimal global instructions |
| `prompts/*.md` | `~/.pi/agent/prompts/*.md` | Manual `/debrief` and `/orchestrate` commands |
| `extensions/manual-only-skills.ts` | `~/.pi/agent/extensions/manual-only-skills.ts` | Prevents automatic skill selection |
| `extensions/openai-image-generation.ts` | `~/.pi/agent/extensions/openai-image-generation.ts` | Adds `generate_image` through Codex |
| `extensions/dag-workflows.ts` | Loaded directly as a local Pi package | Adds the workflow tool, recovery prompt, and `/fleet` |
| `extensions/ui-dashboard.ts` | Loaded directly as a local Pi package | Adds the responsive footer and session activity tracking |
| `lib/dashboard/*.ts` | Loaded through the local Pi package | Renders footer segments and tracks active time, compactions, subagents, and workflow progress |
| `lib/workflows/*.ts` | Loaded through the local Pi package | Validates DAGs, schedules runs, persists state, and renders the fleet UI |
| `auto-name/settings.json` | `~/.pi/agent/auto-name/settings.json` | Naming model and reasoning level |

Installed packages are pinned in `settings.json`:

- Hasan's `hhushhas/pi-subagents` fork is immutably pinned to commit `5cccd64d39a2e6a95ed557bde24dfcac1f17309e`. It supplies the event-driven subagent runtime and workflow RPC protocol v2. Enabled built-ins are `worker`, `scout`, `reviewer`, and `delegate`; `researcher`, `context-builder`, `planner`, and `oracle` are disabled. Roles inherit the selected parent model unless a run overrides it. Their package reasoning defaults are high, low, high, and inherited respectively. The session spawn budget is raised to 256 so 64-node workflows and retries fit within the package guardrail.
- `@upstash/context7-pi@0.1.1` supplies current library-documentation tools.
- `pi-extension-auto-name@0.3.3` names sessions automatically.
- Ben Davis's `my-pi-setup` is pinned to commit `8feb880c...`; only ask-user, Firecrawl search/scrape, git info, model info, UI customization, and the GitHub Dark Default theme load.
- This repository is loaded as a local Pi package for the dashboard, DAG scheduler, and fleet UI. Its runtime and TUI dependencies are pinned in `package.json` and installed with pnpm.

## Workflow state and recovery

Workflow state lives outside Git under `~/.pi/agent/workflow-runs/<project-hash>/<workflow-id>/`. Schema v2 separates the project directory from the declared execution directory, keeps every attempt and prerequisite-attempt binding, records causal controls and terminal reasons, and fences writes with a kernel lock, state revision, lease ID, and immutable lease epoch. Node attempts use distinct durable session directories, so resume and retry append lineage without overwriting evidence.

Only the owning Pi process can launch or control a workflow. Another session may observe it, but takeover requires an exact inspected revision and lease, a stale heartbeat, a dead owner PID, and explicit confirmation; concurrent claimants are fenced atomically. A paused node resumes through protocol v2 from its existing child JSONL while preserving the complete effective execution contract. Retrying a prerequisite first stops live descendants, invalidates every descendant success, and binds replacement work to the new prerequisite attempt. Runs revived outside the workflow appear as external read-only evidence and never release dependencies or receive workflow controls.

Legacy schema-v1 workflows are never controlled in place. Live or queued v1 state remains observation-only; quiescent state migrates through a byte-for-byte backup and restartable journal. A failed backup or journal verification leaves controls disabled. Workflow-owned children use event-only completion notifications, so one bounded workflow transition wakes the parent instead of replaying each child report. TTFB remains unavailable because the package does not expose a reliable first-token timestamp.

Model-facing workflow status is a bounded projection under 32 KiB, node inspection is under 8 KiB, and terminal notifications are under 1 KiB. Task briefs, report bodies, capabilities, and raw child transcripts are never serialized into those surfaces.

The installed releases were verified from fresh Pi 0.80.6 sessions in an isolated temporary worktree. The live cases covered dependency ordering, causal pause/resume, a resumed prerequisite releasing its dependent against the new attempt ID, retry stopping and invalidating a live descendant before rebinding it, a causally confirmed workflow stop with no continuation artifact, five minutes of productive silence, and the `/fleet` overlay. The complete evidence, workflow IDs, metrics, and test counts are recorded in [the workflow reliability spec](specs/pi-workflow-reliability-spec-2026-07-14.md) and its [visual companion](specs/pi-workflow-reliability-spec-2026-07-14.html).

## Prompt, skill, and slash command

A **prompt template** is a Markdown file that expands into model instructions when its `/filename` is typed. Use it for a short, repeatable, manually initiated workflow such as `/debrief` or `/orchestrate`.

A **skill** is a reusable instruction package that may include references, scripts, and assets. Use one when a domain workflow needs substantial supporting material or should be discoverable by the model. In this setup skills are manual-only to avoid ambient context and behavioral bloat.

A **slash command** is the interface, not one artifact type. Pi built-ins such as `/model`, extension commands, prompt templates such as `/debrief`, and skills such as `/skill:name` all appear as slash commands.

## Installing or updating

Back up the live files before replacing them. Then copy this repository's tracked files to the corresponding paths in the resource map and start a fresh Pi process. Pi installs pinned npm and Git packages from `settings.json` when needed.

Create `~/.pi/agent/.env` separately with mode `600`:

```dotenv
FIRECRAWL_API_KEY=your-key-here
```

Never commit the real key, `~/.pi/agent/auth.json`, session data, or installed package directories. The Firecrawl key shared during initial setup is already present only in the live `.env` and is not stored here.

When changing the setup:

1. Inspect the live state and this repository before editing; either side may have newer intentional changes.
2. Change the repository and live copy together.
3. Start a fresh Pi RPC or interactive process. Confirm expected commands and tools are present, filtered commands are absent, and exercise changed behavior end to end.
4. Update `CHANGELOG.md`, commit only this repository's files, and push after Hasan asks or when the active task explicitly includes it.

## Known caveats

The installed auto-name package has a local wording adjustment that favors English titles. A package update may overwrite that cache-level patch; replace it with a tracked local extension if naming regresses. Pi's overlay API is still experimental, so keep the pinned Pi version until `/fleet` has been retested against an upgrade. The local package source is an absolute machine path and must be changed if the repository moves.

TTFB is intentionally displayed as unavailable until the child runtime emits a trustworthy first-token timestamp. Token, cost, turn, tool, activity, and terminal metrics are available now; this release does not infer TTFB from process startup or status-write times.
