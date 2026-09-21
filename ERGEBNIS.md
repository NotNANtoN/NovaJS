# ERGEBNIS.md — Architecture, Modernization & Engineering Philosophy

---

## 1. Core Engineering Philosophy: "Code is Cheap"

> **"Just because it takes effort in coding and testing, never be lazy. Always go for the more advanced, better solution. Code is cheap."**

With modern AI-assisted software engineering, the traditional calculus of technical debt has inverted:
- **Mechanical refactoring is near-zero cost**: Tedious, repo-wide changes (e.g. migrating 200+ files to explicit `.js` ESM imports, modernizing route declarations, adapting proxy lifecycle APIs) can be drafted, verified, and stabilized in minutes rather than days.
- **Never settle for legacy inertia**: Avoid keeping legacy formats (like CommonJS or deprecated framework majors) simply because "it works and refactoring takes effort." Proactively modernize the codebase to the cleanest, most capable standards.
- **Aggressive verification over fear of breaking**: Code quickly, but verify relentlessly with comprehensive unit tests, strict typechecking (`bun run typecheck` with 0 errors), end-to-end flight scenarios, and automated CI/CD validation.

---

## 2. Modernization Roadmap

### A. Pure ECMAScript Modules (ESM) Migration (Completed)
* **Status**: **Completed & Verified**
* **Changes**:
  - Set `"type": "module"` in `package.json`.
  - Configured `tsconfig.json` with `"target": "es2022"`, `"module": "esnext"`, and `"moduleResolution": "bundler"`.
  - Configured `scripts/build.mjs` for native ESM output (`format: "esm"`) with Node 24 ESM shims.
  - Migrated `scripts/test.mjs` and `scripts/run_one_test.mjs` to native ESM with dynamic `import()`.
  - Isolated CommonJS WASM artifact in `nova_wasm/pkg/package.json` (`{"type": "commonjs"}`) to eliminate all bundler warnings.
  - Upgraded pure-ESM packages:
    - `uuid` from `9.0.1` to **`14.0.2`** (and `@types/uuid` to `11.0.0`).
    - `rbush` from `3.0.1` to **`4.0.1`** (and `@types/rbush` to `4.0.0`).
    - `p-queue` from `7.4.1` to **`9.3.3`**.
    - `esbuild-visualizer` to **`0.7.0`**.
    - `@types/sat` to **`0.0.35`**, `lamejs` to **`1.2.1`**.
  - All 183 test suites pass with 0 failures; typecheck passes with 0 errors.

### B. Express 5 Upgrade (Completed)
* **Status**: **Completed & Verified**
* **Changes**:
  - Upgraded `express` to **`5.2.1`** and `@types/express` to **`5.0.6`**.
  - Updated `setupRoutes.ts` parameter handling to cleanly unwrap Express 5's array-capable route parameter types (`string | string[]`).
  - Verified all major endpoints (`/`, `/gameData/ids.json`, `/gameData/data/System/nova:148.json`, `/gameData/data/Planet/nova:128.json`, `/api/galaxy/pilots`) return 200 OK.
  - Native promise rejection handling active in server route handlers.
  - `bun run typecheck` passes with 0 errors; all 183 test suites pass.

### C. Immer 11 Upgrade & NovaECS State Hardening
* **Objective**: Upgrade from Immer `9.0.21` to Immer `11.x`.
* **Benefits**:
  - Reduced bundle size and faster proxy traps.
  - Tighter TypeScript inference for readonly state trees.
* **Execution Steps**:
  1. Upgrade `immer` to `^11.1.0`.
  2. Audit NovaECS draft boundaries (`plainSnapshot`, `deImmerify`, and `createDraft`).
  3. Verify that draft proxies are detached before asynchronous steps resume.
  4. Run the complete ECS and gameplay test suite (`async_system_test.ts`, `mission_plugin_test.ts`, `player_state_test.ts`, `jump_plugin_test.ts`).

---

## 3. Current Stable Baseline (September 2026)

| Component | Current State | Target State |
| :--- | :--- | :--- |
| **Node.js** | Node 24 (Active LTS "Krypton") | Node 24+ LTS |
| **Bun** | 1.4.2 | 1.4.2+ |
| **GitHub Actions** | Checkout v7, Setup-Node v7, Setup-Bun v2.2, Buildx v4.4, Login v4.6, Build-Push v7.4 | Keep pin-to-latest |
| **Module Format** | Native ESM (`"type": "module"`, `"moduleResolution": "bundler"`) | Native ESM |
| **HTTP Server** | Express 5.2.1 | Express 5.2.1 |
| **State Proxy** | Immer 9.0.21 | Immer 11.x |
| **PixiJS** | PixiJS 8.21.0 | Latest v8 |
| **Typecheck** | 0 errors | 0 errors |
| **Test Suite** | 183 / 183 passing | 100% passing |

---

## 4. Gameplay Stabilization & Bug Fixes (September 2026)

### A. Consecutive Hyperjump Fuel Depletion
* **Problem**: After 3 hyperjumps from a starting 3-jump tank (300 units), the third jump would deplete on the client but then suddenly replenish back to 100 units ("1 jump in the pocket").
* **Root Cause**: In `CombatAuthority.acceptOwnerFuel(state)`, if the arriving player's `state.combatResources?.revision` was missing or not found in `this.issuedFuel` on the server, `acceptOwnerFuel` returned `0`. In `server_plugin.ts`, room handoffs consumed this debit: `auth.balance.fuel = Math.max(0, auth.balance.fuel - debit)`. Since `debit` was `0`, the server balance stayed at 100 and `auth.project(target)` overwrote `state.fuel = this.balance.fuel`, wiping out the client's jump fuel consumption. Additionally, in `mergeCombatPlayerState`, debited fuel was never committed to `authority.balance.fuel`.
* **Fix**:
  - In `acceptOwnerFuel`, fall back to `this.balance.fuel` as the baseline when `basis` is not yet indexed, and only discard delayed intents if the client explicitly proposes an older, already-cleared revision (`rev < this.balance.revision && !this.issuedFuel.has(rev)`).
  - In `mergeCombatPlayerState`, commit positive fuel debits immediately to `authority.balance.fuel`.
* **Verification**: Added unit test `honors consecutive jump fuel consumption down to zero even without prior issued basis` in `combat_resources_test.ts`.

### B. Derelict Vessel Capture & Self-Destruct Explosion
* **Problem**: Attempting to capture an uncrewed derelict vessel resulted in "Vessel has already been boarded" or did nothing, leaving the dead derelict frozen in space forever.
* **Root Cause**:
  - In `boarding_plugin.ts`, `boarded` tracked both plundering and capture attempts. Any initial interaction placed the target UUID into `boarded`, permanently blocking subsequent capture attempts with `"Vessel has already been boarded."`
  - In `PlayerBoardingSystem`, derelicts (`isDerelict: true`) had an arbitrary 15% random failure roll that set `resisted = true`, even though derelicts have 0 crew. The vessel remained frozen in space.
* **Fix**:
  - Set `ShipDataComponent` directly during derelict creation in `derelict_plugin.ts`.
  - In `PlayerBoardingSystem`, allow `action === 'capture'` on disabled vessels even if already plundered.
  - When capture succeeds on a derelict (85% base chance): vessel is added to `player.escorts` with nominal maintenance (`10 cr/day`), victim entity is deleted from space, and sound `nova:140` is played.
  - When salvage capture fails on an unstable derelict: anti-tamper / core breach triggers a self-destruct! The derelict starts exploding (`DestructionStartedComponent`, `ExplodingComponent`, `ZeroArmorEvent`, `SoundEvent nova:153`), and the player is notified: `"Derelict salvage failed: Core breach and self-destruct triggered!"`.
* **Verification**: Added unit tests `allows capturing a vessel that was previously plundered` and `triggers core breach and self-destruct when derelict salvage capture fails` in `boarding_plugin_test.ts`.

### C. Mission Computer Procedural & Retail Contract Mixing
* **Problem**: On planets with any retail/story mission (e.g. John Blake storyline on Earth), no procedural contracts (cargo deliveries, rush courier runs, bounties, passenger transport) appeared on the Mission Computer BBS.
* **Root Cause**: In `mission_bbs.ts`, procedural missions were only generated when `resourceOffers.length === 0`. Furthermore, `preferRetailOffers` completely discarded synthetic offers if any retail offer existed.
* **Fix**:
  - Removed the `resourceOffers.length === 0` guard so procedural offers are always generated for the Mission Computer.
  - Combined retail and procedural offers: `this.offers = [...resourceOffers, ...proceduralOffers]`. Story missions appear at the top, followed by 6–12 varied procedural contracts.

### D. Audio Autoplay & 0-Byte Sound File Handling
* **Problem**: Browser console logged `Unable to decode audio data` for `nova:141` / `nova:142`, and `The AudioContext was not allowed to start`.
* **Root Cause**:
  - `setupRoutes.ts` served `ArrayBuffer` data with `res.type('png')` regardless of resource type, and served empty 0-byte sound buffers with `200 OK`, crashing WebAudio's `decodeAudioData`.
  - WebAudio requires an initial user interaction to resume audio contexts under browser autoplay policies.
* **Fix**:
  - In `setupRoutes.ts`, set `res.type('audio/mpeg')` for sound files, and return `404` for 0-byte empty sound resources.
  - In `sound_plugin.ts`, silently fall back for missing/unsupported sound IDs without polluting the console.
  - In `browser.ts`, register a one-time user gesture handler (`pointerdown`, `keydown`) to resume `sound.context` smoothly on first interaction.
