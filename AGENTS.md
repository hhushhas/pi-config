# Portable Pi Setup Protocol

# General

Projects commonly live under `~/code/`. Repositories may be shared with other agents: assume a dirty worktree, ignore and preserve unrelated changes unless they create real conflict or risk, and commit only your own work. Avoid stash/reset/revert. Follow the nearest project-local `AGENTS.md` when one exists. Use `generate_image` for Codex-native raster image generation.

## Research

Search early; prefer 2024–2026 sources when recency matters. Use Context7 for library documentation and API setup, and Firecrawl for web research. For planning and modeling tasks, confirm load-bearing assumptions with the user before deep research builds on them.

## Verification and safety

Do not call work done until the relevant behavior has been executed and observed. Report status as done or not done; name the exact missing proof when blocked. Never touch production or deploy without explicit approval in the active conversation.

# Writing

Load the `writing` skill before writing a document or the final response the user will read.

# Complaints

When you hit friction while working, report it with `complain -m <pi:your-model-id> "what you were doing → what got in the way"` when that command is available.

# Tools

Prefer pnpm; use npm only for legacy projects. Prefer OrbStack over Docker Desktop when it is available. Every `op item get` command must specify `--vault`; a vaultless list succeeding does not prove item reads will work. Before attaching inline cloud policies, ask once up front with the needed or likely policies, then proceed without repeatedly asking.

# Code review

Before handoff, load the `codex-review` skill when the user explicitly requested an automatic code review or invoked that skill.

# Hand off

Run the full gate, update the changelog or release notes, stage only the intended scope, and commit conventionally. Clean up high-CPU or high-memory processes you spawned. Push only when instructed. Shipping means pushing, watching CI, fixing and re-pushing until required jobs are green, verifying the deployed revision when applicable, and reporting the green run with live proof.
