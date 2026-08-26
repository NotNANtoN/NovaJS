# NovaJS engine overview

A map of how this engine actually works, drawn from the code as of
2026-08-25. It is meant to be read top to bottom: packages, then the data
pipeline, then the runtime, then the individual subsystems that most often
need debugging.

Companion documents:

- `docs/roadmap.md` — canonical work order and completion status.
- `docs/maturity.md` — what is solid, what is thin, what does not exist.
- `docs/architecture-review.md` — maintainability findings.
- `docs/engine-improvements.md` — research on retail engine limitations.

## 1. Packages

```mermaid
graph TD
    subgraph Data
        NF["Nova Files<br/>(.ndat / .rez resource forks)"]
        NP["novaparse<br/>resource_parsers + parsers"]
        NDI["novadatainterface<br/>shared data types"]
    end
    subgraph Engine
        ECS["nova_ecs<br/>world, systems, plugins,<br/>delta + multiplayer"]
        WASM["nova_wasm (Rust)<br/>convex hull, SAT batch"]
    end
    subgraph Game
        SRV["nova/server.ts<br/>+ nova/src/server"]
        SIM["nova/src/nova_plugin<br/>simulation rules"]
        UI["nova/src/display<br/>+ nova/src/spaceport<br/>+ nova/src/client"]
    end

    NF --> NP --> NDI
    NDI --> SRV
    NDI --> UI
    ECS --> SIM
    ECS --> SRV
    ECS --> UI
    SIM --> SRV
    SIM --> UI
    WASM --> NP
    WASM --> SIM
```

`novaparse` never runs in the browser. It runs once in a worker thread on
the server, and the browser sees only its JSON/PNG/MP3 output.

## 2. Data pipeline

Retail resources are converted on the server and served as ordinary web
assets, so the client needs no knowledge of resource forks.

```mermaid
flowchart LR
    A["Nova Files/<br/>Plug-ins/"] --> B["nova_parse_worker<br/>(worker_threads)"]
    B --> C["GameDataAggregator<br/>+ FilesystemData"]
    C --> D["setupRoutes<br/>/gameData/..."]
    D -->|JSON, gzip,<br/>?schema=2| E["client GameData<br/>Gettable + PQueue"]
    D -->|PNG / MP3,<br/>immutable cache| E
    E --> F["Pixi textures,<br/>spritesheets, sounds"]

    B -.->|"convexHullRgba"| W["nova_wasm"]
```

Two details that have caused real bugs:

- JSON metadata is served revalidating and versioned with `?schema=2`;
  binary assets stay immutable. An older scheme cached stale planet JSON for
  a year and broke landing.
- Sprite frames come from one atlas texture per spritesheet, sliced into
  sub-textures, rather than one HTTP request per frame.

## 3. Runtime topology

```mermaid
graph TB
    subgraph Server ["Node/Bun process"]
        HTTP["Express + HTTP"]
        WS["SocketChannelServer<br/>(WebSocket)"]
        MR["MultiRoom<br/>(one room per system)"]
        RW["root World<br/>StepSystemSystem"]
        SW1["system World: nova:128"]
        SW2["system World: nova:129"]
        PS["PlayerStore<br/>(players.json, CAS)"]
        MS["mutation sessions<br/>(token-bound)"]
    end
    subgraph Browser
        BW["browser World<br/>(active system only)"]
        DISP["Display plugin (Pixi)"]
        MENU["start menu / spaceport"]
    end

    HTTP --> MENU
    WS <--> MR
    MR --> SW1
    MR --> SW2
    RW --> SW1
    RW --> SW2
    MS --> PS
    WS <--> BW
    BW --> DISP
    MENU --> BW
```

The root world holds one entity per star system, each carrying a
`SystemComponent` whose value is a nested `World`. Stepping the root world
steps every system world. The browser only ever instantiates the world for
the system the player is in.

## 4. One simulation step

The server runs a fixed 60 Hz timestep with bounded catch-up; the browser
steps on Pixi's ticker with wall-clock deltas clamped to 100 ms so a UI
stall cannot teleport the ship.

```mermaid
sequenceDiagram
    participant Loop as server loop (60 Hz)
    participant World as World.step()
    participant Q as event queue
    participant Sys as systems (topologically sorted)
    participant Delta as DeltaMaker
    participant Net as multiplayer plugin

    Loop->>World: step()
    World->>Q: push StepEvent
    loop until queue drains
        Q->>Sys: run systems subscribed to event
        Sys->>Q: may emit further events
    end
    World->>Delta: collect dirty components
    Delta->>Net: deltas for changed entities only
    Net-->>Loop: send per-peer messages
```

Notes that matter when adding a system:

- Systems declare `args` and `after`/`before`; `topologicalSortList` orders
  them once per `addSystem`, using a DFS sort with cycle diagnostics.
- Events added while flushing are processed in the same step, which is how
  damage, death, and spawn cascades resolve without a frame of latency.
- `DeltaMaker` tracks Immer drafts for objects and compares JSON-safe
  primitives by identity, so a replicated `boolean` component does not
  crash on `createDraft`.

## 5. Replication and authority

Two distinct mechanisms exist, and confusing them is the single most common
source of movement bugs.

```mermaid
graph LR
    subgraph "Component replication (per frame)"
        A["owner writes component"] --> B["DeltaMaker marks dirty"]
        B --> C["authority registry:<br/>may this peer send/apply?"]
        C --> D["peers apply delta"]
    end
    subgraph "Player mutations (per intent)"
        E["client intent<br/>(buy, accept, take off)"] --> F["revisioned session<br/>+ CAS on token"]
        F --> G["server validates<br/>and authors result"]
        G --> H["new revision to client"]
    end
```

Movement specifically:

```mermaid
sequenceDiagram
    participant K as keyboard
    participant C as owning client
    participant S as server
    participant O as observing client

    K->>C: control state
    C->>C: integrate own MovementState
    C->>S: MovementState + sequence
    S->>S: restamp to server clock,<br/>reject stale sequences
    S->>O: authoritative snapshot (~10 Hz)
    O->>O: interpolate over 200 ms buffer
    Note over C: ignores admin-authored<br/>MovementState for its own ship
```

The owning client is authoritative over its own ship's motion; the server
relays and validates it (a movement envelope shadow gates landing). Remote
ships are *not* simulated locally — they are interpolated, which is why
`RemoteMovementPresentationComponent` must be cleared when ownership moves.

## 6. Player session and strict mutation authority

```mermaid
stateDiagram-v2
    [*] --> Menu
    Menu --> Negotiating: New / Open Pilot
    Negotiating --> Strict: server acknowledges<br/>strict authority
    Negotiating --> Failed: capability missing
    Strict --> Bound: token bound to entity id
    Bound --> Flying
    Flying --> Docked: land (server validates)
    Docked --> Flying: takeOff
    Flying --> PendingDeath: armor 0
    PendingDeath --> Flying: server-completed respawn
    Bound --> [*]: disconnect flushes save
```

Every mutation is an intent, queued per token, serialized, applied against
a monotonic revision with compare-and-swap, and persisted as a complete
save unit (pilot state plus ship). Malformed or future-versioned records are
preserved rather than overwritten, and quarantined ship data is replaced by
a materialized default ship rather than making the pilot unplayable.

## 7. Combat pipeline

```mermaid
flowchart TD
    F["fire_weapon_plugin<br/>accumulator per weapon copy"] --> P["projectile / beam spawn"]
    P --> BP["broad phase: RBush,<br/>incremental insert/remove"]
    BP --> NP["narrow phase: SAT<br/>(Rust satBatch when >= 4 pairs)"]
    NP --> H["health_plugin<br/>shield / armor / ionization"]
    H --> D["death_plugin<br/>DestructionStartedComponent"]
    D --> X["explosion_plugin<br/>30 Hz frame cadence"]
    H --> HOS["npc_hostility<br/>ThreatReport, roles"]
    HOS --> AI["npc_plugin goals"]
```

Behaviors worth remembering:

- Weapon fire uses a shots-owed accumulator, so multiple copies of a weapon
  fire proportionally (the retail "1=X" bug is fixed) and transient
  blockage does not permanently jam a weapon.
- Hull polygons are generated at parse time in Rust and normalized by signed
  area, so a mirrored hull cannot produce a one-sided hitbox.
- Hostility is role-aware: the direct victim always retaliates, only
  military units propagate verified `ThreatReport`s, splash damage never
  starts a cascade, and reports survive the victim's death but expire after
  60 s.

## 8. Landing and spaceport

```mermaid
stateDiagram-v2
    [*] --> Flying
    Flying --> Landing: land control,<br/>eligibility from replicated flags
    Landing --> Spaceport: server confirms dock
    Spaceport --> Shipyard
    Spaceport --> Outfitter
    Spaceport --> TradeCenter
    Spaceport --> Bar
    Spaceport --> MissionBBS
    Shipyard --> Spaceport
    Outfitter --> Spaceport
    TradeCenter --> Spaceport
    Bar --> Spaceport
    MissionBBS --> Spaceport
    Spaceport --> Flying: Leave / takeOff mutation
```

Service buttons are derived from `spöb` flags (`0x02` commodity, `0x04`
outfitter, `0x08` shipyard, `0x40` bar); the mission computer has no flag
and is offered everywhere. Dialog geometry is taken from the opaque slots
measured in each retail PICT — see `spaceport_layout.ts` and
`mission_bbs_layout.ts`.

## 9. Mission lifecycle

```mermaid
stateDiagram-v2
    [*] --> Offered: availability NCB + tech +<br/>AvailLoc (BBS / bar)
    Offered --> Active: accept (server-issued token)
    Offered --> [*]: refuse
    Active --> Succeeded: goals met at destination
    Active --> Failed: deadline or goal failure
    Active --> [*]: abort (if canAbort)
    Succeeded --> [*]: rewards + NCB set
    Failed --> [*]: failure NCB
```

Mission text passes through the retail substitution layer: `{bNNN "a" "b"}`
conditionals first, then the angle tokens (`<DST>`, `<DSY>`, `<CT>`,
`<PAY>`, `<PRK>` and the rest). `<SN>` is intentionally empty in initial
briefings, matching retail.

## 10. Asteroids and mining

Belts are server-authoritative like NPC population. `röid` resources supply
strength, prevalence, yield and fragment types; artwork is assigned by
position (`spïn 800 + index` for the rock, `spïn 501 + family` for the ore),
because the resource itself carries no graphic reference.

```mermaid
flowchart TD
    D["sÿst asteroid density (0-10)"] --> S[AsteroidSpawnPlugin]
    R["röid prevalence weights"] --> S
    S --> A["asteroid entity<br/>armor = strength, drifting, tumbling"]
    A -->|"weapon hits, armour to 0"| B[AsteroidDestroyedSystem]
    B --> F["fragment asteroids<br/>(röid fragment types)"]
    B --> O["ore chunks<br/>(yield split into tons)"]
    O -->|"ship within pickup radius"| H["allocateCargo into holds"]
    A -->|"nothing hostile nearby"| M[MinerTargetAI]
    M --> W["existing follow + shoot AI<br/>works the rock"]
```

Tumbling is applied to the entity's rotation rather than a separate frame
counter, so the drawn sprite frame and the collision hull for that frame stay
in step for free. Mining behaviour is ordered after the combat target
selection, so a provoked miner always abandons the rock and fights back.

## 11. Where to look when something breaks

| Symptom | First file to open |
| --- | --- |
| Ship stutters or snaps back | `nova_ecs/plugins/multiplayer_plugin.ts` |
| Frame time collapses | the system list in `system_plugin.ts`, then `collisions_plugin.ts` |
| Input lost after alt-tab | `nova_ecs/plugins/keyboard_plugin.ts` |
| Save lost or pilot unplayable | `nova/src/server/player_store.ts` |
| "Not available" on a legal action | `nova/src/nova_plugin/server_plugin.ts` sessions |
| Dialog text on top of metal | the layout module for that dialog |
| Missing art or stale data | `setupRoutes.ts` cache headers, `GameData.ts` |
