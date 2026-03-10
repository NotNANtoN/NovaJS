# Implementation Plan: Moving the Game Engine to a Web Worker

This document outlines a staged plan for moving NovaJS simulation into a Web Worker.

The immediate goal is to prove that simulation and rendering can be separated cleanly, first in a single thread and then across a worker boundary. Rollback multiplayer is a later concern and is tracked separately in [docs/rollback_multiplayer.md](./rollback_multiplayer.md).

## Goals

1. Prove that simulation can run independently of display systems.
2. Keep rendering and browser/UI work on the main thread.
3. Reuse existing ECS components where practical instead of inventing a parallel render data model up front.
4. Establish a narrow, one-way state sync from simulation world to display world.
5. Reuse the same sync model when the simulation world is later moved into a worker.

## Non-Goals

1. Implementing rollback multiplayer in this work.
2. Switching simulation to a fixed timestep yet.
3. Designing a bespoke render-only schema up front.
4. Solving smoothing, interpolation, or prediction before the world split works.

## Why This Order

There are three separate risks here:

1. The simulation/display split may be awkward in the current ECS structure.
2. The state sync layer may be more invasive than expected.
3. The worker boundary may add practical complications around data loading, input, and messaging.

These should be proven separately.

So the order should be:

1. split into two ECS worlds in one thread,
2. replace the naive sync with a delta-based sync,
3. move the simulation world into a worker.

That keeps each commit focused on one architectural risk.

## High-Level Architecture

### Simulation World

The simulation world owns authoritative gameplay state.

Responsibilities:
- run gameplay systems,
- own simulation-side resources such as `SimulationGameData`,
- accept normalized control/input messages,
- produce synchronized state for rendering,
- remain free of PIXI, sound playback, and browser UI objects.

### Display World

The display world owns presentation state and browser integration.

Responsibilities:
- run display-only systems,
- own `DisplayAssetData`,
- render with PIXI,
- host browser/UI concerns such as menus, sound playback, and resize handling,
- consume synchronized state from the simulation world.

### Sync Direction

State copy is one-way:

- simulation world -> display world

The display world is never authoritative for shared gameplay state.

If the user performs an action from the UI, it should be sent back to the simulation world as an explicit event or command. The display world should not mutate mirrored gameplay components and expect the simulation world to discover that change.

## Key Design Decisions

### 1. Reuse Existing Components Where Practical

The display world should, by default, reuse the same component types as the simulation world for state that must be rendered.

That means:
- do not introduce a large tree of render-specific DTOs up front,
- prefer copying existing component data,
- only split components when they are too large or contain simulation-only and display-only concerns that should not travel together.

### 2. Do Not Run Game Logic Twice

The display world should not run gameplay systems.

That means:
- no authoritative movement/combat/control systems in the display world,
- no display-side mutation of authoritative simulation state,
- no hidden second simulation on the main thread.

### 3. Start With a Narrow Sync Surface

The first synchronizer should be deliberately small and simple.

Do not try to mirror every simulation component immediately.

Instead:
- identify the minimum set of components needed to render one active system correctly,
- copy only those,
- and expand later once the architecture is proven.

### 4. Keep Browser/UI Ownership on the Main Thread

These stay in the display world:
- PIXI scene graph state,
- sound playback,
- menus and spaceport UI,
- browser event capture,
- resize/focus/fullscreen behavior.

When browser/UI actions need to affect gameplay, they should cross the boundary as explicit commands.

### 5. Game Data Loading Stays Split

This work builds on the `SimulationGameData` / `DisplayAssetData` split described in [docs/game_data_split_for_worker.md](./game_data_split_for_worker.md).

Summary:
- simulation world uses `SimulationGameData`,
- display world uses `DisplayAssetData`,
- the browser compatibility `GameData` facade is not the long-term runtime dependency for either side.

## Implementation Steps

### Step 1: Split Into Two ECS Worlds in One Thread

Create two separate worlds that still run in the same process and are stepped by the same top-level loop.

#### Simulation World

- owns simulation plugins and authoritative gameplay components,
- uses `SimulationGameData`,
- does not know about PIXI or display asset loading.

#### Display World

- owns display plugins only,
- uses `DisplayAssetData`,
- does not run gameplay systems.

Deliverable:
- the game runs with separate simulation and display worlds while still remaining single-threaded.

### Step 2: Add a Narrow, Naive One-Way State Copier

Implement the simplest possible synchronizer from simulation world to display world.

Initial constraints:
- one-way only,
- narrow component set only,
- correctness over efficiency,
- no attempt at fancy interpolation,
- no attempt to unify with multiplayer transport yet.

The first version can simply:
- spawn display entities for simulation entities that are render-relevant,
- copy a chosen subset of components,
- update those copied components each step,
- remove display entities when the simulation entity disappears.

Suggested initial scope:
- only what is needed to render one active system correctly,
- not every component in the simulation world,
- not every transient or debug-only entity.

Deliverable:
- display rendering is driven from mirrored simulation state rather than directly from the simulation world.

### Step 3: Replace the Naive Copier With a Delta-Based Sync Layer

Once the two-world architecture works, replace the full-copy bridge with a delta-based synchronizer.

Requirements:
- one-way simulation -> display,
- entity create/update/delete,
- component-level inclusion rules,
- room to handle high-frequency transient entities efficiently,
- support for occasional full resync if needed.

This may reuse pieces of the existing delta machinery, but it does not need to share the same inclusion policy as multiplayer sync.

Deliverable:
- the display world is updated via a delta-oriented sync layer instead of full copy.

### Step 4: Separate Input Capture From Simulation Control Application

Even before introducing a worker, make the boundary explicit.

Split input handling into:
- browser event capture in the display/main-thread side,
- normalized control messages,
- simulation-side control application.

This keeps the later worker move small, because the interface already exists.

Deliverable:
- simulation can be driven without directly depending on browser event plugins.

### Step 5: Move the Simulation World Into a Worker

After the two-world architecture and delta sync are already working in one thread:

1. create a worker entrypoint,
2. construct the simulation world there,
3. keep the display world on the main thread,
4. reuse the same sync protocol from Step 3,
5. pipe normalized input/control messages into the worker.

Deliverable:
- the main thread hosts display/UI only, while authoritative simulation runs in a worker.

### Step 6: Add Display-Side Smoothing Only If Needed

Only after the worker version is functionally correct.

If worker updates are visually smooth enough, stop here.

If smoothing is needed:
- make it display-only,
- base it on physics-relevant state where possible,
- never let it become a second authoritative simulation.

Deliverable:
- optional display smoothing layered on top of synchronized state.

## Open Issues To Resolve During Implementation

1. Which components are actually needed to render one active system correctly?
2. Which current display systems assume direct access to live simulation state rather than mirrored state?
3. Whether the existing delta infrastructure can be adapted cleanly for display sync.
4. How to include transient entities such as projectiles efficiently once the narrow copier works.
5. Which UI actions should remain display-only and which must become explicit simulation commands.
6. Whether system transitions/jumps are easiest to model as one long-lived simulation world or a world that owns nested per-system worlds.

## Recommended First Milestone

The first milestone should be deliberately narrow:

1. separate simulation and display into two ECS worlds in one thread,
2. mirror only the minimum component set needed to render one active system,
3. keep the copy one-way from simulation to display,
4. keep everything single-threaded,
5. do not add rollback work yet,
6. do not add fixed-timestep work yet.

If that milestone works, the architecture is probably sound enough to continue with a delta sync layer and then a worker move.
