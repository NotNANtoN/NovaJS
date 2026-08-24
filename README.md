NovaJS
======

This is an experiment in making Escape Velocity Nova run in the browser. Escape Velocity Nova (EV Nova) is a game created by [Ambrosia Software](http://www.ambrosiasw.com/) in collaboration with [ATMOS](https://en.wikipedia.org/wiki/ATMOS_Software).

> **This fork** ([NotNANtoN/NovaJS](https://github.com/NotNANtoN/NovaJS), forked from [mattsoulanille/NovaJS](https://github.com/mattsoulanille/NovaJS)) modernizes the toolchain (Bun + esbuild instead of Bazel/Yarn), adds Rust/WebAssembly hot paths, fixes several engine and balance bugs, and is working toward a full mission engine. See [What's different in this fork](#whats-different-in-this-fork).

[Live demo of the upstream main branch](https://novajs.net) (supports multiplayer, works in modern browsers).

#### Controls (mostly standard EV Nova):
* Arrow keys to move
* Spacebar to fire
* **There is a button on the right side of the screen to add enemy ships.**
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
* **Support multiplayer to an extent.**

## Wait, but isn't EV Nova Copyrighted?

Yes. Escape Velocity Nova is copyrighted by Ambrosia Software. No rights are claimed to anything in the `objects` directory. The end goal of this project is to write a Nova engine that can interpret Nova files without including any Nova data itself. **You must supply your own EV Nova data files.**

## What's different in this fork

### Toolchain
* **Bazel is no longer required.** The dev path is plain [Bun](https://bun.sh) (or npm) + [esbuild](https://esbuild.github.io/): `bun install`, then `npm run dev`. Works on Node 22/24 and Apple Silicon.
* Minified browser bundle, gzip compression, and proper cache headers on the asset routes.

### Performance
* **Rust/WebAssembly module** (`nova_wasm/`): convex-hull extraction from sprite RGBA data and batched SAT (Separating Axis Theorem) collision tests.
* Fixed-timestep 60 Hz server loop with bounded catch-up (no more drift under load).
* Incremental RBush spatial-index updates instead of full rebuilds each frame.
* Dirty-tracking in the multiplayer delta system — unchanged components are no longer drafted/serialized every frame.
* In-place vector math in the movement hot path; spritesheet frames are now sub-regions of one atlas texture instead of hundreds of individual loads; fixed a render-texture leak in the status bar.

### Bug and balance fixes
* **Ship velocity scaling fixed** — ships now move at 3/10 of the raw resource values (matching EV Nova), with a 1.25× player physics bonus approximating non-strict play.
* **1=X weapon bug fixed** — multiple copies of a weapon now fire proportionally via an accumulator, with a per-step projectile cap.
* **Beam weapons clip on collision** and beam damage is framerate-independent.
* Weapon reload timing converted from frames using the correct 30 fps base.
* Re-enabled multiplayer authorization checks (ownership/admin) for entity removal, replacement, and deltas.

### Tools
* `tools/rez2ndat.py` — converts EV Nova 1.1.x Windows-style `.rez` (BRGR) files into `.ndat` files this engine can parse. Useful if your copy of EV Nova ships `.rez` data (e.g. the 1.1.1 Mac OS X release).

### In progress: mission engine
Parsers for `mïsn` / `düde` / `flët` / `gövt`, an NCB (Nova Control Bit) expression evaluator, persistent player state (credits, game date, mission bits, saved pilot), real outfit prices, and data-driven NPC system population are under active development on this fork.

## Getting Started

### Prerequisites
* [Node.js](https://nodejs.org/) 22+ (24 works) and [Bun](https://bun.sh) (or npm)
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
* `npm run build:esbuild` — build only
* `npm run typecheck` — TypeScript type check

### Legacy Bazel path
The upstream Bazel build (`yarn start`, `yarn test`, docker image) still exists but is unmaintained in this fork; see the [upstream README](https://github.com/mattsoulanille/NovaJS#readme) if you need it.

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

## Known Bugs
* Windows `.res` files are not supported directly (use `tools/rez2ndat.py` for `.rez`).
* Missions, NPC spawning from system data, and pilot saving are incomplete (in progress, see above).

## Unsolved Multiplayer Questions
* How will mission strings that significantly change the universe work?
  * Put people in their respective system for every changed system? But then it's not multiplayer.
  * Put everyone in the same system, but make the planets different based on the state of the universe? But there are fleets...
  * Choose a system randomly and put everyone in it?
    * How do you detect which systems are actually just different instances of the same system (e.g. when you complete a certain storyline, certain systems of a specific government get annexed, but they'd need to remain not-taken-over for other players)?
  * This is probably the biggest problem with multiplayer support, and I welcome any suggestions.
* Will there be some form of chat, and if so, where will it be? Perhaps you need to hail other ships to talk to them? Perhaps it's just in the bottom left info area?
* How will hailing other ships be managed when the game can't just pause at any time?
* How will 2x speed work on a client basis? (It probably just won't and will be a server-configured option).

## Credits
All engine and game-design credit for the original project goes to [Matt Soulanille](https://github.com/mattsoulanille). EV Nova is © Ambrosia Software / ATMOS.
