# AGENTS.md — Development & Deployment Guide for NovaJS

This document contains persistent instructions, architecture context, and deployment workflows for AI assistants and contributors working on NovaJS.

---

## 1. Project Overview & Architecture

- **NovaJS** is a TypeScript browser reimplementation of the classic game *Escape Velocity: Nova*.
- **Client (`nova/src/`)**: Built on PixiJS (rendering), WebAudio / `@pixi/sound` (audio), and a custom Entity Component System (**NovaECS** in `nova_ecs/`).
- **Server (`nova/server.ts`)**: Express + WebSocket communicator server that hosts multiplayer star systems, interest-managed ECS state synchronization, and player persistence (`PlayerStore`).
- **Data Pipeline (`novaparse/`, `novadatainterface/`)**: Extracts, parses, and serves original Nova game assets (`Ship`, `Outfit`, `Weapon`, `Planet`, `System`, `PICT`, `Cicn`, `snd`, `rlëD`, etc.).

---

## 2. Infrastructure & Topology

| Host / Remote | Details | Access / Deploy |
| :--- | :--- | :--- |
| **Local Machine** | `/Users/anton.wiehe/Code/NovaJS` | Working directory for edits, builds, and test verification. |
| **Development Host (`abakus`)** | Remote dev machine (`100.64.247.42` via Tailscale). Runs NovaJS on port `8000`. | Accessible via `ssh abakus`. Git remote: `abakus` (`abakus:NovaJS`). |
| **Public Production Host (Linode)** | Linode instance serving `https://66.175.210.138`. | Deployed via GitHub Actions workflow on `NotNANtoN/NovaJS`. |
| **GitHub Repository (`origin`)** | `https://github.com/NotNANtoN/NovaJS.git` (branch: `feat-performance-and-modernization`). | Push via `abakus` using stored GitHub credentials. |

---

## 3. Standard Development & Deployment Workflow

Always follow this exact 3-step deployment sequence after making changes:

### Step 1: Verify Build & Tests Locally
```bash
cd /Users/anton.wiehe/Code/NovaJS
npm run build
npm test
```

### Step 2: Commit & Push to Abakus
```bash
git add <modified-files>
git commit -m "<concise descriptive message>"
git push abakus feat-performance-and-modernization
```
*(Note: If the SSH pre-push test hook times out due to network latency, `--no-verify` is acceptable as long as local `npm test` has succeeded).*

Abakus automatically triggers `/home/anton/deploy-novajs-from-git.sh`, which pulls the commit, builds the bundle, and restarts the local Node server on port 8000 (`http://abakus:8000`).

### Step 3: Push to Origin (`NotNANtoN/NovaJS`) via Abakus
Direct push from the local machine may be forbidden (403), but the `abakus` host has valid `NotNANtoN` GitHub credentials configured in `gh` / git:
```bash
ssh abakus 'cd ~/NovaJS && git push --no-verify notnanton feat-performance-and-modernization'
```
This triggers the **Deploy NovaJS** GitHub Actions workflow (`.github/workflows/deploy.yml`), which builds and publishes the production container image and updates the public server at `https://66.175.210.138`.

---

## 4. Key Architectural Rules & Conventions

### NovaECS Systems & `SingletonComponent`
In NovaECS, queries match entities based on required components:
- If a `System` only requests **Resources**, **Events**, or **Queries** in its `args` (without specifying any entity components), its required component filter is empty (`Set([])`).
- Because an empty set is a subset of every entity's component set, an unrestricted system will execute **$N$ times per frame/event** (where $N$ is the total entity count in the star system, typically 30–60).
- **Rule**: Any global/singleton system (HUD updates, event listeners, attribution sweeps, screen resize) **MUST** include `SingletonComponent` in its `args` so it executes exactly once per step on `world.singletonEntity`.

### Target Corners
- Planet / navigation target brackets are cyan/blue (`planetNeutral` / `0x00c8ff`).
- Ship target brackets dynamically reflect hostility and relation:
  - **Hostile**: Bright Red (`targetHostile` / `0xff2828`).
  - **Neutral**: Amber / Yellow (`targetNeutral` / `0xffea00`).
  - **Friendly**: Green (`targetFriendly` / `0x28ff28`).
  - **Disabled**: Gray (`targetDisabled` / `0x888888`).
- Procedural fallbacks prevent white triangle placeholders from appearing if assets are missing.

### Cache Busting
`setupRoutes.ts` dynamically appends the bundle file mtime query string (`browser_bundle.js?v=<mtime>`) into `index.html`. When new builds are deployed, a browser hard-refresh picks up the new bundle immediately.
