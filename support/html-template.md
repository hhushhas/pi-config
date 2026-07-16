# Shared HTML Document Template

The design system for every HTML document built for the user — spec companions, debriefs, reports, anything they read in a browser. One look across all of them: Notion-style minimalism. Warm light mode, calm charcoal dark mode, simple system type, generous whitespace. A document should feel quiet; the content does the talking.

**The canonical component source is the living template: `~/.pi/agent/packages/portable-pi-setup/support/template.html`.** It renders every component in both themes with a collapsed, copy-paste source block per section — including components not in the skeleton below (icon library of ~25 symbols, journey strip, before/after panels, timeline/phase tracker, responsibility table, checklist card, scorecard, fullbleed stage). Read and copy from it when building; this markdown holds the rules and the base skeleton. If a new document doesn't look like the showcase, it's off-template.

## Principles

- **Warm and quiet.** Light mode is warm off-white with soft near-black text, never stark white/black. Dark mode is charcoal, never pure black. Both come free via `prefers-color-scheme` — every color is a CSS custom property, nothing hardcoded.
- **One accent.** Notion blue for links and emphasis. Amber for open decisions and risks, green for done/success, red only for hard failures. No gradients, no decorative color, no rainbow badges.
- **Borders over shadows.** 1px hairlines and 8px rounding define surfaces; shadows appear only on floating elements (tooltips).
- **Simple type.** System sans at 16px/1.65. Headings are just larger and slightly bolder — not shouty, no display fonts. Prose sits in a ~720px column; tables, diagrams, and mini worlds may break out wider (`.wide`).
- **Calm motion.** No entrance animations, nothing autoplays. The only movement is direct feedback from the reader's own interaction (hover definitions, mini-world controls).
- **Visual, not just typeset.** A page of styled paragraphs is still a wall of text. Give the UI texture: inline SVG icons (the `.icon` class — stroke `currentColor` so they follow the theme) on headings, statuses, map/diagram nodes, and card fields; small illustrative images where a picture carries the idea. Inline SVG only — no icon fonts, no icon CDNs — so the file stays self-contained. Aim: no screenful of pure text.
- **Room for interaction.** Mini worlds and other interactive elements never sit in the prose column — they get a `.fullbleed` section (full width, full viewport height) plus a `data-fullscreen` toggle. Fidelity dies in a 720px column.
- **Self-contained.** Everything inline; the file opens from disk. The single allowed external dependency is the Mermaid CDN script, and only when the page actually has Mermaid diagrams.
- **Match the reference gallery.** `~/.pi/agent/packages/portable-pi-setup/support/examples/` holds polished example artifacts (see its README) — most importantly the three architecture-aware system views: the **atlas** (where does this change live?), the **metro map** (what happens differently now?), and the **lifecycle** (what happens to one thing over time?). Before building a system view or any rich interactive section, open the matching example and match its craft; a bland box-and-arrow substitute is below the bar.

## Skeleton

Copy this as the starting point. It includes every shared component: stat tiles, cards, badges, side-by-side columns, callouts, progress bars, hover definitions (`.term`), collapsibles, tables, code blocks, and mini-world controls.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{Title}</title>
<style>
  :root {
    --bg: #faf9f7; --fg: #37352f; --muted: #9b9a97; --line: #e8e6e1;
    --card: #f3f1ec; --accent: #2383e2; --amber: #d9730d; --green: #448361; --red: #d44c47;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #191919; --fg: #e3e2e0; --muted: #9b9b9b; --line: #2f2f2f;
      --card: #232323; --accent: #529cca; --amber: #cb7b37; --green: #4f9768; --red: #de5550;
    }
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--fg); margin: 0; -webkit-font-smoothing: antialiased;
    font: 16px/1.65 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  main { display: grid; grid-template-columns: 1fr min(720px, calc(100% - 3rem)) 1fr; padding: 3rem 0 6rem; row-gap: .25rem; }
  main > * { grid-column: 2; min-width: 0; }
  .wide { grid-column: 1 / -1; width: min(1080px, calc(100% - 3rem)); justify-self: center; }
  .fullbleed { grid-column: 1 / -1; width: 100%; min-height: 100dvh; padding: 3rem clamp(1.5rem, 4vw, 4rem); background: var(--card); border-block: 1px solid var(--line); }
  :fullscreen { background: var(--bg); overflow-y: auto; }
  .icon { width: 1.1em; height: 1.1em; vertical-align: -.18em; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  h1 { font-size: 1.75rem; font-weight: 600; line-height: 1.3; margin: 0 0 .5rem; }
  h2 { font-size: 1.25rem; font-weight: 600; border-bottom: 1px solid var(--line); padding-bottom: .3rem; margin: 3rem 0 1rem; }
  h3 { font-size: 1rem; font-weight: 600; margin: 2rem 0 .5rem; }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  .caption { color: var(--muted); font-size: .85rem; }
  nav.toc {
    position: sticky; top: 0; z-index: 20; grid-column: 1 / -1; width: 100%;
    background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--line); padding: .5rem 1.5rem;
    display: flex; gap: 1rem; flex-wrap: wrap; font-size: .85rem;
  }
  nav.toc a { color: var(--muted); } nav.toc a:hover { color: var(--accent); text-decoration: none; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; }
  .tiles .card { margin: 0; }
  .cols2 { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
  @media (max-width: 640px) { .cols2 { grid-template-columns: 1fr; } }
  .badge {
    display: inline-block; padding: .1rem .6rem; border-radius: 999px; font-size: .75rem;
    border: 1px solid var(--line); color: var(--muted);
  }
  .badge.accent { color: var(--accent); border-color: var(--accent); }
  .badge.green  { color: var(--green);  border-color: var(--green); }
  .badge.amber  { color: var(--amber);  border-color: var(--amber); }
  .badge.red    { color: var(--red);    border-color: var(--red); }
  .callout { border: 1px solid var(--line); border-left: 3px solid var(--accent); background: var(--card); border-radius: 8px; padding: .75rem 1rem; margin: 1rem 0; }
  .callout.amber { border-left-color: var(--amber); }
  .callout.red   { border-left-color: var(--red); }
  .progress { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; }
  .progress > i { display: block; height: 100%; background: var(--green); }
  /* Hover definitions: <span class="term" tabindex="0" data-def="plain-English meaning">jargon</span> */
  .term { position: relative; border-bottom: 1px dotted var(--muted); cursor: help; }
  .term:hover::after, .term:focus::after {
    content: attr(data-def); position: absolute; left: 0; top: calc(100% + 4px); z-index: 10;
    width: max-content; max-width: 320px; padding: .5rem .75rem; font-size: .85rem; line-height: 1.4;
    background: var(--card); color: var(--fg); border: 1px solid var(--line); border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,.15);
  }
  details { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: .5rem 1rem; margin: 1rem 0; }
  summary { cursor: pointer; color: var(--muted); font-size: .9rem; }
  details[open] summary { margin-bottom: .5rem; }
  table { border-collapse: collapse; width: 100%; font-size: .95rem; margin: 1rem 0; }
  th, td { border-bottom: 1px solid var(--line); padding: .5rem .75rem; text-align: left; vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; }
  code, pre, kbd { font: .875rem/1.6 ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  code { background: var(--card); border-radius: 4px; padding: .1rem .35rem; }
  pre { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 1rem; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  .hl { background: color-mix(in srgb, var(--accent) 14%, transparent); display: inline-block; width: 100%; }
  button { font: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: .35rem .9rem; cursor: pointer; }
  button:hover { border-color: var(--muted); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  input, select { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: .35rem .6rem; }
  img { max-width: 100%; border-radius: 8px; }
  .mermaid { margin: 1.5rem 0; max-width: 100%; overflow-x: auto; }
</style>
</head>
<body>
<nav class="toc"><!-- anchor links per section --></nav>
<main>
  <!-- header, TL;DR tiles, background, mini world, then sections -->
</main>
</body>
</html>
```

## Mermaid (only if the page has diagrams)

Add before `</body>`; theme variables come from the same CSS custom properties so diagrams match the page in both modes:

```html
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  mermaid.initialize({
    startOnLoad: true,
    theme: "base",
    themeVariables: {
      background: v("--bg"), primaryColor: v("--card"), primaryTextColor: v("--fg"),
      primaryBorderColor: v("--line"), lineColor: v("--muted"), fontFamily: "inherit",
    },
  });
</script>
```

## Fullscreen toggle

Interactive sections (`.fullbleed`) carry a toggle button; wire it once:

```html
<button data-fullscreen="#mini-world">⤢ Fullscreen</button>
<script>
  document.querySelectorAll("[data-fullscreen]").forEach((b) =>
    b.addEventListener("click", () =>
      document.fullscreenElement
        ? document.exitFullscreen()
        : document.querySelector(b.dataset.fullscreen).requestFullscreen()));
</script>
```

## Usage notes

- Prose lives in the 720px column; tables, diagrams, and images take `.wide` when they need room. Mini worlds and other interactive elements take `.fullbleed` (full width, full viewport height) plus the fullscreen toggle — never the prose column.
- Icons: a tiny inline `<symbol>` sprite at the top of `<body>` (`<svg style="display:none"><symbol id="i-check" viewBox="0 0 24 24">…</symbol>…</svg>`), used as `<svg class="icon"><use href="#i-check"/></svg>` — one definition, many uses, zero external requests.
- Severity/status mapping: green = done/solid, amber = open decision/risk/needs attention, red = blocker/hard failure, muted = neutral. Use `.badge` for inline status, `.callout` for block-level warnings.
- Mark the relevant lines inside code blocks by wrapping them in `<span class="hl">…</span>`.
- Extend the skeleton freely for document-specific needs (mini-world layouts, custom charts), but stay inside the tokens — new colors or fonts break the one-look promise.
