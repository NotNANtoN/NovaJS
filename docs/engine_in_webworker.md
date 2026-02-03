# Implementation Plan: Moving the Game Engine to a Web Worker

This document outlines a staged plan for moving NovaJS simulation into a Web Worker.

The immediate goal is not rollback networking itself. The goal is to isolate simulation from main-thread rendering stalls so a slow frame does not slow the authoritative local simulation. That should improve consistency and is a useful prerequisite for rollback, but it does not by itself provide rollback correctness. Rollback will still require deterministic stepping, input history, state save/restore, and a different multiplayer protocol.

## Goals

1. Run the simulation on a fixed timestep that is not tied to rendering speed.
2. Keep rendering on the main thread.
3. Share as much of the existing ECS/component model as practical between simulation and display.
4. Avoid full-world serialization every tick.
5. Make the resulting architecture compatible with a later rollback implementation.

## Non-Goals

1. Replacing the current multiplayer protocol in the same change.
2. Designing a bespoke render-only data model up front.
3. Interpolating with arbitrary animation curves that ignore game physics.

## High-Level Architecture

### Simulation World (Web Worker)

The worker owns the authoritative local game simulation.

Responsibilities:
- Run the ECS world at a fixed tick rate, for example 60Hz.
- Consume normalized input events from the main thread.
- Run all game logic systems.
- Produce render-oriented state updates for the main thread.
- Remain independent of DOM, PIXI, and browser event sources.

### Display World (Main Thread)

The main thread owns rendering and browser/UI integration.

Responsibilities:
- Capture browser input and forward it to the worker.
- Receive simulation updates from the worker.
- Maintain a display ECS world that contains entities/components needed by display systems.
- Run PIXI and all display-only systems on `requestAnimationFrame`.
- Host browser-only UI such as menus, spaceport interactions, and sound playback.

## Why This Helps

Running simulation in a worker should help with the specific problem where graphical lag slows simulation for one player but not another.

Today, the browser entrypoint steps the world from the PIXI ticker, so simulation progress is coupled to render progress. If rendering stalls, simulation stalls too. Moving simulation into a worker and stepping it with a fixed timestep removes that coupling.

This does not guarantee cross-client consistency on its own:
- the simulation still has to be deterministic,
- networking still has to exchange inputs rather than naive state updates,
- and rollback still needs save/load of prior states.

But isolating simulation from render stalls is a sound prerequisite.

## Key Design Decisions

### 1. Deterministic Time Comes First

Before moving substantial logic into a worker, replace wall-clock-driven ECS time with a fixed-step simulation clock.

Requirements:
- The simulation world must not use `new Date().getTime()` or render-frame deltas to advance gameplay.
- The worker loop should inject a constant `delta_ms`/`delta_s` into a simulation time resource each tick.
- The simulation must be able to step exactly `N` ticks given the same starting state and same input sequence.

Implementation direction:
- Add a new fixed-step time plugin/resource for simulation worlds.
- Keep existing wall-clock/render-time behavior only for display systems that genuinely need frame time.
- Do not rely on `setInterval` timing accuracy for determinism. `setInterval` should only schedule when to execute the next fixed tick; each tick should still advance simulation by a constant delta.

### 2. Reuse Existing Components Where Practical

The display world should, as a default, reuse the same ECS components as the simulation world for state that must be rendered.

That means:
- do not introduce a large parallel tree of render-only DTOs up front,
- prefer sending component updates for existing components,
- and only split components when they are too large or contain data that should not cross the worker boundary.

This keeps the display world close to the simulation model and avoids duplicating domain state.

A component should be split only if one of these is true:
- the component contains large data that rendering does not need,
- the component mixes authoritative simulation state with browser-only display objects,
- or the component changes at a frequency/pattern that makes transport too expensive.

### 3. Do Not Run Game Logic Twice

The display world should contain display state, not a second simulation.

That means:
- no gameplay systems in the display world,
- no control systems that mutate authoritative movement state on the main thread,
- and no reuse of simulation systems as a shortcut for interpolation if those systems advance gameplay.

If interpolation or extrapolation is needed, it should be implemented as display-only systems that operate on simulation snapshots and physics data, not by re-running the simulation plugin set.

### 4. Render Transport Should Be Delta-Oriented

Do not send full snapshots every tick.

Instead, create a worker-to-display transport tailored to rendering:
- entity add/update/remove messages,
- component-level deltas for render-relevant components,
- periodic full sync for newly visible entities or recovery,
- and explicit handling for high-volume transient entities such as projectiles.

This transport may share machinery with the existing delta system, but it should not be forced to share the exact same policy as network multiplayer.

The important separation is:
- multiplayer transport decides what remote peers must know for consistency,
- render transport decides what the local display thread needs for presentation.

These can reuse the same encoder/apply-delta primitives while using different inclusion rules.

### 5. Browser Input Must Become Explicit Worker Input

The worker must not depend on browser event plugins.

Instead:
- main thread captures keyboard/mouse/browser events,
- converts them into normalized control events or control state updates,
- sends them to the worker,
- and the worker updates its control resources from those messages.

This likely requires factoring current controls so browser event capture and gameplay control application are separate concerns.

### 6. Browser/UI Ownership Stays on the Main Thread

Browser-only UI should remain on the main thread unless there is a strong reason to move it.

That includes:
- PIXI scene graph updates,
- menus and spaceport UI,
- sound playback,
- browser focus/resize/fullscreen behavior.

When UI needs simulation information, the worker should expose it as state/events. The worker should not directly control browser UI objects.

### 7. Game Data Loading Must Be Split From Display Asset Loading

This is the first concrete implementation step. See [docs/game_data_split_for_worker.md](./game_data_split_for_worker.md) for the detailed design.

Summary:
- split the current browser `GameData` responsibilities into a worker-safe `SimulationGameData` layer and a main-thread `DisplayAssetData` layer,
- keep simulation dependent only on structured gameplay data,
- keep PIXI textures, sprites, sounds, and other browser display assets on the main thread,
- and avoid making the worker perform arbitrary RPCs back into a main-thread `GameData` instance for normal data access.

## Implementation Steps

### Step 1: Split Game Data Loading From Display Asset Loading

1. Implement the `SimulationGameData` / `DisplayAssetData` split described in [docs/game_data_split_for_worker.md](./game_data_split_for_worker.md).
2. Ensure simulation-world construction depends only on worker-safe structured gameplay data.
3. Keep PIXI textures, sprites, sounds, and display-only resources on the main thread.
4. Avoid worker-to-main-thread RPC for normal simulation data reads.

Deliverable:
- the simulation can be constructed from a worker-safe data layer with no PIXI or sound dependencies.

### Step 2: Introduce a Fixed-Step Simulation Clock

1. Add a simulation time resource/plugin that advances by a constant delta per tick.
2. Update the simulation plugin stack to use that fixed-step clock instead of wall-clock time.
3. Verify that core movement/combat systems can run under fixed-step time without depending on render cadence.
4. Keep display-side frame timing separate.

Deliverable:
- a world that can be stepped deterministically with `stepFixed(1)` semantics.

### Step 3: Split Browser Input Capture From Control Application

1. Refactor browser input handling into two layers:
- browser event capture on the main thread,
- control-state application inside the simulation world.
2. Define worker-safe input messages, for example:
- key/button pressed/released,
- pointer targeting updates if needed,
- UI commands such as land, map, or weapon selection.
3. Replace any simulation dependency on DOM event plugins with worker-consumable resources/events.
4. Decide which controls are simulation controls and which are display/UI controls.

Deliverable:
- the same player actions can drive the game without the simulation world touching `document` or `window` input events.

### Step 4: Add the Worker Runtime

1. Create `packages/nova/src/worker.ts`.
2. Bundle it separately from the browser bundle.
3. Expose a small worker API. Keep it narrow.

Suggested API shape:

```ts
interface EngineWorkerApi {
    initialize(init: WorkerInit): Promise<void>;
    pushInput(events: InputMessage[]): void;
    resizeViewport(size: { x: number; y: number }): void;
    subscribeRenderUpdates(callback: (update: RenderUpdate) => void): void;
    subscribeUiEvents(callback: (event: UiEvent) => void): void;
    dispose(): Promise<void>;
}
```

Notes:
- `resizeViewport` belongs here only if simulation logic cares about viewport-dependent behavior. Otherwise keep it on the main thread.
- Use Comlink if it stays simple, but the API should be message-oriented even if Comlink is used.

Deliverable:
- the browser can construct the simulation worker and start/stop it.

### Step 5: Define a Render Sync Layer

Create a worker-to-display sync layer specifically for rendering.

### Render Sync Principles

1. Reuse existing component types where practical.
2. Sync only components required by display systems.
3. Support entity create/update/delete.
4. Support high-frequency transient entities efficiently.
5. Allow occasional full sync/resync for recovery and debugging.

### Suggested Structure

Define a `RenderUpdate` with these categories:
- `spawn`: entities newly relevant to display, sent with full render-relevant component state.
- `update`: component deltas for existing entities.
- `remove`: deleted/no-longer-visible entities.
- `events`: one-shot display events such as sounds, flashes, or UI prompts.

Example sketch:

```ts
interface RenderSpawn {
    uuid: string;
    components: Map<string, unknown>;
}

interface RenderEntityUpdate {
    uuid: string;
    components: Map<string, unknown>;
}

interface RenderUpdate {
    tick: number;
    spawn: RenderSpawn[];
    update: RenderEntityUpdate[];
    remove: string[];
    events: DisplayEvent[];
}
```

The encoded form does not need to match this exact shape. The key point is to send component updates, not full-world snapshots.

### Relationship to Existing Delta Infrastructure

The existing delta system should be treated as a likely foundation, not a finished answer.

Recommended approach:
- extract reusable delta encoding/application helpers,
- add a render sync policy that determines which entities/components are included,
- keep network and render inclusion rules separate,
- and only unify them where the semantics actually match.

Special case: projectiles and other transient entities.
- They may be too expensive or unnecessary for peer-to-peer consistency.
- They are still required for local rendering.
- Therefore render sync must be allowed to include entities that multiplayer sync omits.

Deliverable:
- a render update packet format and systems that produce/apply it.

### Step 6: Build the Display World Around Synced Components

1. Construct a display world on the main thread.
2. Add display plugins only.
3. Register the subset of components that display systems use.
4. Apply worker `RenderUpdate`s into display-world entities.

Important rule:
- display entities should store synchronized component state, but should not run gameplay systems that mutate authoritative simulation.

This means some current display systems may need refactoring if they assume the full simulation plugin stack is present.

Deliverable:
- the display world renders from synced ECS state coming from the worker.

### Step 7: Add Display-Only Prediction/Interpolation If Needed

Do this only after the worker-driven version is functioning correctly.

If raw worker updates are visually smooth enough, stop here.

If smoothing is needed:
1. Implement display-only interpolation/extrapolation systems.
2. Base them on simulation state such as position, velocity, rotation, and angular velocity where available.
3. Never mutate the authoritative synced state directly; maintain separate display presentation state if necessary.
4. Snap or blend back to authoritative values when divergence exceeds thresholds.

This keeps smoothing physics-informed without re-running game logic.

Deliverable:
- optional display smoothing that does not affect authoritative simulation.

### Step 8: Route UI and Game Events Explicitly

Some things should not be inferred by diffing components alone.

Add explicit worker-to-main-thread events for:
- sounds to play,
- explosion/impact flashes,
- landing/spaceport UI transitions,
- notifications or prompts,
- and any other one-shot effects that are awkward as persistent component state.

For spaceport and landing flows, prefer this ownership split:
- worker decides authoritative game state and when landing is allowed/has occurred,
- main thread owns the menu/UI presentation,
- messages flow both ways for user choices.

Deliverable:
- a clean event boundary for browser-only UI.

### Step 9: Migrate Incrementally

Do not move the entire game in one shot.

Suggested order:
1. split `GameData` into worker-safe simulation data and main-thread display asset layers,
2. fixed-step deterministic time,
3. input/control refactor,
4. worker boot with a minimal simulation world,
5. render sync for a small set of entities/components,
6. display world rendering from worker state,
7. expand synced coverage until the current gameplay loop works,
8. add optional smoothing,
9. only then start rollback-specific work.

## Rollback Readiness Checklist

This worker refactor should leave the codebase ready for a later rollback implementation.

The design should preserve these future requirements:
- fixed deterministic stepping,
- input history by simulation tick,
- the ability to serialize or clone authoritative game state for rewind/resim,
- separation between authoritative simulation and presentation,
- and a transport model that can eventually carry inputs rather than naive state deltas.

## Open Issues To Resolve During Implementation

1. Which components are required by current display plugins, and which of those should be split?
2. Whether the existing serializer/delta plugins can support a render sync profile cleanly, or whether a separate render encoder is simpler.
3. How projectile-heavy scenes should be encoded efficiently for the display thread.
4. Which UI controls belong entirely on the main thread versus the worker.
5. Whether jumps/system transitions should be owned by one long-lived worker world or by worker-managed per-system worlds.
6. How to provide worker-safe game data without dragging PIXI/audio loading into the simulation layer.
7. Whether game data should be preprocessed once on the server/build side and shipped to both worker and main thread in a more worker-friendly format.

## Recommended First Milestone

The first milestone should be deliberately narrow:
- split `GameData` so the simulation can depend on a worker-safe data layer,
- fixed-step simulation time,
- worker-hosted movement/combat for one active system,
- main-thread display world rendering from worker updates,
- keyboard controls piped into the worker,
- no rollback yet,
- no fancy interpolation yet.

If that milestone works, the architecture is probably sound enough to extend.
