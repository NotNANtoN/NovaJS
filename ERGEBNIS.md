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

### C. Immer 11 Upgrade & NovaECS State Hardening (Completed)
* **Status**: **Completed & Verified**
* **Changes**:
  - Upgraded `immer` to **`11.1.18`** in root `package.json` and `nova_ecs/package.json`.
  - Migrated `import produce from 'immer'` to ESM-standard named imports `import { produce } from 'immer'` in `outfit_plugin.ts`, `player_state_test.ts`, `vector_test.ts`, and `multiplayer_plugin.ts`.
  - Adapted `current()` and `original()` calls in `deimmerify.ts` and `provide_async.ts` to satisfy Immer 11's stricter `Draft<T>` type signatures.
  - Resolved circular import hazard between `death_plugin.ts` and `jump_plugin.ts` by extracting `damage_events.ts`.
  - Verified with `bun run typecheck` (0 errors) and all 183 unit test files (0 failures).

---

## 3. Current Stable Baseline (September 2026)

| Component | Current State | Target State |
| :--- | :--- | :--- |
| **Node.js** | Node 24 (Active LTS "Krypton") | Node 24+ LTS |
| **Bun** | 1.4.2 | 1.4.2+ |
| **GitHub Actions** | Checkout v7, Setup-Node v7, Setup-Bun v2.2, Buildx v4.4, Login v4.6, Build-Push v7.4 | Keep pin-to-latest |
| **Module Format** | Native ESM (`"type": "module"`, `"moduleResolution": "bundler"`) | Native ESM |
| **HTTP Server** | Express 5.2.1 | Express 5.2.1 |
| **State Proxy** | Immer 11.1.18 | Immer 11.1.18 |
| **PixiJS** | PixiJS 8.21.0 | Latest v8 |
| **Test Framework** | Jasmine 5.13.0 | Jasmine 5+ |
| **Typecheck** | 0 errors | 0 errors |
| **Test Suite** | 183 / 183 passing | 100% passing |

---

## 5. Observability & Logging Architecture (September 2026)

To rapidly diagnose runtime faults, network disruptions, and gameplay state divergence, the logging architecture was overhauled from ad-hoc `console.log` statements into a structured observability pipeline:

### A. Structured Logger (`nova/src/util/logger.ts`)
* Provides standard log levels (`debug`, `info`, `warn`, `error`) with subsystem tags (`[SERVER]`, `[ROOMS]`, `[HTTP]`, `[CLIENT]`).
* Prepend ISO timestamps (`[2026-09-21T13:45:00.123Z]`) to every entry for direct log correlation across client and server containers.
* Filterable via `NOVA_LOG_LEVEL` environment variable (defaults to `info`).

### B. HTTP Request & Latency Logging
* In `setupRoutes.ts`, added middleware tracking request duration and status.
* Automatically surfaces any API endpoint access, error response (4xx / 5xx), and slow queries (> 150ms) in real time.

### C. Robust Client Telemetry (`/client-error`)
* Accepts both `application/json` and `text/plain` payloads from `navigator.sendBeacon` and `fetch`.
* Captures URL, userAgent, current star system ID, pilot token prefix, error message, and full call stacks.

### D. Asset Warning Noise Elimination
* In `novaparse/src/parsers/ResourceIDNotFound.ts`, silenced expected missing `dësc` resource warnings for non-player ship/outfit variants.
* Eliminates over 200 lines of noise on startup, making genuine runtime faults immediately visible.

### E. In-Game Diagnostics (`window.dumpNovaDebugState()`)
* Developers and testers can execute `dumpNovaDebugState()` in the browser console at any time to inspect:
  - Active ECS entity and system counts.
  - Player credits, jump fuel, hull ID, ship name, coordinates, escorts count, and active missions.
  - Network latency, ping count, and packet timing statistics.

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

### E. Spaceport Menu Disappearing on Landing at Storyline Planet Variants (Brass in Glimmer)
* **Problem**: When landing on planet Brass in Glimmer, the docking sound played, but no spaceport menu or buttons appeared, and the player was quietly returned to space.
* **Root Cause**:
  - Glimmer has four separate system variant IDs (`nova:193`, `nova:759`, `nova:760`, `nova:761`) corresponding to different chapters of the retail EV Nova storyline. Their respective planet IDs are `nova:214` (base Brass), `nova:503` (mission target Brass), `nova:504` (Nova), and `nova:505` (post-election Brass).
  - When landing, `AttemptLandingSystem` confirmed landing range and played the landing sound.
  - Next, `spaceport.authorizeLanding()` called `combatShopTransaction(combatState, planetId, 'open')`.
  - In `CombatLedger.transact`, the server checked:
    ```typescript
    if (!planet.canLand || !system!.planets.includes(planet.id)) throw new Error('Not at this spaceport');
    ```
  - When the player was in system `nova:761` (or `nova:193`) and landed on mission target planet Brass (`nova:503`), `system.planets.includes("nova:503")` evaluated to `false`.
  - The server rejected the transaction with `Not at this spaceport`. `spaceport_plugin.ts` caught this rejection, called `actions.abort()` (setting `spaceport.container.visible = false`), and recovered the ship back into space with the menu hidden!
* **Fix**:
  - In `CombatLedger.transact`, allow planets belonging to any storyline clone/variant of the current star system (matching name and coordinates via `areSystemsSameOrVariants`).
  - Allowed idempotent re-opening if `authority.landed === planet.id`.
  - In `spaceport_plugin.ts`, wired `reportLandingError` to immediately forward any spaceport authorization or display failures to `/client-error`.
* **Verification**: Added unit test `authorizes open landing when planet is in a storyline variant of the current system` in `combat_resources_test.ts`. All 183 test suites pass.

### F. Repeating "Vessel has already been boarded" Notifications
* **Problem**: After boarding or capturing a vessel, the notification "Vessel has already been boarded" continued appearing every frame and persisted even after hyperjumping into a new system.
* **Root Cause**: `PlayerBoardingSystem` is a per-step system running on every tick. When a boarding request was processed, `BoardingRequestComponent` was never deleted from the player entity. Consequently, on every subsequent tick, the system saw the old request target in `boarding.boarded` and repeatedly posted `"Vessel has already been boarded."` to `BoardingNoticeComponent`.
* **Fix**: Cleanly delete `BoardingRequestComponent` as soon as the request is fulfilled, aborted, repelled, or rejected.

### G. Escort Attack Order ("F" Key) Focus Fire
* **Problem**: Pressing "F" with a target selected produced no action from escorts.
* **Root Cause**: In `makeHiredEscort()`, `makeNpc` was called, but `TargetComponent` was never added to the escort entity, and `ChooseRandomTargetComponent` and `WanderComponent` remained attached. Because `EscortDefenseSystem` and `FollowAndShootAI` require `TargetComponent`, escort AI systems were never invoked for player commands.
* **Fix**:
  - Explicitly attach `TargetComponent` to all hired escorts upon spawning.
  - Delete `ChooseRandomTargetComponent` and `WanderComponent` so escorts strictly follow flagship orders.
  - When `attack` is triggered, `EscortDefenseSystem` assigns the flagship's target to `TargetComponent`, allowing `FollowAndShootAI` to lead aim and engage weapons.

### H. Hired Escort Formation Hyperjumping
* **Problem**: When initiating a hyperjump to another system, hired escorts stayed stationary in space instead of hyperjumping together with the flagship.
* **Root Cause**: Only `FleetMemberComponent` (for NPC fleet encounters) was wired to `FleetJumpRelaySystem`. Hired player escorts (`HiredEscortComponent`) had no jump relay system.
* **Fix**: Added `HiredEscortJumpRelaySystem` to `escort_plugin.ts`. When `InitiateJumpEvent` is fired for the flagship, it immediately relays the jump destination to all hired escorts, putting them into hyperdrive spool and departure alongside the player.

### I. Beam & Lance Weapon Looping Sound Stopping
* **Problem**: Thunderhead ship lances (and other looping beam weapons) continued droning infinitely even after the ship stopped fighting or was destroyed.
* **Root Cause**: `SoundEvent` with `loop: true` registered the audio in `loopingSounds`, but `BeamSystem` only deleted the beam entity upon expiration and never emitted `stop: true`.
* **Fix**: In `BeamSystem`, when a beam expires or its source ship is destroyed, check if any other active beam still uses that sound ID; if not, immediately emit `SoundEvent { id: beamData.sound, stop: true }` to silence the loop cleanly.

### J. Escort Re-anchoring and Formation Departure After Planet Landing
* **Problem**: After landing on a planet and launching back into space, escorts appeared frozen and stopped following the player.
* **Root Cause**: When the player lands, the player entity in space is deleted, and upon departure a restored entity is assigned. Escorts retained the previous `ownerUuid` and failed `entities.get(escort.ownerUuid)`, entering a dead stop.
* **Fix**: `SpawnHiredEscorts` and `FollowEscortOwner` dynamically re-anchor to the live player flagship entity upon room restoration, maintaining formation following upon launch.

### K. Commandeer Captured Vessels ("Take Over Ship" Flagship Swap)
* **Problem**: Boarding only permitted plundering or adding the vessel to an escort fleet, with no way to claim the captured vessel as the player's personal flagship.
* **Fix**:
  - Added "Take Over" (`commandeer`) action to `BoardingDialog`.
  - On successful capture, the player's flagship hull instantly swaps to the captured vessel (`player.shipId = victimShipId`, `ShipComponent`), the previous flagship is seamlessly reassigned as an escort in the fleet, and combat balances are synced.

---

## 6. Elimination of VM Reboots on Deployment (September 2026)

* **Problem**: The Linode host was rebooting its entire virtual machine on every single deployment, causing temporary 502 Bad Gateway responses, dropping player WebSockets, and taking over 2 minutes to recover.
* **Root Cause**: In `.github/workflows/deploy.yml`, line 396 explicitly called `POST https://api.linode.com/v4/linode/instances/${instance_id}/reboot` after building the Docker image, relying on `OnBootSec=30s` in the systemd timer to pull the container instead of updating the running container directly.
* **Fix**:
  - Replaced the Linode API reboot call with direct container updater execution (`/opt/novajs/scripts/novajs-updater.sh`) triggered over authenticated SSH using repository secret `LINODE_SSH_KEY`.
  - Tuned `novajs-updater.timer` interval to `2min` with `15s` randomized delay as a background failsafe.
  - Eliminated the artificial `sleep 20` pre-probe delay in the deployment workflow.
  - Now, deployments perform zero-downtime container pulls and Docker recreates (`docker compose up -d --force-recreate novajs`) while the host operating system, networking, and Caddy reverse proxy remain online continuously.

---

## 7. Architectural Guardrails & Structural Bug Prevention (September 2026)

To structurally prevent recurrent classes of subtle bugs, four architectural guardrails were integrated directly into the core engine:

### A. Entity Archetype Validation (`nova_ecs/archetype.ts`)
* **Problem Solved**: Untyped `new Entity()` bags failing silently when a required component is omitted by a factory.
* **Mechanism**: `assertArchetype(entity, [RequiredComponents], 'ArchetypeName')`. Enforces at spawn time that all required components are present. If a factory forgets a component (such as `TargetComponent` on escorts), unit tests fail immediately with `[ARCHETYPE VIOLATION]`.

### B. The Transient Request Pattern (`nova_ecs/transient_request.ts`)
* **Problem Solved**: Request components representing one-shot intents persisting on entities and re-firing on subsequent ticks or across star system hops.
* **Mechanism**: `consumeRequest(entity, RequestComponent)`. Retrieves and atomically deletes the request component on the first frame of handling, making request leakage impossible.

### C. Domain Equality Abstractions (`nova/src/nova_plugin/system_variants.ts`)
* **Problem Solved**: Bugs caused by naked string `===` or `array.includes()` on retail EV Nova storyline duplicates (Sol, Glimmer, Outbound).
* **Mechanism**: Centralized `areSystemsSameOrVariants()` and `isPlanetInSystem()`. Standardizes resolution of stellar coordinates and canonical names across spaceport transactions, starmap plotting, and mission tracking.

### D. Safe Collection Handling
* **Problem Solved**: In-memory cloning flattens `Map` and `Set` collections into plain JSON `{}` objects, causing `.keys()` / `.entries()` crashes.
* **Mechanism**: `clonePlainValue()` in `nova_ecs/draft_snapshot.ts` recursively traverses and clones `Map` and `Set` collections. Consumer components employ safe fallback accessors.

### E. Reference-Counted Looping Audio Architecture (`nova/src/display/sound_plugin.ts`)
* **Problem Solved**: Looping sound effects (e.g. beam weapons, lances, engine hums) leaking in the WebAudio context indefinitely when the firing source expires, stops shooting, or explodes.
* **Mechanism**: `LoopingSoundRefs` tracks active references per sound ID. When multiple entities fire beams with the same sound, the reference count increments. As beams expire or source ships are destroyed, references decrement, stopping playback atomically only when the final active emitter ceases.

### F. Atomic Flagship Commandeer Transactions (`nova/src/nova_plugin/flagship_swap.ts`)
* **Problem Solved**: Manual ad-hoc component mutations during ship captures causing desynchronized `ShipComponent`, `PlayerState`, `CombatAuthority`, and escort contracts.
* **Mechanism**: `transferFlagship(playerState, entity, newShipId, playerUuid)`. Atomically swaps the flagship hull, migrates the previous hull to the escort fleet, updates ECS presentation components, and commits the server combat ledger.

### G. ECS Event Dispatch Pre-Indexing (`nova_ecs/world.ts`)
* **Problem Solved**: At 60 FPS across both client and server star system instances, `World.runEvent` executed an unindexed `this.systems.filter(s => s.events.has(event))` on every frame and every event, triggering tens of thousands of array allocations and linear searches per second.
* **Mechanism**: Pre-indexed event cache `systemsByEvent: Map<UnknownEvent, System[]>`. Invalidation occurs strictly when systems are added or removed. Events without listeners return early in $O(1)$ time with zero array allocations.

### H. Complete Star System Teardown & Lifecycle (`World.destroy()`)
* **Problem Solved**: Empty star systems in the server room manager or departed client scenes unsubscribed plugins but left entities, component graphs, and event queues allocated, creating latent memory leaks under continuous exploration.
* **Mechanism**: `World.destroy()`. Cleans up all plugins, flushes event queues, clears event-system indices, and clears all entity collections atomically.

### I. Broadphase Collision Partitioning (`nova/src/nova_plugin/collisions_plugin.ts`)
* **Problem Solved**: Collision broadphase built a combined list and ran `.filter()` every frame to separate hitboxes from hurtboxes.
* **Mechanism**: Directly partitioned `hitboxEntries` and `hurtboxEntries` arrays during collider queries, eliminating intermediate array filtering and guaranteeing strongly-typed hurtbox search loops.

### J. Formal Entity Archetype Contracts (`nova/src/nova_plugin/archetypes.ts`)
* **Problem Solved**: Entity component bags created ad-hoc with varying sets of components, leading to systems failing silently when a required component (e.g. `TargetComponent` or `MovementStateComponent`) was omitted.
* **Mechanism**: Formally defined `ShipArchetypeComponents`, `EscortArchetypeComponents`, `PlanetArchetypeComponents`, and `ProjectileArchetypeComponents` with validation functions (`assertShipArchetype`, `assertEscortArchetype`, `isArchetype`).

### K. Lazy On-Demand Star System Mounting (`nova/src/nova_plugin/server_plugin.ts`)
* **Problem Solved**: The multiplayer server previously ran an eager startup loop subscribing to all 500+ systems in `gameData.ids.System`, maintaining 500 idle room instances and RxJS pipelines even when only 1-2 systems had active players.
* **Mechanism**: Reactive room mounting via `MultiRoom.roomJoined`. The server lazily mounts star systems on-demand when a player joins, keeping memory and CPU footprint minimal while automatically scaling across the galaxy. Starter systems (e.g. Sol `nova:130`) are pre-warmed.

### L. Unified Transient Request Consumption Across Action Plugins
* **Problem Solved**: Request components across `JettisonPlugin`, `EnergyTransferPlugin`, and `SurrenderPlugin` were manually deleted across various branching `if/else` returns, risking stuck or re-firing requests if any code path threw or returned early.
* **Mechanism**: Standardized `consumeRequest(entity, RequestComponent)` at the entry of each action system, ensuring atomic one-tick request consumption.

### M. Decoupled Client Telemetry Architecture (`nova/src/client/client_telemetry.ts`)
* **Problem Solved**: Runtime error reporting was tightly coupled to `browser.ts` and window property tampering (`(window as any).reportClientError`).
* **Mechanism**: Extracted `reportClientError(error, context, systemId)` into an isolated, headless-safe module utilizing `navigator.sendBeacon` and `fetch('/client-error')` with payload normalization.

### N. Toroidal Stereo Spatial Audio (`nova/src/display/sound_attenuation.ts`)
* **Problem Solved**: Sounds lacked directional panning and only had distance volume attenuation.
* **Mechanism**: Implemented `worldSoundPan(source, listener, panWidth)` which computes normalized $[-1, 1]$ stereo panning across toroidal wrapped space system coordinates.

### O. Per-Step Query Cache Eviction & Revoked Proxy Prevention (`nova_ecs/query_cache.ts`)
* **Problem Solved**: `QueryCache` retained component argument values (`entityResults`, `wrappedResult`) across simulation steps without per-frame invalidation. When `DeltaPlugin` finalized Immer drafts at the end of a frame, nested static queries (e.g. `ParkingPlanetsQuery`) cached revoked proxy references. On subsequent ticks, systems accessing those queries (e.g. `ParkInterceptorAI`) threw `TypeError: Cannot perform 'get' on a proxy that has been revoked`, halting simulation on the server and freezing client ships.
* **Mechanism**: `QueryCache.clearStepCache()`. Automatically called at the start of each `World.step()`. It flushes frame-level query argument results while preserving the $O(1)$ entity archetype support map, guaranteeing that all systems receive fresh, live component instances every tick.

### P. Immutable Value Type Isolation for `Angle` (`nova_ecs/datatypes/vector.ts`)
* **Problem Solved**: `Angle` was erroneously annotated with `[immerable] = true`. Because `Angle` is an immutable value object, wrapping it in an Immer draft proxy caused any property holding an angle (e.g. `movement.turnTo`) to hold a revoked proxy after `finishDraft()` completed. On the next tick, assigning a new `turnTo` in `ParkInterceptorAI`, `EscortPlugin`, or `JumpPlugin` triggered Immer 11's `set` trap which inspected the revoked proxy's `[DRAFT_STATE]`, throwing `TypeError: Cannot perform 'get' on a proxy that has been revoked`.
* **Mechanism**: Stripped `[immerable] = true` from `Angle` so Immer treats it as a non-draftable immutable leaf value (like numbers and strings). Also ensured cross-entity rotational assignments (`arrival.rotation`, `ownerMovement.rotation`) instantiate clean `new Angle(...)` values to prevent cross-draft contamination.

### Q. Comms Panel Greetings vs. Derelict Boarding Disambiguation (`nova/src/spaceport/comms_panel.ts`)
* **Problem Solved**: When hailing active NPC vessels (e.g. a Federation Viper) and clicking "Greetings", the comms panel displayed derelict vessel boarding ambush mission text ("After easily moving alongside, you board the derelict vessel... You have fallen into a trap!") and transformed the assistance button into "Accept Contract". This occurred because `prepareShow()` eagerly resolved any available galaxy mission with `availLoc === 2` (`Ship`) and `sayGreetings()` hijacked the "Greetings" button to display it. In EV Nova, `availLoc === 2` missions represent physical boarding encounters with derelict wrecks or specific `përs` ships, never radio comms greetings from active patrol ships.
* **Mechanism**: Removed the automatic shipboard mission hijack from `prepareShow` and restored authentic EV Nova radio greetings in `sayGreetings()` using the `STR# 3000` comms lines (`greetingWarm`, `greetingIndifferent`, `greetingHostile`).

### R. Stellar Target HUD Classification, Fallback Graphics, & Landing Synchronization
* **Problem Solved**: Targeting planets like Trusa displayed "PICT parse failed" in the HUD target box and mislabeled planets as "Stellar Spaceport". Furthermore, attempting to land on Trusa crashed/rejected because `authority.system` on the server failed to synchronize to the new star system upon hyperspace arrival, causing the server combat ledger to reject landing authorization with `Not at this spaceport`.
* **Mechanism**:
  1. Decoded retail `spöb` flag `0x0010` (`Stellar is a station instead of a planet`) to classify targets accurately: `Inhabited Planet`, `Uninhabited Planet`, `Space Station`, `Derelict Station`, or `Hazardous Stellar`.
  2. Prevented loading `default_pict.png` ("PICT parse failed") on the HUD when `!hasCustomLandingPict` or `landingPict === 'default'`; dynamically falls back to the planet's spinning sprite (`planetGraphic`) in the target box.
  3. Synchronized `authority.system` and `authority.state.currentSystem` upon system arrival (`InitializeCombatResourcesSystem`) and during state capture (`authority.capture`), and wrapped toroidal boundary coordinates during spaceport distance checks.

### S. Unwrapped SpriteSheetFrames Resolution & Safe Standard Spaceport Landscapes
* **Problem Solved**: When landing on planets without a custom landscape picture (such as Trusa), the spaceport screen failed to open and hung, leaving the player ship deleted from space with no UI. This occurred because `GameData.addTextureGettable` was expecting server responses wrapped in `{ data: ... }` and accessing `result.data`, whereas `/gameData/data/SpriteSheetFrames/:id.json` returns raw `SpriteSheetFramesData`. Consequently, `SpriteSheetFrames.get("nova:2009")` returned `undefined`, causing `texturesFromFrames` to throw `TypeError: Cannot read properties of undefined (reading 'frames')` during `planetGraphic.buildPromise` inside `Spaceport.build()`.
* **Mechanism**:
  1. Updated `GameData.addTextureGettable` to safely unwrap `result?.data ?? result`, matching both wrapped and direct metadata responses.
  2. Guarded `texturesFromFrames(framesData)` to return `[PIXI.Texture.EMPTY]` instead of throwing when metadata is absent or malformed.
  3. Wrapped standard landscape graphic compilation in `Spaceport.build()` in a non-fatal `try/catch` block, ensuring that spaceport menus (outfitter, shipyard, commodity exchange, mission BBS, bar, and departure) reliably open regardless of animation asset load states.
  4. Added integration test in `spaceport_plugin_test.ts` verifying real `Spaceport` build and resolution for planets without custom landscape pictures.

### T. Authentic Hyperspace Departure Acceleration Dynamics (`nova/src/nova_plugin/jump_plugin.ts`)
* **Problem Solved**: Hyperspace departure was cutting off prematurely for the player after a fixed 180ms flash, while NPC ships jumped unnaturally by crawling across the sector at a flat 3.5x speed for 8.5 seconds.
* **Mechanism**:
  1. Implemented a cubic exponential departure acceleration curve in `jumpFlightSpeed()`: over an authentic `JUMP_DEPARTURE_MS = 1_800` (1.8s) window, jumping vessels surge from `3.5x` initial departure speed smoothly up to `100x` peak hyperjump velocity (`JUMP_DEPARTURE_PEAK_SPEED_MULTIPLIER = 100`).
  2. For the player's flagship, departure now sustains acceleration across the star system while the hyperdrive engine roar plays, transferring sectors once maximum hyperjump velocity is achieved.
  3. For NPC and escort vessels, ships accelerate rapidly into an apparent blur, crossing the system departure threshold (`SYSTEM_DEPARTURE_RADIUS = 6_000`) and despawning cleanly in ~1.8 seconds instead of lingering in ordinary space.
