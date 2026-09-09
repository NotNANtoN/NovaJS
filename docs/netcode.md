# Remote flight and combat

## Current authority model

- The owning browser controls its ship movement and predicts firing immediately.
- The server schedules accepted player fire, enforces firing cadence/resource costs,
  and controls NPCs, damage, health, and death. An observer does not run another
  player's weapon cadence.
- Ships carry bounded `FireIntentComponent` and server-owned `FireLogComponent`
  buffers. Projectiles are reconstructed from events, not continuously replicated
  as entities. Seeds, muzzle positions, rotation, inherited velocity, targets, and
  emission timestamps describe an accepted shot.
- The firing browser reconciles **live** predictions with confirmations in place.
  It does not reserve another entity, replay the firing sound, or resurrect a
  projectile already removed by local collision/lifespan handling.
- `seq` identifies client shots; `logSeq` preserves server emission order when
  different weapons have different scheduling delays. Consumers deduplicate logs.
- Only newly appended shots are sent in deltas. The WebSocket supplies ordered,
  reliable delivery while connected; these deltas are not a loss-recovery protocol
  for an unreliable transport.

## Low-latency timing

- Moving ships publish periodic snapshots at **30 Hz** (one every 33.3 ms).
  Control changes are still sent immediately; idle ships do not send unchanged
  poses, and a final stop is sent even with zero velocity.
- A room uses a **50 ms starting buffer**, targeting **33.3 ms** on stable links.
  Recent packet jitter/age can increase it up to 200 ms. Bounded 100 ms prediction
  bridges missing snapshots; presentation cursors never run backward. Small pose
  corrections decay smoothly rather than snapping the hull to each update.
- Four-timestamp probes estimate clock offset and RTT. Only replies to outstanding
  probes are accepted. Low-RTT samples also estimate simulation clock rate, because
  a fixed-step server under load can run slower than wall time. Old peers fall
  back to arrival-based mapping until probes succeed.
- Snapshot histories retain source timestamps and share the refined clock. The
  server preserves the owner's capture age when relaying a pose, rather than
  stamping an old client pose as if it were freshly simulated.
- Accepted fire replay uses the same room presentation cursor as remote ships.
  Replayed projectiles, beams, and submunitions advance/expire on source simulation
  time, including when that clock slows down. Local trigger prediction remains
  immediate. Firing/reconciliation occurs after movement so replay is not advanced
  an extra frame on creation.
- Missile guidance retains its existing **200 ms gameplay history** separately
  from visual buffering. A client's adaptive buffer must not retune weapons.
  Guidance history is retained independently of the shorter visual history.
- Timing estimates reset on disconnect. Loading/menu pauses reset the presentation
  cursor and its transient jitter history without discarding clock synchronization.

`window.novaNetworkStats()` reports synchronization, RTT, offset, source clock rate,
current/target buffer, jitter, and the number of extrapolated remote entities.
A source clock rate near 1 means the server simulation is keeping up with wall time.

### Keeping the server tick responsive

CPU profiling of the two-browser duel exposed full pilot-record validation and
JSON cloning in every combat capture (including multiple times per firing attempt).
Hot captures now update only scalar combat context; explicit boundary captures
still make detached full snapshots. Flight persistence coalesces snapshots at
250 ms intervals and tracks immutable state identities, so changes already consumed
by replication still reach the store. Disconnect saves remain immediate; combat
resource debits retain their existing persistence and revision protection.

## Loading and presentation

Before publishing the player into a system, the browser awaits flight artwork,
weapon factories, collision polygons, and texture preparation. The warmup covers
planets, ship/weapon/explosion records, asteroid and ore artwork, and combat audio.
Atlas downloads and audio warmup each have eight concurrent workers. Missing
optional retail references/audio remain best-effort; a failed atlas reports an
error and can be retried instead of permanently caching missing frames.

The cockpit is revealed only after receiving server state and finishing the
player, planet, and already-present ship/asteroid graphics. Navigation landmarks
are always relevant, so distance filtering cannot remove required planets. An
attached graphic is not necessarily built; cached projectile graphics are built
synchronously. The loading loop keeps pumping even while unrelated async world
work is pending. Initial entry, jumps, and respawn relocation use the same
readiness path; failures offer a return to the menu.

WebSocket messages queued during connection are flushed on `open`, rather than
waiting for another message or the keepalive timer. Explicit disconnection clears
the timer; malformed JSON is reported without throwing an unhandled exception.

## What is tested

- `nova/src/nova_plugin/remote_combat_test.ts`: real projectile replay after 100 ms
  delivery age, two observer clock offsets, shooter reconciliation, stable identity
  and budget, no duplicate muzzle sound, beam corrections, source destruction,
  unguided bullets remaining unguided even with a selected target, shared ship/shot
  presentation time, and replay lifetimes on a slower server clock. This uses
  JSON/codec round trips between ECS worlds, not a live WAN connection.
- `fire_sync_test.ts` and `weapon_plugin_test.ts`: intent/log ordering, duplicate
  suppression, clock mapping, rate limits, cost authority, and bounded waiting for
  cold server weapon factories.
- `nova_ecs/plugins/multiplayer_plugin_test.ts`: movement replication with simulated
  delay/jitter/reordering, authority, and interest management.
- `network_timing_test.ts`: RTT/offset/rate estimates, malformed/stale replies,
  stable-link delay, jitter adaptation/recovery, and clock resets.
- Combat-resource and persistence tests verify the hot path avoids whole-pilot
  validation and coalescing does not lose replicated progress or disconnect saves.
- Collision and death tests cover swept hits and server-owned health updates.
- Display tests cover actual graphic readiness, load failures/retries, atlas
  request deduplication, legacy frame loading, and disposal during async loading.
- `scripts/probe_pvp.mjs` is the live two-browser PvP probe. Run it against an
  isolated server/player store, not real pilots. Passing unit tests is not proof
  that this browser probe or a remote WAN play session passed.

## Validation on 2026-09-09

The isolated two-Chrome-profile probe passed against the locally built Node server:
ship visibility, drawn projectiles on both clients, matching damage, and death
observed on both clients. The test uses a stationary target within starting-weapon
range and a separate player store. It does not measure WAN latency or real GPU
frame times (headless Chrome uses software rendering). The probe also passes with
25 ms one-way delay and ±10 ms jitter injected into real WebSocket frames by
`scripts/lag_proxy.mjs`; that proxy preserves FIFO order and does not slow HTTP assets.
Software-rendered browser stalls can still drive the adaptive buffer above 50 ms.

```sh
NOVA_PORT=8217 NOVA_PLAYER_DATA=/path/to/isolated/players.json \
  node scripts/probe_pvp.mjs --serve --url http://localhost:8217 \
    --latency-ms 25 --jitter-ms 10
```

Add `--profile-server` to write Node CPU profiles into `dist/remote-combat-probe`.

Deterministic owner → server → observer tests (60 Hz simulation, two moving entities):

| Network delay per hop | Settled buffer | 95th-percentile pose age | Steering observed remotely | ECS egress to observer |
| --- | ---: | ---: | ---: | ---: |
| Stable 25 ms | 33.3 ms | 33.7 ms | 50.0 ms | ~14.3 kB/s |
| 35–65 ms jitter | 50.0 ms | ~52 ms | 83.3 ms | ~16.1 kB/s |

Pose age is position error divided by the test ship's constant speed, not a ping
measurement. Steering latency measures an actual input edge; local steering is
asserted on the same simulation step. Egress counts ECS JSON for that small test,
not all HTTP/TLS traffic or a populated production system. These numbers are not
a guarantee of 50 ms end-to-end latency on arbitrary hardware/connections.

The probe now clicks **Enter Ship**, writes to the actual ECS component map rather
than its read-only-by-convention debug name-map copy, checks rendered projectiles
rather than instantaneous counts of already-expired shots, and cleans up both
browser processes if startup fails.

## Remaining limits and risks

1. **Not zero latency.** Transit, frame scheduling, asymmetric routes, and server
   overload still impose limits. The adaptive buffer may exceed 50 ms on bad links
   or slow devices; RTT-based synchronization cannot determine exact one-way delay.
2. **Not identical visual impacts.** Although ships and accepted shots now use a
   common presentation cursor, clients independently remove projectiles on visual
   collisions. Guided trajectories depend on each client's available target
   history and stepping; collision-triggered submunitions can still differ visually.
   Server health is authoritative, but exact impact agreement requires additional
   authoritative impact/guidance synchronization and latency tests.
3. **Prediction rejection is implicit.** An unaccepted predicted shot expires or
   collides locally; there is no explicit rejection message that removes it early.
4. **Bounded fire history.** A 16-entry log cannot reconstruct every long-lived
   projectile for a newly interested observer after heavy sustained firing.
5. **Cold-cache tradeoff.** Waiting for all combat artwork increases first-entry
   time and GPU memory usage. A browser session reuses the cache, but production
   cold-cache timing/memory still needs measurement on slower devices.
6. **Reconnect/backpressure needs further soak testing.** WebSocket/TCP prevents
   ordinary packet reordering, not head-of-line stalls on a congested link.

Keep browser and server deployments together. `node scripts/netcode_bandwidth.mjs
compare` is a modeled bandwidth comparison, not a live server performance result.
