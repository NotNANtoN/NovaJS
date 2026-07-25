# Visual comparison ("ground truth") harness

A **closeness dashboard**: it captures screenshots of *our* game with Puppeteer
and diffs named UI regions, at the pixel level, against reference screenshots
of the **original** EV Nova running on real Mac hardware (1920×1080). It writes
a self-contained HTML report so we can eyeball fidelity and quantify drift.

This is **not** a CI gate and is intentionally **not** wired into `turbo test`.
Region results are structured so they *could* later become threshold assertions,
but today the goal is honest measurement, not a pass/fail.

## Running it

From `packages/nova`:

```bash
npm run visual-compare
```

Environment knobs (all optional):

| var            | default                                             | meaning |
|----------------|-----------------------------------------------------|---------|
| `PORT`         | `8210`                                              | port to drive. If a server already answers there it is **reused**; otherwise the runner spawns its own `node dist/server.js` (never any shared/preview tooling) and tears it down at the end. |
| `NOVA_REF_DIR` | `.../ui_screenshots/original_macos_screenshots`     | directory holding the original-game reference PNGs. These are **not** committed to the repo. |
| `CHROME_PATH`  | `/Applications/Google Chrome.app/.../Google Chrome` | system Chrome (puppeteer-core ships no browser). |

Prerequisites: `npx turbo run build --force` at the repo root first (the runner
serves `dist/server.js`), and the Nova game data symlinked under
`packages/nova/Nova_Data`.

Output lands in `visual_compare/output/` (git-ignored):

- `report.html` — open this. Per region: reference crop, our crop, pixelmatch
  diff, and % differing pixels; plus full-frame side-by-sides per scenario.
- `<scenario>__ours_full.png`, `ref__<name>__full.png` — full frames.
- `<scenario>__<ref>__<region>__{ref,ours,diff}.png` — the region crops.

## How it fits together

| file            | role |
|-----------------|------|
| `config.mjs`    | machine-specific paths, port, viewport, Chrome flags. |
| `driver.mjs`    | Puppeteer glue: launch, `openGame`, `pressKey`, `openStarmap`, `landAt`, `hideDebugOverlays`, `capture`. Drives the game only through the same console levers the project's tests use (`window.displayWorld`, `window.app`, `window.novaAutopilot`, `document` keydown). |
| `compare.mjs`   | `crop` + `compareRegion` (pngjs + pixelmatch). |
| `scenarios.mjs` | **the only file you edit to extend coverage** — scenario + region definitions. |
| `run.mjs`       | orchestrates: ensure server, capture each scenario, diff every region, write crops + `report.html`, print a worst-first summary. |
| `report.mjs`    | HTML generator. |

## Adding a scenario

Append to the `scenarios` array in `scenarios.mjs`:

```js
{
  id: 'outfitter',                                   // unique slug
  title: 'Outfitter dialog',
  description: 'What state this captures.',
  params: { ship: 'nova:164', system: 'nova:130' },  // ?query params
  hideDebug: true,                                   // hide FPS panel + Add Enemy button
  setup: async (page, driver) => {                   // optional: drive the UI
    await driver.landAt(page, 'planet nova:128');
    await driver.pressKey(page, 'KeyO');             // open outfitter
    // wait for its container, etc.
  },
  references: [ { name: 'earth_outfit', file: 'outfitter/earth_outfitter.png' } ],
  regions: [ region('outfit_frame', 'Dialog frame', 651, 281, 618, 522) ],
}
```

## Adding a region

A region is a named rectangle compared between the reference image and our
capture. Because our chrome is right-anchored (status bar) or centered
(dialogs), the **same** rectangle is used on both images — use the helper:

```js
region('id', 'Human label', x, y, width, height)
```

If our render is offset from the reference and you want to compare *despite*
the offset, pass explicit rects (they must share width/height):

```js
{ id, label, ref: { x, y, width, height }, ours: { x, y, width, height } }
```

Find coordinates by opening a reference PNG and our `*_ours_full.png` in an
image editor, or by reading a PIXI container's `getBounds()` via
`driver.findContainer(page, 'StatusBar')`.

Regions are the unit of measurement. A region over stable chrome (a frame
border, a metal panel) is the meaningful signal; a region over dynamic content
(the star-map graph, live target text, radar blips) will always diff and is
only useful as a full-frame sanity check.

## Caveats — read before trusting a number

- **Dynamic content diffs are meaningless.** The starfield is randomized, ship
  and asteroid positions are live, and status-bar text (target, credits, date,
  selected stellar body) differs between any two sessions. Only chrome-scoped
  regions are comparable. This is *why* the harness is region-based rather than
  full-frame.
- **Reference screenshots are the Windows/Mac original**, captured on real
  hardware. Font rendering (hinting, antialiasing, sub-pixel), gamma, and
  scaling differ from Chrome/PIXI, so even a *perfect* layout leaves a few
  percent of edge pixels flagged. Treat single-digit percentages on
  text/chrome as "essentially matching".
- **Debug overlays are hidden** before capture: the stats.js FPS panel and the
  "Add Enemy" status-bar button (see `hideDebugOverlays`). A shipping build
  would not show these; leaving them in would swamp the status-bar diff.
- **pixelmatch threshold** is 0.1 (per-region overridable via `matchThreshold`).
  A 1–2px layout offset on a high-contrast edge (button outline, frame border)
  inflates the percentage a lot — always look at the diff crop, don't just read
  the number.
- **Reference images live outside the repo** (`NOVA_REF_DIR`); the report copies
  the crops it needs into `output/` so the report itself is self-contained.
