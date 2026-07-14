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

`/fleet` opens a responsive Pi-native overlay for the live and historical fleet. It shows dependencies, queue and run state, model and effort, elapsed time, tokens, output speed, cost, turns, tool calls, current activity, and recent output. Use the arrow keys to select, `tab` to switch panes, `u` to resume, `p` to pause, `r` to retry a stopped or failed node, `x` to stop it, and `esc` to close.

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
| `lib/workflows/*.ts` | Loaded through the local Pi package | Validates DAGs, schedules runs, persists state, and renders the fleet UI |
| `auto-name/settings.json` | `~/.pi/agent/auto-name/settings.json` | Naming model and reasoning level |

Installed packages are pinned in `settings.json`:

- `pi-subagents@0.34.0` supplies the event-driven subagent runtime. Enabled built-ins are `worker`, `scout`, `reviewer`, and `delegate`; `researcher`, `context-builder`, `planner`, and `oracle` are disabled. Roles inherit the selected parent model unless a run overrides it. Their package reasoning defaults are high, low, high, and inherited respectively. The session spawn budget is raised to 256 so 64-node workflows and retries fit within the package guardrail.
- `@upstash/context7-pi@0.1.1` supplies current library-documentation tools.
- `pi-extension-auto-name@0.3.3` names sessions automatically.
- Ben Davis's `my-pi-setup` is pinned to commit `8feb880c...`; only ask-user, Firecrawl search/scrape, git info, model info, UI customization, and the GitHub Dark Default theme load.
- This repository is loaded as a local Pi package for the DAG scheduler and fleet UI. Its runtime and TUI dependencies are pinned in `package.json` and installed with pnpm.

## Workflow state and recovery

Workflow state lives outside Git under `~/.pi/agent/workflow-runs/<project-hash>/<workflow-id>/`. Node attempts use their own durable session directories, so retries never overwrite earlier evidence. A live owner process keeps its workflow lease, so another Pi session may observe that workflow but cannot relaunch or control it. If Pi exits with work still active, the next interactive startup marks that workflow as awaiting recovery and asks whether to resume it. Declining leaves it paused; nothing relaunches automatically. A paused node resumes as a fresh attempt because the current `pi-subagents` RPC has no true child-session resume operation.

The scheduler builds on `pi-subagents@0.34.0` rather than replacing it. Its public event RPC starts, inspects, interrupts, and stops child runs; status artifacts provide the metrics displayed by `/fleet`. TTFB is shown as unavailable because the package does not currently expose a reliable first-token timestamp. Native `pi-subagents` completion notifications still wake the parent session in addition to updating the workflow.

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
