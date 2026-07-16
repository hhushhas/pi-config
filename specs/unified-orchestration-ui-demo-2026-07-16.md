# Unified orchestration UI demo

**Status:** Draft for discussion

**Date:** 2026-07-16

## Background

Pi currently exposes three related orchestration systems: role-based Pi subagents, durable dependency workflows, and direct cross-harness agents. Each is useful, but their inline messages, persistent status, lists, and detail views use different visual and interaction patterns.

The desired state is one visual grammar across all three surfaces. A user should recognize lifecycle, ownership, activity, attention, output, and available controls immediately, while capability-specific behavior remains honest: workflow nodes retain dependency and recovery controls, and direct agents retain conversation takeover.

## Proposed behavior

- Inline cards are compact by default and use the same hierarchy: lifecycle and identity first, current activity second, with bounded output available through expansion and details.
- The footer carries one aggregate orchestration summary. A widget appears only for actionable attention, avoiding permanent vertical clutter.
- Full-screen lists and detail screens share chrome, status colors, navigation, metadata labels, and transcript/artifact treatment.
- Each run visibly identifies its kind and harness: role agent, workflow node, or direct agent; Pi, Claude, Codex, or Grok.
- Controls are capability-aware and never imply guarantees the backend cannot provide.

## Settled interaction defaults

- Inline cards are compact by default.
- Routine activity stays in the aggregate footer; actionable attention creates a temporary widget above the editor.
- Every full-screen agent interface uses a responsive master-detail layout on wide terminals and list-to-detail drill-down on narrow terminals.

## Local implementation boundary

The portable setup can unify role-agent inline results, the aggregate footer, and actionable-attention handling through the pinned `pi-subagents` public message and event surface (`subagent-notify`, `subagent_control_notice`, `subagent:async-started`, `subagent:async-complete`, and `subagent:control-event`). It must not read or mutate the package's private in-memory run registry.

The role runtime's full-screen `subagents-fleet` status UI and its routine `subagent-async` widget are constructed inside pinned commit `5cccd64d39a2e6a95ed557bde24dfcac1f17309e` (`src/tui/render.ts` and `src/slash/slash-commands.ts`). That package exposes no command replacement, run-list snapshot, widget-disable setting, or detail-component factory. Consequently this repository cannot safely replace the role-agent full detail view or permanently suppress its private poll-driven routine widget. Finishing those two surfaces requires an upstream package patch that exports a read-only run projection/detail component and makes routine widget rendering configurable (or emits its reconciled projection so the local aggregate can own it). Local code intentionally does not fake role-runtime controls or infer private state from cache artifacts.

## Demo acceptance

- Switch between current and proposed worlds.
- Filter by orchestration system.
- Select runs and open a shared detail screen.
- Simulate activity, attention, and completion.
- Toggle compact/expanded inline cards and the attention widget.
- Observe responsive narrow-screen behavior.
