# Netcode: making a fight resolve the same way for both players

## The problem

Shots are not replicated. Every world — the server and each browser — runs
`WeaponsSystem`, creates its own projectiles, detects its own collisions and
mutates health locally. Only the trigger (`WeaponsStateComponent.firing`)
crosses the network.

Two consequences:

- Shot inaccuracy and submunition spread are drawn from the global
  `Math.random()`, so the same trigger produces different shots in every world.
  Nothing reconciles them.
- `ShieldComponent` and `ArmorComponent` have no explicit replication policy, so
  they fall back to `entity-owner`. Each client authors its own health.

A kill therefore resolves in one world and not in another, which is the thing
that has to be fixed before two people can fly together.

## The shape of the fix

Shots are not replicated as entities. A projectile is a handful of components
and a busy fight has hundreds of them, so shipping each one would cost far more
bandwidth than the fight is worth, and routing your own shots through the server
would put a round trip between the trigger and the muzzle flash.

Instead a shot is replicated as the *event that created it*, and every world
derives the same shot from that event:

1. **The owner decides when it fires.** The world that owns a ship runs the
   weapon cadence: your browser for your ship, the server for its NPCs. No other
   world runs cadence for that ship.
2. **A shot is described by a seed, not by its outcome.** Inaccuracy and spread
   come from a seeded generator, so the same `(weapon, seed)` produces the same
   angles everywhere. Nothing about a shot is drawn from global randomness.
3. **The firing client predicts immediately.** It spawns its own shot the moment
   it fires, and announces it as an intent: `(sequence, weaponId, seed)`.
4. **The server is the register of record.** It accepts an intent, records it in
   a server-authoritative fire log stamped with server time and the muzzle
   position, and spawns the shot. Other clients spawn from that log,
   fast-forwarded by the time since the stamp so the shot is not behind. The
   firing client already has the shot and skips it.
5. **Only the server resolves hits.** Damage application moves behind a server
   check and health becomes server authority. Clients still delete a projectile
   they see hit something, because that is presentation; what the hit *did* comes
   back as replicated health.

The client keeps authority over its own trigger and its own seed. A determined
cheat could reroll a seed for a better inaccuracy draw, which is a fair trade for
playing with friends and buys immediate, lag-free shots.

## Wire format

Two components on the ship entity, both bounded ring buffers of recent shots so a
dropped or reordered packet self-heals from the next one.

`FireIntentComponent`, authority `owning-client`:

    { shots: [{ seq, weaponId, seed, exitIndex }] }

`FireLogComponent`, authority `server`:

    { shots: [{ seq, weaponId, seed, exitIndex, at, position, rotation }] }

`seq` increases per ship. A consumer tracks the highest `seq` it has spawned and
ignores anything at or below it, which makes a repeated packet harmless.

## Status

- [ ] Deterministic seeded shots and the fire log (replaces global randomness)
- [ ] Server-authoritative damage, death and health
- [ ] Bandwidth: quantisation and per-client interest management
- [ ] Two-browser probe proving a kill resolves for both players
