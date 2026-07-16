---
name: codex-review
description: Runs the Codex CLI reviewer for a scoped automatic code review. Use only when the user explicitly asks for auto code review or invokes this skill.
disable-model-invocation: true
---

# Codex review

“Auto code review” means running the Codex CLI reviewer, and nothing else:

```bash
node ~/.pi/agent/packages/portable-pi-setup/scripts/codex-review.mjs --uncommitted
```

The packaged wrapper applies the pinned model settings and a cross-platform 30-minute deadline. Replace `--uncommitted` with `--commit <sha>` or `--base <branch>` for the other scopes.

Use exactly one scope:

- `--uncommitted` reviews current changes.
- `--commit <sha>` reviews one commit.
- `--base <branch>` reviews changes against a branch.

Prefer `--commit` or `--base`, because worktrees are often dirty with other agents' work and `--uncommitted` can pull unrelated files into the review. A scope flag cannot be combined with a prompt argument.

The reviewer is thorough and therefore slow. If the CLI rejects the invocation, read `codex review --help` once and fix the command shape. Never rerun the same failing command, and never count a failed launch as review coverage.

Follow all applicable `AGENTS.md` boundaries. Run this only from the top-level thread, make at most two review runs per handoff, and honor a skip-review request from the user for the whole task.

A request for a “debrief” is different; don't run this skill for it.
