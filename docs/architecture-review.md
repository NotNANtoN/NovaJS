# NovaJS architecture review

Read-only review of the current moving snapshot at `/tmp/NovaJS`.

## Highest-priority findings

### 1. Player-state persistence has several competing schemas
Classification: Quick win leading into a larger consolidation
Effort: M · Refactor risk: Medium

Evidence:
- `player_state.ts:109-192` defines the canonical runtime codec, legacy defaults, and migration.
- `player_store.ts:12-154` independently duplicates the state interfaces and codecs.
- Defaults and cargo migration are repeated at `player_store.ts:164-185` and `player_store.ts:256-299`.
- Deep-copy field lists recur in `player_store.ts:187-253` and `player_store.ts:376-404`.
- `server_plugin.ts:65-93` and `server_plugin.ts:156-175` manually project the same fields again. Its change fingerprint repeats them at `server_plugin.ts:105-129`.
- Three separate local `PlayerStoreApi` interfaces exist in `server_plugin.ts:36-53`, `mission_ship_plugin.ts:67-69`, and `spaceport_plugin.ts:56-63`.
- Loaded snapshots accept `state: unknown` and cast it at `player_store.ts:216-230`, bypassing `PlayerStateCodec`.
- Snapshot `ship` is omitted by normalization at `player_store.ts:225-230`, even though restore later expects it at `player_store.ts:459-464`. Ship snapshots therefore do not survive process restart.

Why it matters:
Every new player field must currently be added to numerous interfaces, codecs, defaults, clone functions, persistence projections, and fingerprints. Missing one silently loses progress or prevents autosaving. Snapshot restoration can replace the current stored pilot with data never validated by the canonical codec.

Proposed consolidation:

```typescript
export const PersistentPlayerStateCodec = /* one canonical persisted shape */;
export type PersistentPlayerState =
    t.TypeOf<typeof PersistentPlayerStateCodec>;

export function toPersistentPlayerState(state: PlayerState): PersistentPlayerState;
export function decodePlayerState(raw: unknown): Either<Errors, PlayerState>;
export function clonePlayerState(state: PersistentPlayerState): PersistentPlayerState;

export interface PlayerStorePort {
    getOrCreate(token: string): Promise<PersistentPlayerState>;
    save(token: string, state: PersistentPlayerState): Promise<void>;
    snapshot(token: string, state: PersistentPlayerState): Promise<PlayerSnapshot>;
    getTokenForPeer(peer: string): string | undefined;
}
```

Keep this contract in a browser-safe module; let the Node store implement it. Derive fingerprints from the encoded persistent shape rather than another field list.

---

### 2. Plugin teardown is optional and leaks whole worlds
Classification: Larger refactor
Effort: L · Refactor risk: Medium

Evidence:
- `World.removePlugin` does nothing when a plugin lacks `remove`, leaving it registered: `nova_ecs/world.ts:165-185`.
- `SystemPlugin` installs 29 plugins but has no teardown: `system_plugin.ts:34-66`.
- On jump, the browser deletes entities and removes only `Display`, not the remaining world plugins: `browser.ts:138-159`.
- Multiplayer subscribes to communicator messages without retaining or unsubscribing the subscription: `multiplayer_plugin.ts:498-500`. The subscription captures the old world.
- Several plugins, including `CollisionsPlugin`, have no `remove` implementation.

Why it matters:
Old worlds can remain reachable after jumps, continue receiving communication, and retain systems, resources, caches, and GPU objects. This makes lifecycle bugs dependent on jump count and event timing.

Proposed abstraction:

```typescript
interface PluginScope {
    addSystem(system: System): void;
    setResource<T>(resource: Resource<T>, value: T): void;
    subscribe(subscription: Subscription): void;
    onDispose(cleanup: () => void | Promise<void>): void;
}

interface Plugin {
    name: string;
    build(world: World, scope: PluginScope): void | Promise<void>;
}
```

`World` should always dispose the scope, even if a plugin has no custom teardown. As an interim fix, `leaveGameWorld()` should dispose all non-base plugins and multiplayer subscriptions.

---

### 3. Authority is represented by string checks, not component policy
Classification: Larger refactor
Effort: L · Refactor risk: High

Evidence:
- The fix for server-overwritten movement is a private string set containing `"MovementState"`: `multiplayer_plugin.ts:130-169`.
- Filtering is applied only when an admin updates an entity owned by the local client: `multiplayer_plugin.ts:297-305` and `multiplayer_plugin.ts:352-359`.
- General delta tracking remains entity-owner based: `multiplayer_plugin.ts:416-437`.
- NPC systems repeat mixed platform/owner predicates throughout `npc_plugin.ts:110-114`, `163-193`, `237-263`.
- Projectile ownership is recursively inferred ad hoc at `projectile_plugin.ts:36-59`.
- `MissionRuntime` explicitly notes that untrusted client state remains authoritative: `mission_plugin.ts:423-425`.

Why it matters:
Adding another predicted or server-owned component requires knowing about a hidden string list and every relevant send/receive path. Full-state replacement and delta paths can drift. The current model also permits client-owned ships to submit arbitrary serialized `PlayerState`.

Proposed policy:

```typescript
type ComponentAuthority =
    | "entity-owner"
    | "server"
    | "owning-client"
    | "local-only";

interface ReplicationPolicy<T> {
    codec: t.Type<T>;
    authority: ComponentAuthority;
    merge?: (local: T, remote: T) => T;
}

replication.register(MovementStateComponent, {
    codec: MovementState,
    authority: "owning-client",
});
```

Apply the policy symmetrically to full states, deltas, removals, and outbound tracking. Migrate PlayerState to server authority separately; doing that immediately would require moving spaceport and mission mutations server-side.

---

### 4. NCB runtime effects are duplicated and already semantically divergent
Classification: Consolidation
Effort: M · Refactor risk: Medium

Evidence:
- Three separate ECS adapters implement ship changes, movement, sound, and outfit effects:
  - `mission_bbs.ts:248-294`
  - `mission_plugin.ts:679-717`
  - `spaceport_plugin.ts:103-137`
- The BBS adapter only reloads `ShipDataComponent` when `includeDefaults` is true: `mission_bbs.ts:269-292`. A `C` operation can therefore change `ShipComponent` while retaining old ship data.
- The landing adapter ignores `resetNonPersistent`: `spaceport_plugin.ts:106-131`.
- The expiration adapter handles both cases differently: `mission_plugin.ts:686-708`.
- `NcbTestContext` supports gender, outfits, exploration, and registration at `ncb.ts:12-19`, but mission and purchase availability pass only mission bits at `mission_availability.ts:171-177` and `availability.ts:24-39`. Other supported operands consequently evaluate false at those call sites.

Why it matters:
NCB operations affect ships, inventory, missions, movement, and story progress. Context drift can produce stale ship physics, duplicated/default outfits, or unavailable content depending on which lifecycle event executed the expression.

Proposed abstraction:

```typescript
interface NcbRuntime {
    testContext(state: PlayerState, outfits?: OutfitsState): NcbTestContext;
    setContext(entity: Entity, state: PlayerState): MissionSetContext;
    apply(expression: string | undefined, entity: Entity, state: PlayerState): void;
}
```

One adapter should own ship replacement, default outfits, reset semantics, pending jumps, and sound emission. Availability should consume the same player-derived test context.

---

### 5. The modern test path is not dependable
Classification: Quick win
Effort: S–M · Refactor risk: Low

Evidence:
- Root scripts expose build, dev, typecheck, and start, but no test command: `package.json:56-60`.
- No Jasmine configuration or CI workflow exists in this snapshot.
- Fifteen `*_test.ts` files duplicate a hard dependency on `BAZEL_NODE_RUNFILES_HELPER`, despite the README saying Bazel is removed. Examples: `DescResource_test.ts:6-18`, `NovaParse_test.ts:21-22`, `resource_fork_test.ts:4`.
- The exact display deletion race is disabled, while the active display test is a placeholder: `display_plugin_test.ts:27-69`.
- No collision, projectile, or beam test files exist.
- Weapon timing has only three cadence/blockage tests: `weapon_plugin_test.ts:45-145`; burst reload, simultaneous fire, point defense, zero reload, and large-delta behavior are uncovered.
- Multiplayer has a useful regression test for the MovementState bug at `multiplayer_plugin_test.ts:178-228`, but no explicit full-state resync equivalent.
- Player persistence has one snapshot rotation test: `player_store_test.ts:32-60`.

Proposed harness:

```typescript
export function fixturePath(relative: string): string {
    return fileURLToPath(new URL(relative, import.meta.url));
}
```

Add one documented root test command, replace the 15 Bazel runfile shims, then enable focused tests for display deletion, full-state authority, collision broad/narrow phases, and weapon burst timing.

## Additional findings

### 6. PIXI ownership and destruction are inconsistent
Classification: Consolidation
Effort: M · Refactor risk: Medium

Evidence:
- Animation graphics uniquely contain destroyed guards and explicit destruction: `animation_graphic_plugin.ts:55-103`.
- An async graphic created after entity deletion has no disposal callback in `ProvideAsync`: `provide_async.ts:60-83`, `96-103`.
- Particle plugin removal deletes resources but neither removes nor destroys its particle container, texture, or orphan emitters: `particles_plugin.ts:220-231`.
- Beam, target corners, planet corners, starmap, and starfield detach objects without destroying them.
- Convex-hull cleanup removes graphics but does not destroy them: `convex_hull_display_plugin.ts:29-58`, `146-160`.
- `Display.remove` detaches `Space` without destroying the stage hierarchy: `display_plugin.ts:95-123`.

Proposed composition-based handle:

```typescript
interface ManagedGraphic {
    readonly root: PIXI.DisplayObject;
    readonly disposed: boolean;
    dispose(): void;
}

function attachGraphic(
    parent: PIXI.Container,
    root: PIXI.DisplayObject,
): ManagedGraphic;
```

Avoid a class hierarchy inside ECS data. A handle plus a generic delete/plugin-cleanup system fits Immer and ECS composition better.

---

### 7. NPC spawning repeats selection and construction policy
Classification: Consolidation
Effort: M · Refactor risk: Medium

Evidence:
- Weighted selection is independently implemented in `npc_spawn_plugin.ts:22-54` and `mission_ship_plugin.ts:94-111`; only one supports injected randomness.
- Both paths load ship data, call `makeNpc`, reserve budget, set government, mark server ownership, and insert a UUID: `npc_spawn_plugin.ts:143-165`, `mission_ship_plugin.ts:249-287`.
- Mission spawning adds critical-budget and mission behavior semantics locally.

Proposed factory:

```typescript
interface NpcSpawnSpec {
    ships: readonly WeightedShip[];
    government: number;
    critical?: boolean;
    decorate?: (entity: Entity) => void;
}

async function spawnNpc(
    context: SpawnContext,
    spec: NpcSpawnSpec,
): Promise<string | undefined>;
```

Keep ambient population cadence and mission lifecycle separate, but centralize weighted choice, authority, budget accounting, construction, and failure cleanup.

---

### 8. Small wave-local utilities are repeatedly reinvented
Classification: Quick win
Effort: S · Refactor risk: Low

Evidence:
- Resource-ID equality is duplicated in `player_state.ts:294-300`, `mission_ship_plugin.ts:79-82`, `mission_bbs.ts:175-176`, `mission_plugin.ts:346-355`, and `procedural_missions.ts:44-49`, despite an exported implementation in `stellar_selector.ts:91-100`.
- Random normalization is repeated in `ncb.ts:487-488`, `mission_availability.ts:27-31`, `procedural_missions.ts:52-56`, and `stellar_selector.ts:115-119`.
- Target and planet corner draw systems are nearly identical: `target_corners_plugin.ts:102-126` and `planet_corners_plugin.ts:17-41`.

Extract `resource_id.ts`, `random.ts`, and a configurable corner-target plugin. These are low-risk reductions in future wave drift.

---

### 9. Spaceport availability is centralized, but catalog UI is duplicated
Classification: Optional consolidation
Effort: M · Refactor risk: Low–Medium

The suspected availability duplication is mostly not present: `isPurchaseAvailable` and `hasSpaceportService` are centralized and used consistently. Rechecking availability on purchase is desirable.

Actual duplication:
- Shipyard grid load/refresh/control wiring: `shipyard.ts:108-143`.
- Outfitter equivalent: `outfitter.ts:144-181`.
- Both detach old containers without destruction.
- Shipyard imports visual constants from Outfitter: `shipyard.ts:18`, creating sibling-feature coupling.

Proposed seam:

```typescript
interface CatalogSource<T> {
    load(): Promise<T[]>;
    available(item: T): boolean;
    sort(a: T, b: T): number;
}

class PurchasableCatalog<T> {
    refresh(source: CatalogSource<T>): Promise<void>;
    dispose(): void;
}
```

Extract shared styles separately. Do not eliminate the final purchase-time availability check.

---

### 10. Timer helpers would help deadlines, but weapon timing should remain specialized
Classification: Quick abstraction
Effort: S–M · Refactor risk: Medium

Evidence:
- Respawn and explosion deadlines: `death_plugin.ts:94-121`, `176-205`.
- NPC spawn and wander deadlines: `npc_spawn_plugin.ts:235-244`, `npc_plugin.ts:244-247`.
- Mission activation deadline: `mission_ship_plugin.ts:269-313`.
- Provocation expiry: `npc_hostility.ts:94-101`, `148-171`.
- Periodic secondary explosions use optional `lastTime` sentinels: `explosion_plugin.ts:57-101`.
- Weapon reload is a rate accumulator with backlog limits, not merely a deadline: `weapon_plugin.ts:39-155`.

Use plain draftable data rather than timer classes:

```typescript
interface Deadline { dueAt: number }

function after(now: number, durationMs: number): Deadline;
function isDue(timer: Deadline, now: number): boolean;
function consumePeriods(now: number, nextAt: number, periodMs: number, cap: number): number;
```

Do not force weapon `shotsOwed` into the same abstraction; its accumulated-rate semantics are materially different.

---

### 11. Transport and settings loading lack one typed boundary
Classification: Quick win
Effort: S–M · Refactor risk: Low

Evidence:
- Player state, snapshot list, and restore each implement fetch/error/token handling in `browser.ts:106-118`, `311-353`.
- Snapshot summaries manually duplicate validation despite `PlayerSnapshotSummary` already existing: `player_state.ts:206-211`, `browser.ts:318-330`.
- Stable player tokens are sent in GET query strings: `browser.ts:108-109`, `313-314`; restore uses a JSON body.
- `GameData` performs unchecked raw JSON fetches for preload and IDs: `GameData.ts:93-103`, `204-210`.
- Settings return `unknown`; compatibility has a fallback, while controls fail startup: `browser.ts:91-104`, `controls_plugin.ts:57-65`.

Proposed boundary:

```typescript
interface JsonClient {
    get<T>(url: string, codec: t.Type<T>, fallback?: T): Promise<T>;
    post<T>(url: string, body: unknown, codec: t.Type<T>): Promise<T>;
}

interface PlayerApi {
    load(): Promise<PlayerData | undefined>;
    snapshots(): Promise<PlayerSnapshotSummary[]>;
    restore(id: string): Promise<PlayerData | undefined>;
}
```

`StartMenu` itself is already correctly decoupled through `RestoreSnapshot` at `start_menu.ts:13-15` and does not duplicate fetch logic.

---

### 12. Structural residue and boundary exceptions should be cleaned up
Classification: Mostly quick wins
Effort: S–L depending on item · Refactor risk: Low–Medium

- Clean lower-level boundaries were verified: `nova_ecs` does not import gameplay, `novadatainterface` does not import parser/game code, and `novaparse` does not import gameplay.
- Confirmed circular dependency: `npc_plugin.ts:27-33` imports `npc_hostility`, while `npc_hostility.ts:21` imports `GovtComponent` from `npc_plugin`. Move shared NPC/government components into a leaf module. Effort S, low risk.
- `display/explosion_plugin.ts` contains simulation systems and imports parser internals at line 23. Move explosion entity simulation into gameplay and put frame conversion in a shared units module. Effort M, medium risk.
- `status_bar.ts:413-423` lets presentation spawn client-owned NPCs. Move this debug action behind an explicit debug plugin/command boundary. Effort S.
- Large modules have viable seams:
  - `mission_bbs.ts` — 857 lines
  - `mission_plugin.ts` — 753 lines
  - `stellar_selector.ts` — 638 lines
  - `collisions_plugin.ts` — 572 lines
  - `player_store.ts` — 518 lines
  - `multiplayer_plugin.ts` — 507 lines
  Split by domain/runtime/ECS bridge or protocol/policy/apply phases, not simply by line count.
- README claims Bazel/Yarn removal, but `nova_ecs/yarn.lock`, `push_webtesting_image.yaml`, server runfile compatibility, `tsconfig.json:2-4`, and 15 test shims remain. Karma/RequireJS dependencies also have no configuration or imports. Remove only after confirming no publishing workflow relies on them.
- Naming drift includes `OutiftData.ts`, `ShipSecondaryExposionSystem`, mixed plugin names, and mixed quote conventions. Fix internal typos opportunistically; renaming the public `OutiftData` path has broader compatibility risk.

## Top five actions by bug-prevention value / effort

1. Make `PlayerStateCodec` the sole persistence schema; validate snapshot state and preserve snapshot ship data.
2. Introduce one NCB runtime adapter for test context and ECS side effects.
3. Add managed PIXI handles and re-enable the async deletion/display regression test.
4. Establish a typed component-authority registry, initially covering MovementState and full-state resync.
5. Add a root modern test command, replace the 15 Bazel runfile shims, and cover collision, burst timing, and lifecycle teardown.

**Evaluating test harness risks**

I'm wondering if the test harness is showing the highest ratio, but it doesn't necessarily prevent runtime issues as effectively. I need to assess the risks associated with each finding. Instead of using a markdown table, I’ll format my notes in code blocks using TypeScript. I’ll make sure to reference the relevant parts of the `package.json` file, specifically lines 56-60, and ensure each finding includes sections on the finding itself, evidence, reasoning, proposed abstraction, effort, and risk.
