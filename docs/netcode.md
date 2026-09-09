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

## Loading and presentation

Before publishing the player into a system, the browser awaits flight artwork,
weapon factories, collision polygons, and texture preparation. The warmup covers the destination's
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
  and unguided bullets remaining unguided even with a selected target. This uses
  JSON/codec round trips between ECS worlds, not a live WAN connection.
- `fire_sync_test.ts` and `weapon_plugin_test.ts`: intent/log ordering, duplicate
  suppression, clock mapping, rate limits, cost authority, and bounded waiting for
  cold server weapon factories.
- `nova_ecs/plugins/multiplayer_plugin_test.ts`: movement replication with simulated
  delay/jitter/reordering, authority, and interest management.
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
frame times (headless Chrome uses software rendering).

```sh
NOVA_PORT=8217 NOVA_PLAYER_DATA=/path/to/isolated/players.json \
  node scripts/probe_pvp.mjs --serve --url http://localhost:8217
```

The probe now clicks **Enter Ship**, writes to the actual ECS component map rather
than its read-only-by-convention debug name-map copy, checks rendered projectiles
rather than instantaneous counts of already-expired shots, and cleans up both
browser processes if startup fails.

## Remaining limits and risks

1. **Not zero latency.** Remote movement snapshots are nominally sent every 100 ms,
   with a 200 ms interpolation delay and up to 100 ms extrapolation. The clock
   mapper estimates offset from arrivals, so network delay is included in that
   estimate; it is not an RTT-corrected shared simulation clock.
2. **Not identical visual impacts.** Ships and projectiles do not share a single
   presentation timeline. Clients independently remove projectiles on visual
   collisions. Guided trajectories depend on each client's available target
   history and frame timing; collision-triggered submunitions can differ visually.
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
