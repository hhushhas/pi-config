# Reference examples

Pre-made, polished example artifacts. They exist because "make it visual" produces bland output without a concrete bar: before building any system view for the user, **open the matching example file in a browser, study how it works, and match its quality** — density of interaction, plain-words labeling, hover tooltips, before/after toggles, light and dark mode, fullscreen, keyboard access, reduced-motion support. The Chalk subject matter is placeholder; the craft is the reference. Don't copy the content — copy the standard.

All examples are built on the shared design system (`~/.pi/agent/packages/portable-pi-setup/support/html-template.md`): same tokens, `.term` hover definitions, `.fullbleed` stage with dot-grid texture, inline SVG icon sprite, no external dependencies.

## The system views

Each answers a different question about a change. Pick by the question the user most needs answered; use two (or more) when the change is big enough to deserve it.

| File | View | The question it answers | Strongest when |
|---|---|---|---|
| `system-atlas.html` | Block atlas | **Where does this live, and what does it touch?** | Structural changes: a new piece added, boundaries moved, wiring changed |
| `system-metro.html` | Metro map | **What happens differently now?** | Flow changes: a journey through the system takes a new route |
| `system-lifecycle.html` | Lifecycle | **What happens to one thing over time — and where can it die?** | Temporal behavior: TTLs, retries, expiry, state machines, failure/recovery paths |
| `system-blast.html` | Blast radius | **What could go wrong, and how far does it spread?** | Robustness changes: safety nets, failure isolation, findings worth *feeling* rather than reading |
| `story-player.html` | Story player | **What does one user actually live through?** | User-facing changes: the spec/debrief includes a scripted scenario the user watches like a short video |

## Techniques worth stealing

- **Atlas** — layer bands by responsibility with icons; wires computed from real element positions with per-edge anchor distribution (no spaghetti), arrowheads, and animated flow ripple; the new piece marked with a puzzle badge and glowing seam; hover tooltips giving each block's job in plain words; zoom-in on the new piece's internals; a step-through **story mode** that reveals wires progressively.
- **Metro** — journeys as colored transit lines over shared stations; interchanges drawn larger; line-focus dimming plus a stop-by-stop journey strip with a one-sentence story; a **Before** toggle that replaces the new station with a dashed "the gap" marker and reroutes the lines around it.
- **Lifecycle** — a scrubbable/playable timeline following one entity; a visible **fork** where the story branches, with the unchosen ending ghosted; a moment card whose narration, state badge, and cost meter derive entirely from the playhead time; the lease drawn as a **draining ring** that refills on each heartbeat; the before-world as a dashed zombie rail running to ∞.
- **Blast radius** — click any block to kill it; failure propagates in staged hops along the wires, tinting blocks dead/degraded while a plain-words blast log narrates each hop; journey chips live-update (fine/degraded/broken/protected); the safety net visibly **catches** propagation with a shield badge on the wire; the Before toggle replays the identical failure without the net — same click, bigger crater; findings become preset scenario buttons.
- **Story player** — a user story with video-player mechanics: a DOM/SVG device mock whose screen changes per scene, play/scrub/chapters/captions, a live "time lost" counter, and a world toggle that replays the same incident under old vs new behavior while preserving the playhead; reduced-motion turns it into a manual stepper.

## Growing the gallery

When a debrief or spec produces a view pattern that is genuinely better than what's here, distill it into a new self-verifying example in this directory (placeholder subject, both themes screenshot-tested) and add it to the table above. This gallery is the quality bar; keep it the best work, not all work.
