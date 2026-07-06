# Rollback Multiplayer Plan

This document is the plan for adding rollback netcode (deterministic lockstep with rewind/resimulate) to NovaJS. It replaces the earlier notes version of this file and builds on the completed work in [docs/engine_in_webworker.md](./engine_in_webworker.md).

## The Model

- Every peer in a star system runs the full simulation for that system.
- The only thing exchanged over the network is per-tick player input, plus occasional snapshots for joins and desync recovery.
- Each peer predicts remote inputs (repeat-last-input), and when real inputs arrive for a past tick, it rolls back to a stored snapshot, applies the true inputs, and resimulates to the present.
- The server stops being a simulation authority within a system and becomes an input relay, tick clock, and snapshot archive for late joiners. Because the sim is deterministic, the server *can* still run any room's simulation like any other peer (for NPC authority, validation, or persistence) — but steady-state NPC behavior is computed identically by every peer and needs no owner. (Today all NPCs are simulated by clients.)
- The existing room-per-system infrastructure (`multi_room_communicator.ts`) is reused as-is: rollback state is scoped to one star system's world, which keeps entity counts and snapshot sizes bounded.

## Why the plan has this shape

The original three steps (worker split, determinism, state history) are the right skeleton, but two of them hide most of the work, and the ordering within them matters:

1. **Step 1 (worker split) is structurally done** on the `worker` branch (lingering issues in Phase 0 below) and its shape is right for rollback: input already crosses the bridge as normalized `ControlEvent`s/commands, the sim world is free of PIXI/browser state, and display consumes snapshots. Nothing about the current bridge design blocks rollback.
2. **Step 2 (determinism) is the long pole**, and it is much more than fixed timestep + seeded RNG. The audit below found six categories of nondeterminism, of which async data loading inside the simulation is the most invasive to fix.
3. **Step 3 (state history) should be built and validated entirely locally** — rollback correctness can be tested with zero networking by feeding the sim its own inputs with artificial delay. The network protocol is the *last* thing to build, not part of step 3.
4. A step the original plan was missing: **a determinism verification harness must come first**, not last. Without per-tick state hashing and record/replay tests, desyncs are undebuggable. Every subsequent change gets validated against this harness.

## Determinism audit findings

What must change in the current code, by category:

| Category | Sites | Notes |
|---|---|---|
| Variable timestep | `time_plugin.ts:20-27` | `delta_ms` from wall clock each frame; foundation fix |
| Wall-clock time in gameplay | `stat.ts:160`, `npc_plugin.ts:32` (via `time.time`), `projectile_plugin.ts:196` (fire time) | must become tick-derived logical time |
| `Math.random()` in sim | `fire_weapon_plugin.ts:101,130`, `make_ship.ts:17-19`, `ship_plugin.ts:166-168`, `npc_plugin.ts:45` | ~6 sites; replace with a seeded PRNG resource. Display-world uses of `Math.random` (explosions, beams, animation jitter) are fine and stay. |
| Random entity UUIDs | `projectile_plugin.ts:177,378`, `bay_plugin.ts:118`, `beam_plugin.ts:109` | `v4()` per spawn; replace with deterministic IDs (e.g. `${spawnTick}:${counter}`); counter becomes snapshotted state |
| Async in the sim step path | `ProvideAsync`/`AsyncSystem` uses: `ship_plugin.ts`, `outfit_plugin.ts`, `planet_plugin.ts`, `projectile_plugin.ts:245`, `collisions_plugin.ts:140` (hulls), `fire_weapon_plugin.ts:361` (weapon data), `make_system.ts:22` | **The most invasive item.** Components appear on entities at a tick that depends on cache warmth. All static game data must be resolved *before* an entity enters the sim world (preload at system creation / spawn time), making these providers synchronous. |
| Cross-engine float math | trig throughout movement/weapons | IEEE 754 `+ - * / sqrt` are deterministic everywhere; `Math.sin/cos/atan2/pow` are **not guaranteed identical across JS engines**. Decision: assume latest Chrome for all clients, and periodically broadcast full position/velocity/rotation for ships as a drift backstop. Projectiles are short-lived enough not to matter. |

Things that are already in good shape:

- System execution order is topologically sorted and stable given stable plugin registration order (`world.ts:266`).
- Entity iteration is Map insertion order — deterministic, **but snapshot restore must rebuild the entity map in the recorded order**, or post-rollback iteration diverges from the original timeline.
- The event queue is synchronous FIFO within a step.
- Input already flows as per-tick `ControlStateEvent`s and bridge commands rather than direct mutation.
- `randomAdmin()` in `multiplayer_plugin.ts:173` is network-layer, not sim state; it doesn't need fixing for determinism.

## Phases

### Phase 0: Land the worker branch

Do not abandon `worker` (branched off `turborepo`). The sim/display split's shape is exactly what rollback needs. Finish and commit the in-flight work; rollback work happens on a new branch on top of it.

Known lingering issues to resolve or explicitly defer:

1. Desync when a ship dies.
2. Per-frame sync performance: profiling shows significant cost, much of it serializing/deserializing the full snapshot every frame. This deserves a **timeboxed investigation now** rather than open-ended deferral, because it is a viability gate for the whole project: if sim→display sync can't be made cheap, rollback (which adds snapshot + resim on top) isn't worth building. Likely levers, in order: delta sync instead of full snapshot (already planned in the worker doc), cheaper encoding than io-ts JSON, and only then exotic options like `SharedArrayBuffer`.

### Phase 1: Determinism foundation (single-player, no networking)

1. **Determinism harness first.** Add a per-tick state hash (hash of serialized sim entities + sim resources) and a record/replay test: record inputs, run the sim twice from the same seed, assert identical hash streams. This becomes a CI test and the acceptance gate for every item below. Build pause/single-step/inspect controls into the same harness early — a fixed-timestep sim that can be paused and stepped is also what makes the running game debuggable interactively (including by agents driving the browser), which a free-running realtime game is not.
2. **Fixed timestep.** `TimeResource` becomes `{tick, delta_s: FIXED_DT, time: tick * FIXED_DT}` driven by an injected tick counter, not `new Date()`. The driving side (worker loop or `bridge.step`) owns an accumulator that converts wall time to a number of fixed ticks; render rate and sim rate decouple. Pick the tick rate here (see Open Questions).
3. **Logical time.** Migrate all `time.time` consumers (projectile lifespan, NPC retarget timers, `stat.ts` throttling) to tick-derived time.
4. **Seeded RNG resource.** A serializable PRNG (e.g. xoshiro/sfc32) as a world resource; replace the six sim `Math.random` sites. RNG state is part of the snapshot.
5. **Deterministic entity IDs.** Replace `v4()` at sim spawn sites with a tick+counter scheme; the counter is a snapshotted resource.
6. **Synchronous data access in the sim.** Preload static game data (ship/weapon/outfit/planet data, collision hulls) before entities enter the world — at system-world creation and at spawn-request time. Spawn requests that need unloaded data become two-phase: load (async, outside the sim) then inject (a tick-stamped input). `ProvideAsync` is considered a design mistake and gets removed from the sim path entirely; plain `Provide` should be reviewed too (it re-runs its check every frame), likely in favor of attaching fully-resolved components at entity creation.
7. **Decision checkpoint.** With the harness green (same-machine replay is bit-identical), decide whether cross-browser determinism (trig policy) is handled now or deferred by declaring same-engine-only support initially.

### Phase 2: Snapshot, restore, and local rollback

1. **Full-world snapshot.** A `snapshot()`/`restore()` pair on the sim world covering: all entities with registered components *in insertion order*, sim-state resources (RNG state, tick, ID counters, control state), and nothing display-related. Two candidate representations — benchmark both on a busy system before committing:
   - reuse the io-ts `Serializer` path (already proven by the bridge, but JSON-shaped and likely slow per-tick);
   - a fast path that deep-copies component data structurally (`structuredClone` of plain component data, or Immer-based structural sharing via the existing patch machinery).
2. **Ring buffer of the last N snapshots** keyed by tick, plus an input history buffer keyed by tick. N is derived from max supported rollback (e.g. 20 ticks ≈ 330 ms at 60 Hz).
3. **Rollback driver.** `rollbackTo(tick)` restores the snapshot, then replays stored inputs tick-by-tick to the present. Query caches and pending events must be fully reset by `restore()`.
4. **Local validation, no network.** Two test harnesses:
   - *Delayed-echo test:* feed the player's own inputs with artificial d-tick delay and a repeat-last-input predictor; assert the world converges to the same hash stream as an undelayed run.
   - *Rollback fuzz test:* random inputs, rollbacks at random ticks/depths, assert final hash equals a straight-line simulation of the same inputs.
5. **Performance budget.** Measure snapshot cost and k-tick resim cost on the busiest real system. A frame must fit snapshot + up to N resim ticks + normal tick in the worker's frame budget. If snapshot-per-tick is too slow, fall back to snapshot-every-k-ticks with deeper resim.

### Phase 3: Input-exchange network protocol

1. **Tick-stamped input message.** Everything that today crosses the bridge as a command becomes a `(peerId, tick, inputs)` record: control state deltas, jump route changes, land/depart, spawn requests. This is the complete wire format for steady-state play.
2. **Server as relay + clock + archive.** Reuse the existing socket/room layer. Per room, the server: assigns the canonical start tick, relays each peer's inputs to the others, retains the input log, and keeps a periodic snapshot for joins. It runs no simulation for rollback rooms.
3. **Prediction and delay.** Local inputs are applied at `tick + d` (small configurable input delay); remote inputs are predicted as repeat-last-input; receipt of authoritative remote inputs older than the current tick triggers rollback.
4. **Desync detection and recovery.** Peers attach their state hash for tick `t - N` to outgoing input messages; on mismatch, the affected peer requests a full snapshot resync — the existing multiplayer full-state machinery is repurposed as the recovery path rather than the steady-state path.
5. **NPC and world authority.** NPCs, projectiles, and all sim-derived entities are simulated identically by every peer and have no owner. `MultiplayerData` ownership shrinks to mapping peers to their input streams (which ship each peer controls). Within a rollback room, this *replaces* the delta-based sync of `multiplayer_plugin.ts`.
6. **Join and system transition.** A joining peer receives the latest server snapshot + the input log since that snapshot, simulates forward to the live tick, then participates normally. Hyperspace jumps are a leave/join across rooms.

### Phase 4: Hardening and polish

Only after 3 works end-to-end: input compression/batching, tuning input delay vs. rollback depth, spectators, and replay files (which fall out of the input log for free).

## Decisions

1. **Browser support:** all clients assumed to run latest Google Chrome. No deterministic math layer needed initially; periodic ship state broadcasts (position/velocity/rotation) are the drift backstop.
2. **Tick rate:** target 60 Hz; 30 Hz is the acceptable fallback if the Phase 2 benchmark demands it.
3. **Players per system:** ≤ 8–10 per room.
4. **Fallback:** server-authoritative with client-side prediction is acceptable only if it avoids input-round-trip floatiness — the local ship must be predicted locally, never "send keypress, wait for server to say what happened" (a local preview of the attempted action is fine). Phases 0–1 are prerequisite work for that design too, so nothing is wasted up to the Phase 2 checkpoint.

## Carried-over cleanup notes

- `SerializerResource` no longer cleanly means "things that go over multiplayer" — it also serves sim→display sync and will serve snapshots. Split the policy: one component include-list per consumer (display sync, snapshot/rollback, network join sync), likely with a shared registration core. `ExcludedMultiplayerComponentsResource` is the short-term version of this and should be absorbed into that split.
- Snapshot inclusion policy is a *third* include-list: it must cover strictly more than display sync (all sim-affecting components + resources) but can exclude anything derivable.
