# Hasan's Pi configuration

This private repository is the source of truth for Hasan's global Pi setup. It keeps the useful capabilities—Context7, Firecrawl, automatic session naming, Codex image generation, selected UI improvements, and the subagent runtime—without exposing a large ambient workflow surface to every conversation.

The live configuration is installed at `~/.pi/agent`. Secrets, authentication, sessions, package caches, and generated images are deliberately excluded from Git.

## Current behavior

Pi 0.80.6 defaults to `openai-codex/gpt-5.6-luna` at medium reasoning. Automatic naming uses Luna at minimal reasoning. Codex image generation defaults to `gpt-5.6-sol` at medium reasoning and uses the existing Codex login rather than an OpenAI API key.

The global `AGENTS.md` contains only basic working, research, verification, and safety rules. Delegation is off by instruction unless Hasan explicitly asks for it or invokes `/orchestrate`. Skills remain manually available as `/skill:name`, but `manual-only-skills.ts` removes the ambient skill catalog from the model's system prompt.

Two custom prompt templates are intentionally exposed:

- `/debrief [scope]` produces a verified guided walkthrough. It is a prompt template, so it runs only when typed.
- `/orchestrate <task>` authorizes subagent delegation for that request and supplies the coordination rules.

The package recipes `/c7-docs`, `/gather-context-and-clarify`, `/parallel-cleanup`, `/parallel-context-build`, `/parallel-handoff-plan`, `/parallel-research`, `/parallel-review`, and `/review-loop` are filtered out. This removes menu clutter only. Context7's `resolve-library-id` and `query-docs` tools and the `pi-subagents` engine remain loaded.

## Resource map

| Repository path | Live path | Purpose |
| --- | --- | --- |
| `settings.json` | `~/.pi/agent/settings.json` | Models, UI, packages, prompt filters, disabled roles |
| `AGENTS.md` | `~/.pi/agent/AGENTS.md` | Minimal global instructions |
| `prompts/*.md` | `~/.pi/agent/prompts/*.md` | Manual `/debrief` and `/orchestrate` commands |
| `extensions/manual-only-skills.ts` | `~/.pi/agent/extensions/manual-only-skills.ts` | Prevents automatic skill selection |
| `extensions/openai-image-generation.ts` | `~/.pi/agent/extensions/openai-image-generation.ts` | Adds `generate_image` through Codex |
| `auto-name/settings.json` | `~/.pi/agent/auto-name/settings.json` | Naming model and reasoning level |

Installed packages are pinned in `settings.json`:

- `pi-subagents@0.34.0` supplies the event-driven subagent runtime. Enabled built-ins are `worker`, `scout`, `reviewer`, and `delegate`; `researcher`, `context-builder`, `planner`, and `oracle` are disabled. Roles inherit the selected parent model unless a run overrides it. Their package reasoning defaults are high, low, high, and inherited respectively.
- `@upstash/context7-pi@0.1.1` supplies current library-documentation tools.
- `pi-extension-auto-name@0.3.3` names sessions automatically.
- Ben Davis's `my-pi-setup` is pinned to commit `8feb880c...`; only ask-user, Firecrawl search/scrape, git info, model info, UI customization, and the GitHub Dark Default theme load.

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

## Known caveat and next phase

The installed auto-name package has a local wording adjustment that favors English titles. A package update may overwrite that cache-level patch; replace it with a tracked local extension if naming regresses.

Dependency-aware workflow/DAG mode and a rich fleet UI are the next project phase. They are not implemented in this repository yet. The existing subagent package already provides chains, parallel groups, async completion notifications, run state, and per-run model overrides; the next design should build on those primitives instead of replacing them blindly.
