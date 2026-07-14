---
description: Explicitly delegate a task to Pi subagents
argument-hint: "<task> [model or reasoning override]"
---

Orchestrate this task with Pi subagents: $@

Delegation is explicitly authorized for this request only. Keep the parent agent responsible for scope, decisions, integration, and final verification.

- Delegate only work that benefits from independent context, parallelism, or a focused specialist. Do simple work directly.
- Use `scout` for codebase reconnaissance, `worker` for bounded implementation, `reviewer` for evidence-backed review, and `delegate` for narrowly scoped general work.
- Give every subagent a self-contained brief: objective, constraints, working directory, owned files or responsibility, expected output, and verification gate. Warn it that other agents may be editing the workspace and it must preserve unrelated changes.
- Never assign overlapping files to concurrent writers. Do not duplicate an active subagent's task in the parent.
- Prefer asynchronous runs for independent work. Continue useful parent work; let completion notifications wake the parent. Wait only when the next step genuinely depends on a result.
- Encode dependencies as a chain when a step requires an earlier result; use parallel groups only for independent steps.
- Honor any requested per-run model and reasoning override, including a thinking suffix such as `openai-codex/gpt-5.6-luna:high`.
- Verify load-bearing subagent claims and execute the final end-to-end proof before reporting done.
