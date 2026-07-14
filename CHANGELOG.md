# Changelog

## 2026-07-14

- Captured the working Pi configuration in a private source-of-truth repository.
- Removed bundled workflow prompts while retaining their underlying Context7 and subagent capabilities.
- Added manually invoked `/debrief` and `/orchestrate` prompt templates.
- Reduced global agent instructions to basic working, research, verification, and safety rules.
- Added durable dependency-aware DAG workflows over the existing `pi-subagents` runtime, including per-node model and effort overrides, bounded concurrency, pause, stop, retry, and explicit restart recovery.
- Added `/fleet`, a responsive Pi-native overview of workflow dependencies, agent states, metrics, current activity, and recent output.
