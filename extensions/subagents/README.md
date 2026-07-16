# Multi-harness subagents

This extension is derived from Ben Davis's `davis7dotsh/my-pi-setup` subagent implementation at commit `f992ae691700371f56bcd19c6bc843fee7688fdf`. It is tracked here so this Pi configuration installs reproducibly from the local package rather than depending on untracked nested `node_modules` inside the upstream Git checkout.

The production source is unchanged except for using `effect@4.0.0-beta.97`, the mature API-compatible predecessor to upstream's two-day-old beta 98 pin. The focused manager/UI suite and live Claude Code/Codex backend suite verify that substitution.

The available harnesses are Pi, Claude Code, Codex, and the official Grok Build CLI. Grok runs through `grok agent stdio` over ACP, reuses the local `grok login` subscription session, and supports per-run model and reasoning-effort selection without an xAI API key.

The interactive and durable boundaries are deliberately distinct:

- `/subagents` manages session-local Pi, Claude Code, Codex, and Grok children and provides the full-screen dashboard and interactive conversation takeover.
- `/fleet` manages dependency workflows, authority fencing, recovery, and historical attempts. A workflow node may set `harness` to `claude`, `codex`, or `grok`; omission (or `pi`) preserves the durable pi-subagents role runtime.
- External workflow nodes use the `subagents:workflow-backend:v1` bridge. It reserves an idempotent operation on disk before starting a detached artifact-owning runner. Launch lookup, controls, terminal confirmation, and pause/resume lineage all reconcile through those artifacts after a parent restart. It never calls the session-local `subagent_spawn` tool or adopts its in-memory snapshots.

Native child session files persist, but `/subagents` still keeps its interactive fleet registry in parent-session memory and does not rehydrate dashboard entries after the parent shuts down. Only nodes created through `workflow` have durable attempt semantics.
