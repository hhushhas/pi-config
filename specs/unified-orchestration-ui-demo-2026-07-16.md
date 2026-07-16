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

## Demo acceptance

- Switch between current and proposed worlds.
- Filter by orchestration system.
- Select runs and open a shared detail screen.
- Simulate activity, attention, and completion.
- Toggle compact/expanded inline cards and the attention widget.
- Observe responsive narrow-screen behavior.
