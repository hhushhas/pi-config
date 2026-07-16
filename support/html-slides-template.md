# Shared HTML Slides Template

The deck-format sibling of `~/.pi/agent/packages/portable-pi-setup/support/html-template.md`. Same design system — Notion-style minimalism, warm light / calm charcoal dark, same tokens and components — but the page is a slide deck: one concept per screen, stepped through with arrow keys, instead of a vertical scroll. Use it when the user picks the deck format; it exists because slides remove the "keep track of where you were" load of a long page.

Read `~/.pi/agent/packages/portable-pi-setup/support/html-template.md` first: all color tokens, type rules, and components (`.card`, `.tiles`, `.badge`, `.callout`, `.cols2`, `.term` hover definitions, `details`, tables, code, buttons) are defined there and work unchanged inside slides. This file only adds the deck mechanics.

## Deck rules

- **One concept per slide.** A slide holds one idea, one comparison, one finding, one diagram — never "the rest of the content". If a slide needs a scrollbar for its main point, split it; a scrollbar is acceptable only for optional depth (`details` blocks).
- **Slide 1 is the title slide:** title, date, verdict/status badge, and a clickable table of contents (`data-goto` links) so the user can jump anywhere.
- Map document sections to slides: Background gets its own slide; the grand summary becomes ~3 slides (one per part); the mini world gets a dedicated **full-bleed slide** (`.slide.fullbleed` — the entire viewport, no prose column, plus the shared `data-fullscreen` toggle; it's the one place interaction lives, and keyboard nav ignores keys typed into its controls); map and findings become one slide per part / per finding, not one crowded slide each.
- Navigation: ← → ↑ ↓ / space / PageUp-PageDown, HUD prev/next buttons, `Home`/`End`, and `#n` in the URL for deep links. No click-anywhere-to-advance — clicks belong to the mini world and links.
- The HUD (bottom bar) always shows a thin progress bar and an `n / m` counter — that is the user's sense of place.
- Calm motion rule carries over: slides cut, they don't fly in.

## Skeleton

Paste the shared template's `:root` tokens and component CSS into `<style>` first (everything from its skeleton except `main`/`nav.toc` layout), then add the deck layer below. Deck-specific skeleton:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{Title} — Deck</title>
<style>
  /* 1) tokens + components from ~/.pi/agent/packages/portable-pi-setup/support/html-template.md (omit main/nav.toc) */
  /* 2) deck layer: */
  html, body { height: 100%; }
  .slide {
    display: none; min-height: 100dvh; padding: 4rem 1.5rem 5rem;
    grid-template-columns: 1fr min(860px, 100%) 1fr; align-content: center; row-gap: .25rem;
  }
  .slide.active { display: grid; overflow-y: auto; }
  .slide > * { grid-column: 2; min-width: 0; }
  .slide > .wide { grid-column: 1 / -1; width: min(1080px, calc(100% - 3rem)); justify-self: center; }
  .slide.fullbleed { grid-template-columns: 1fr; padding: 3rem clamp(1.5rem, 4vw, 4rem) 5rem; align-content: start; background: var(--card); }
  .slide.fullbleed > * { grid-column: 1; }
  .slide .kicker { color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; margin-bottom: .25rem; }
  .slide h2 { border-bottom: none; margin-top: 0; font-size: 1.5rem; }
  .toc-list { list-style: none; padding: 0; display: grid; gap: .35rem; }
  .toc-list a { color: var(--fg); } .toc-list a:hover { color: var(--accent); }
  .hud {
    position: fixed; inset: auto 0 0 0; z-index: 20; display: flex; align-items: center; gap: 1rem;
    padding: .5rem 1rem; font-size: .8rem; color: var(--muted);
    background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(8px);
    border-top: 1px solid var(--line);
  }
  .hud .progress { flex: 1; }
  .hud button { padding: .15rem .6rem; }
</style>
</head>
<body>
<section class="slide">
  <p class="kicker">{Doc type} · {date}</p>
  <h1>{Title} <span class="badge green">verdict</span></h1>
  <ol class="toc-list">
    <li><a href="#2" data-goto="2">Background</a></li>
    <!-- one entry per slide or per section -->
  </ol>
</section>
<section class="slide">
  <p class="kicker">Background</p>
  <!-- one concept -->
</section>
<!-- more slides -->
<footer class="hud">
  <button data-nav="-1" aria-label="Previous slide">←</button>
  <button data-nav="1" aria-label="Next slide">→</button>
  <div class="progress"><i></i></div>
  <span class="counter"></span>
</footer>
<script>
  const slides = [...document.querySelectorAll(".slide")];
  const bar = document.querySelector(".hud .progress > i");
  const counter = document.querySelector(".hud .counter");
  let i = -1;
  function show(n) {
    const next = Math.max(0, Math.min(slides.length - 1, n));
    if (next === i) return;
    i = next;
    slides.forEach((s, j) => s.classList.toggle("active", j === i));
    bar.style.width = ((i + 1) / slides.length) * 100 + "%";
    counter.textContent = `${i + 1} / ${slides.length}`;
    history.replaceState(null, "", "#" + (i + 1));
    renderMermaid(slides[i]); // no-op if the page has no Mermaid
  }
  addEventListener("keydown", (e) => {
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName)) return; // keys belong to the mini world
    if (["ArrowRight", "ArrowDown", " ", "PageDown"].includes(e.key)) { e.preventDefault(); show(i + 1); }
    else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) { e.preventDefault(); show(i - 1); }
    else if (e.key === "Home") show(0);
    else if (e.key === "End") show(slides.length - 1);
  });
  document.querySelectorAll("[data-nav]").forEach((b) => b.addEventListener("click", () => show(i + +b.dataset.nav)));
  document.querySelectorAll("[data-goto]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); show(+a.dataset.goto - 1); }));
  addEventListener("hashchange", () => show((parseInt(location.hash.slice(1), 10) || 1) - 1));
  show((parseInt(location.hash.slice(1), 10) || 1) - 1);
</script>
</body>
</html>
```

## Mermaid in a deck (only if the page has diagrams)

Mermaid cannot measure elements inside `display: none` slides — rendering everything at load produces zero-width diagrams. Initialize with `startOnLoad: false` and render each slide's diagrams the first time that slide becomes active. Define `renderMermaid` before the deck script (or make it a no-op `function renderMermaid() {}` when the page has no diagrams):

```html
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  mermaid.initialize({
    startOnLoad: false,
    theme: "base",
    themeVariables: {
      background: v("--bg"), primaryColor: v("--card"), primaryTextColor: v("--fg"),
      primaryBorderColor: v("--line"), lineColor: v("--muted"), fontFamily: "inherit",
    },
  });
  window.renderMermaid = (slide) => {
    const pending = slide.querySelectorAll(".mermaid:not([data-processed])");
    if (pending.length) mermaid.run({ nodes: pending });
  };
</script>
```

Load this module script *before* the deck `<script>` so `renderMermaid` exists when the first slide shows (or guard the call with `window.renderMermaid?.(...)`).
