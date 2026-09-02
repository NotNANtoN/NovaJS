NovaJS
======

This is an experiment in making Escape Velocity Nova run in the browser. Escape Velocity Nova (EV Nova) is a game created by [Ambrosia Software](http://www.ambrosiasw.com/) in collaboration with [ATMOS](https://en.wikipedia.org/wiki/ATMOS_Software).

> **This fork** ([NotNANtoN/NovaJS](https://github.com/NotNANtoN/NovaJS), forked from [mattsoulanille/NovaJS](https://github.com/mattsoulanille/NovaJS)) modernizes the toolchain, adds retail-facing gameplay and UI, hardens engine behavior, and expands mission support. See [What's different in this fork](#whats-different-in-this-fork).

> **Copyright and assets:** This repository does not include EV Nova data or artwork. EV Nova is copyrighted by Ambrosia Software / ATMOS. You must supply your own legally obtained data files; do not redistribute the `objects` output or extracted retail assets.

[Live demo of the upstream main branch](https://novajs.net) (supports multiplayer, works in modern browsers).

#### Controls (mostly standard EV Nova):
* Arrow keys to move
* Spacebar to fire
* L while moving slowly over a planet to land
* Tab to select a target
* W to choose a secondary weapon
* **Left Shift to fire secondary weapon** (not only Ctrl since that's used by Windows)
* R to choose nearest target
* Hold A to point towards target.
* M to open the map and select a system to jump to.
* J to jump.
* **Scroll down in the outfitter and shipyard with the arrow keys to see more items**

### Project Goals
* Function as a Nova Engine that can, given Nova files, run EV Nova.
* Support Nova Plug-ins.
* Improve on some of the issues with EV Nova's engine (such as limited turning angles) as long as doing so does not negatively affect gameplay.
* Complete reliable single-player retail behavior before expanding multiplayer.

## Wait, but isn't EV Nova Copyrighted?

Yes. Escape Velocity Nova is copyrighted by Ambrosia Software. No rights are claimed to anything in the `objects` directory. The end goal of this project is to write a Nova engine that can interpret Nova files without including any Nova data itself. **You must supply your own EV Nova data files.**

## What's different in this fork

### Retail-facing gameplay and UI
* **Retail-style start menu:** the browser menu uses the original background, animated logo, button artwork, and title music when those resources are present, with a usable DOM fallback when they are not.
* **Landing and spaceport services:** landing eligibility is derived from current authoritative planet metadata and retail flags. Bar, commodity exchange, outfitter, and shipyard buttons follow the retail service flags. Stable metadata revalidates to repair stale browser caches, while version-stable binary assets remain immutable.
* **Mission Computer and Bar boards:** retail PICT assets, measured layouts, variable-height offer rows, Mission Info, and Nova mission-string formatting are supported. Retail offers take precedence over procedural fallback missions.
* **Navigation and death are separate lifecycles:** normal hyperjumps spool, depart, arrive, and consume one plotted route hop; the starmap retains multi-hop routes and distinguishes the current system from the selected route. Death uses its own relocation path rather than replaying jump presentation.
* **Player destruction:** zero armour starts a staged wreck/explosion sequence, then respawns the player at the last landed location, including silent cross-system relocation.
* **Faction hostility:** provocation accounts for government relationships and civilian/military roles. Verified attacks can produce an internal security threat broadcast to the appropriate retail-allied military ships.

### Mission and player state
Working now:
* NCB test evaluation and a substantial set of NCB state effects.
* Retail mission availability checks, offer formatting, accept/refuse flows, active mission state, deadlines, cargo reservation, and supported completion/failure paths.
* Procedural cargo/ferry offers when no equivalent retail offer is available.
* Persistent pilot identity, player state, mission bits, active missions, cargo, game date, and snapshot/restore pieces.

Still incomplete:
* Complete retail mission lifecycle coverage, including every selector, goal, effect, and storyline edge case.
* `crön`-driven news, richer Bar content, and some hail/comms behavior.
* Full persistence/NCB schema consolidation and comprehensive plug-in compatibility.

### Engine hardening and performance
* **Rust/WebAssembly module** (`nova_wasm/`): convex-hull extraction from sprite RGBA data, first-order projectile intercept lead-angle calculations, and batched SAT (Separating Axis Theorem) collision tests.
* Fixed-timestep 60 Hz server loop with bounded catch-up (no more drift under load).
* Incremental RBush spatial-index updates instead of full rebuilds each frame.
* Primitive-safe replication, explicit component-authority policy for critical client/server state, and dirty tracking so unchanged components are not drafted or serialized every frame.
* In-place vector math in the movement hot path; spritesheet frames are now sub-regions of one atlas texture instead of hundreds of individual loads; fixed a render-texture leak in the status bar.
* **Ship velocity scaling fixed** — ships now move at 3/10 of the raw resource values (matching EV Nova), with a 1.25× player physics bonus approximating non-strict play.
* **1=X weapon bug fixed** — multiple copies of a weapon now fire proportionally via an accumulator, with a per-step projectile cap.
* **Beam weapons clip on collision** and beam damage is framerate-independent.
* Weapon reload timing converted from frames using the correct 30 fps base.
* Input edges, held-fire intent, respawn timing, cache recovery, persistence boundaries, render ownership, and teardown paths have focused hardening and regression coverage.

### Toolchain and quality
* **Modern toolchain:** Development is powered by Node 24 and [Bun](https://bun.sh) with [esbuild](https://esbuild.github.io/). Package management uses `bun install` with zero legacy dependencies (removed Karma, RequireJS, Bazel, and fp-ts).
* **Parallel test suite:** `bun test` or `npm test` runs the 158 test files across parallel worker pools in under 10 seconds.
* `npm run check` is the canonical build-and-test command, with zero `tsc --noEmit` typecheck errors across the entire codebase.
* Minified browser bundle, gzip compression, and explicit cache headers are used on served assets.

### Tools
* `tools/rez2ndat.py` — converts EV Nova 1.1.x Windows-style `.rez` (BRGR) files into `.ndat` files this engine can parse. Useful if your copy of EV Nova ships `.rez` data (e.g. the 1.1.1 Mac OS X release).

The canonical remaining-work list is in [`docs/roadmap.md`](docs/roadmap.md).

## Getting Started

### Prerequisites
* [Node.js](https://nodejs.org/) 24+ and [Bun](https://bun.sh) (or npm)
* A Mac copy of EV Nova for its data files ([archive mirror](https://www.reddit.com/r/evnova/comments/cwwjnf/ambrosia_software_mediafire_archive_mirror/))

### Install and run
```bash
git clone https://github.com/NotNANtoN/NovaJS.git
cd NovaJS
bun install          # or: npm install
```

Copy your `Nova Files` and `Plug-ins` directories into `nova/Nova_Data/`. Files must be `.ndat` or Mac resource-fork format. If your copy has `.rez` files instead, convert them first:

```bash
python3 tools/rez2ndat.py "path/to/Nova Files" "nova/Nova_Data/Nova Files"
```

Then build and start:

```bash
npm run dev          # esbuild bundle + node dist/server.js
```

The server listens on port 8000 by default; override with `NOVA_PORT=8001 npm run dev` or by editing `nova/settings/server.json`. Open [localhost:8000](http://localhost:8000) in a browser.

Other scripts:
* `npm run build` — build only
* `npm test` — full supported test suite
* `npm run check` — canonical required build and test checks
* `npm run typecheck` — TypeScript diagnostic (currently non-gating; see below)

The upstream Bazel/Yarn build has been removed from this fork; see the [upstream README](https://github.com/mattsoulanille/NovaJS#readme) if you need it.

### Quality checks and Git hooks

`bun install`/`npm install` runs the `prepare` script, which copies the
checked-in `.githooks/pre-commit` and `.githooks/pre-push` files into this
worktree's `.git/hooks` directory without changing Git configuration.

* Pre-commit runs `git diff --cached --check` and the production build.
* Pre-push runs the canonical `npm run check` build and full test suite.
* Repair or manually install hooks with `node scripts/install-git-hooks.mjs`.
  Use `--dry-run` to inspect destinations without writing files.
* GitHub Actions runs `npm run check` on pushes and pull requests with Node 24
  and the frozen Bun lockfile.

`npm run typecheck` remains a visible, non-blocking CI diagnostic because the
legacy tree and retired tests have existing dependency and type errors. Those
errors are not suppressed or weakened. Bypassing hooks should be reserved for
an emergency; run the skipped command manually and document why.

### Rebuilding the WASM module
The compiled artifacts are checked in under `nova_wasm/pkg/`. To rebuild from source you need a Rust toolchain with `wasm-pack`:

```bash
cd nova_wasm && wasm-pack build --target web
```

## Project Structure
The project is organized as a monorepo and has several subpackages:
* `nova`: The server, client, and engine for NovaJS.
* `novaparse`: Parses Nova Files and Plug-ins.
* `novadatainterface`: The interface implemented by `novaparse` and used by `nova`.
* `nova_ecs`: The Entity Component System used by NovaJS.
* `nova_wasm`: Rust/WebAssembly hot paths (convex hull, SAT collision batches).
* `tools`: Standalone helpers (`rez2ndat.py`).

## Known bugs and limitations
* **Retail assets are not included.** Supply your own EV Nova data files; extracted assets must not be redistributed.
* Full `tsc --noEmit` still reports legacy type and dependency debt. `npm run typecheck` is diagnostic and non-gating; `npm run check` is the required supported check.
* The richer retail Bar content associated with resource 8504 is not yet mapped.
* The Node test harness skips a small, named set of browser-, legacy-loader-, or native-environment-specific tests.
* Mission and storyline coverage is incomplete as described above, and plug-in compatibility is not comprehensive.
* The project is single-player-first. Multiplayer faction design and broader multiplayer work are parked until single-player retail behavior is complete.
* Windows `.res` files are not supported directly (use `tools/rez2ndat.py` for `.rez`).

See [`docs/roadmap.md`](docs/roadmap.md) for prioritized remaining work and [`docs/design-ideas.md`](docs/design-ideas.md) for optional ideas.

## Credits
All engine and game-design credit for the original project goes to [Matt Soulanille](https://github.com/mattsoulanille). EV Nova is © Ambrosia Software / ATMOS.
