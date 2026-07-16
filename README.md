# Portable Pi Setup

This repository packages one opinionated Pi 0.80.6 setup so another person can install the same settings, extensions, prompts, skills, keybindings, support templates, and pinned third-party Pi packages without copying machine-specific paths or symlinks.

The setup defaults to `openai-codex/gpt-5.6-sol` at medium reasoning. It includes Context7, Firecrawl, `pi-chrome`, automatic session naming, Codex image generation, destructive-command checks, gated delegation, multi-harness subagents, durable dependency workflows, background terminals, and the GitHub Dark Default theme.

## Install

Prerequisites:

- Node 22 or newer;
- Pi `0.80.6`;
- pnpm `11.1.3`;
- Git.

From a checkout of this repository:

```bash
pnpm install --frozen-lockfile
pnpm run install:setup
pnpm run doctor
```

The installer works on macOS, Linux, and Windows. It installs the package under `~/.pi/agent/packages/portable-pi-setup`, writes the canonical global settings and keybindings, installs the subagent configuration and Reading Room support, and replaces legacy loose copies of managed prompts, skills, and extensions. Every replaced path is moved under `~/.pi/agent/backups/portable-pi-setup-<timestamp>/` first.

It deliberately preserves `.env`, `auth.json`, sessions, trust decisions, workflow history, dashboard metrics, and an existing Reading Room registry. Use `--target <path>` or `PI_CODING_AGENT_DIR` for a non-default Pi agent directory. `--dry-run` prints the target without modifying it.

## Authentication and optional tools

Create or update `~/.pi/agent/.env` with mode `600` on POSIX systems:

```dotenv
FIRECRAWL_API_KEY=your-key-here
```

Authenticate Pi and the external harnesses you intend to use. The exact development setup was verified with:

| Tool | Version | Used for |
| --- | --- | --- |
| Pi | `0.80.6` | Parent agent and Pi subagents |
| Codex CLI | `0.144.2` | Codex subagents, review, and image generation |
| Claude Code | `2.1.210` | Claude subagents |
| Grok Build | `0.2.101` (`5bc4b5dfadcf`) | Grok subagents |
| dcg | `0.6.8` | Destructive-command checks |
| Skillbox | `0.2.0` | On-demand external skill discovery |

`pnpm run doctor` checks these versions, the installed package, settings pins, provider environment, authentication file, and external skill directories that could shadow packaged skills. Missing optional CLIs produce warnings rather than disabling Pi startup.

## Managed resources

- `settings.json` is the machine-neutral form of the canonical live settings. Its local package source is relative to the Pi agent directory, and every npm or Git package is pinned.
- `AGENTS.md` contains portable global operating rules without owner names, account names, cloud profiles, or absolute home paths.
- `keybindings.json` preserves Shift+Enter and Ctrl+J for new lines.
- `extensions/` contains the exact managed extension set. Delegation and workflow tools begin hidden; background terminals begin enabled.
- `prompts/` contains `/debrief` and `/orchestrate`.
- `skills/` contains the writing, Codex review, spec, and Skillbox workflows as real files rather than symlinks.
- `support/` contains the HTML templates, visual examples, and an empty Reading Room used by the document workflows.
- `auto-name/settings.json`, `subagent-config.json`, and `subagent-tool-description.md` preserve the live model and delegation behavior.

Credentials and mutable state are intentionally outside the package. Different provider entitlements, model availability, terminal rendering, and project-local `.pi/settings.json` overrides can still change behavior; the doctor reports what can be detected locally.

## Development and verification

```bash
pnpm run typecheck
pnpm test
pnpm pack --dry-run
```

Credential-backed harness checks are separate:

```bash
pnpm run test:subagents:live
```

The workflow store uses a portable filesystem lock instead of macOS `/usr/bin/lockf`, and the installer and doctor use Node APIs rather than shell-specific copy logic. CI should run the normal gate on macOS, Linux, and Windows before a public release.

## Licensing status

This distribution is currently marked `UNLICENSED`. Some vendored UI and terminal work was adapted from `davis7dotsh/my-pi-setup`, whose repository does not currently declare a license. Keep distribution private until those portions are replaced or explicit redistribution permission and a compatible license are obtained. The pinned `pi-subagents` runtime is MIT-licensed.
