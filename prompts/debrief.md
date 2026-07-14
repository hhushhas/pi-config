---
description: Explain the current change as a guided technical walkthrough
argument-hint: "[scope, branch, commit, or change]"
---

Create a debrief for the current work. If the invocation includes a scope, branch, commit, or change, focus it on: $@

This is a walkthrough, not a code review. Inspect the actual implementation and diff before writing. Verify every load-bearing claim against the current files and executable behavior.

Write:

1. **Grand summary** — three short paragraphs covering what changed, why it changed, and the resulting behavior.
2. **Guided walkthrough** — move through the implementation in the order a request or user action flows. Cite exact file paths and line numbers. Explain the important decisions, boundaries, data flow, and failure behavior.
3. **Findings** — only concrete defects or risks discovered while preparing the walkthrough, ordered by severity, with category, file, line, impact, and evidence. Say "No findings" when there are none.

Keep it concise enough to read in one sitting. Do not narrate the development timeline, dump every changed line, or invent intent that the code does not prove.
