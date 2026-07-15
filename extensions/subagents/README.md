# Multi-harness subagents

This extension is derived from Ben Davis's `davis7dotsh/my-pi-setup` subagent implementation at commit `f992ae691700371f56bcd19c6bc843fee7688fdf`. It is tracked here so Hasan's Pi configuration installs reproducibly from the local package rather than depending on untracked nested `node_modules` inside the upstream Git checkout.

The production source is unchanged except for using `effect@4.0.0-beta.97`, the mature API-compatible predecessor to upstream's two-day-old beta 98 pin. The focused manager/UI suite and live Claude Code/Codex backend suite verify that substitution.

This runtime is deliberately separate from the durable DAG scheduler:

- `/subagents` manages session-local Pi, Claude Code, and Codex children and provides the full-screen dashboard and interactive conversation takeover.
- `/fleet` manages durable dependency-aware workflows, authority fencing, recovery, and historical attempts.

Native child session files persist, but `/subagents` keeps its fleet registry in parent-session memory and does not rehydrate dashboard entries after the parent shuts down. Do not treat one of these children as a durable workflow attempt.
