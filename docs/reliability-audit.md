# Combat and interaction reliability audit — 2026-09-08

Baseline: `c5a5833c`, branch `feat-performance-and-modernization`.
This is a focused source/test audit, not certification of multiplayer correctness or retail parity. The audit was initially local-only; the user subsequently authorized committing and pushing this release to abakus and GitHub. The pre-existing `nova/src/client/build_info.json` contents were preserved across the build.

## Fixed findings

| Severity | Finding | Fix and regression evidence |
| --- | --- | --- |
| High | Asteroid hazards ran in browsers: the old authority guard depended on an incidental entity's multiplayer component. | `nova/src/nova_plugin/asteroid_plugin.ts`: explicit server-only execution. Regression reproduced local asteroid armor falling from 175 to 141 before the fix. |
| High | A new assistance request could replace a paid rescue's outcome, cancel the rescue, or charge for another helper. | `nova/src/nova_plugin/assistance_plugin.ts`: player-wide pending transaction lock and server-local ignored-sequence watermark. Tests cover same/different/invalid helper, one charge, completion, timeout, no deferred execution, and a later fresh request. |
| Medium | Malformed fire intents advanced the server sequence watermark before validation, suppressing later valid shots. | `nova/src/nova_plugin/weapon_plugin.ts`: validate before advancing. Four ECS regressions cover unsafe/fractional sequences, invalid seeds and exit indices, subsequent valid firing/logging and replay suppression. Wire codecs accept these numeric payloads, so semantic validation is necessary. |
| Medium | Asteroid collision sweeps ran once per matching entity rather than once per world step. | Added `SingletonComponent`; regression counts traversal. |
| Medium | Module-global asteroid cooldowns interfered across worlds; harmless low-speed contact consumed a future damaging impact's cooldown. | World-local resource with expiry/clock-reset handling; record only damaging contact. Regression coverage includes time-zero and separate worlds. |
| Medium | Asteroid impulses changed server copies of player-owned movement without replication. | `external_impulse.ts` now replicates server-authored additive impulses to the owning browser exactly once. Observers follow owner movement. Tests cover batching, authority, duplicate/full-state delivery, reconnects, clock offsets and death/jump boundaries. Two-second expiry deliberately discards stale impulses. |
| Medium | Assistance polling accepted newer transactions as completion of the transaction being watched. | `nova/src/spaceport/comms_panel.ts`: exact helper/sequence match, repeat-click suppression, resume watching pending rescue. Tested in `comms_test.ts`. |
| Medium | Shipboard offer loading accessed a revocable ship-data draft after awaiting data. | `nova/src/spaceport/mission_bbs.ts`: capture primitive government ID before awaiting. Deferred-load/draft-revocation regression in `mission_bbs_text_test.ts`. This does not establish safety of every asynchronous menu path. |

## Combat path inspected

- `weapon_plugin.ts`: owning-browser cadence predicts player shots. The server queues validated intent snapshots and emits at server-controlled reload/burst deadlines using `fire_cadence.ts`, checking live balances before creating authoritative shots. NPC cadence remains server-owned.
- `fire_sync.ts`: owning-client intent is not relayed; server-authored fire log is replicated. Buffers contain 16 shots. Projectile identity stays `shot:<source>:<seq>`, while optional `logSeq` orders server emissions independently. A delayed shot from one weapon no longer disappears behind a higher client sequence emitted by another weapon. Updated clients are needed for this ordering.
- `fire_weapon_plugin.ts`: shot creation checks destruction/armor and target existence; deterministic seed and logged muzzle state drive replay.
- `weapon_plugin.ts` / `fire_sync.ts`: log replay deduplicates predicted shots and maps server fire times onto the receiving clock. Re-entry can replay the live log tail. This is not proof that a 16-shot tail suffices under all latency/fire-rate combinations.
- `collisions_plugin.ts`: reproduced and fixed fast-projectile tunneling using tick-local movement snapshots, swept broadphase bounds and translational polygon/circle narrowphase (`swept_collision.ts`). Contacts are ordered earliest-first; rejected contacts do not prevent later valid impacts. Hull updates explicitly precede collision and asteroid hazard checks. Rotation/frame changes, wrap crossings and historical fire-log fast-forward are not swept.
- `projectile_plugin.ts`: ownership/proximity safety checks precede damage; accepted swept impacts move the projectile to contact before removal/submunitions/explosion handling. Fixed reciprocal outgoing damage from projectiles receiving an `initiator: false` collision notification. Collision notifications are candidates, not proof of accepted damage.
- `death_plugin.ts`: replicated ship damage is rejected in browser worlds; local projectiles can resolve local point-defense damage. Zero armor starts server-side destruction. Full kill-attribution, disconnect and jump ordering were not exhaustively traced.
- `nova_ecs/plugins/multiplayer_plugin.ts`: movement is owning-client authority; the server relays it rather than sending a competing simulated movement stream. Observer snapshot queues exist, but smoothness and correction behavior were not browser-tested.

## Follow-up fixes

- **High — repeated surrender rewards:** `surrender_plugin.ts` adds an owner-request/server-outcome protocol, registered in `system_plugin.ts`. It validates requesting player state and a live, disabled, server-owned NPC within the existing 300-unit transfer range. Requests are sequence-deduplicated player-wide; a target pays only once across competing players. The payout is capped at 5,000 and debited from the shared boarding purse, not minted. NPCs with no available credits reject the demand. These are reliability rules, not retail authenticity claims. `surrender_plugin_test.ts` covers replay, competing players, stale/active/distant targets, malformed sequences, browser non-authority and available balance.
- **Medium — assistance settlement:** server-local payment receipts refund failed paid rescues once, including timeout, disability/destruction, departure and jump. Removal subscriptions settle before entity transfer. Disabled helpers are rejected before charging; missing government data gives a terminal failure. Successful rescues stay charged. Outcomes expose `refundedCredits` as confirmation, never an instruction for a second UI refund.
- **Medium — polling/lifecycle:** assistance and surrender polling are bounded to 120 seconds and correlate exact request identity. Timeout means unknown result, not rejection or refund. Reconciliation can resume watching existing pending requests without resubmission; stale interval callbacks cannot clear newer timers.
- **Low — background race:** comms background loads are generation-guarded; stale sprites are discarded. Show/close/target changes invalidate old asynchronous work and settle the original show promise.
- **Medium — contract acceptance:** check `acceptMission()` result, await chained mission work on a detached state copy, then commit only if the player context and state still match. A concurrent player-state change reports retry instead of overwriting newer state.
- **Medium — draft/cache and ordering:** geometry caches no longer retain shape-array drafts or draft polygons. Collision trees retain hull/component references only within the step. Tests cover revoked drafts, hull offsets, earliest impact, near misses, cleanup, single projectile consumption and unchanged beam behavior.
- **Medium — NPC outfit ammunition:** server-owned cadence now consumes configured outfit ammo only after successful firing; one-ammo-per-burst is tracked per installed copy in local component state, including draft replacement. Replay and submunitions do not charge again.

## Harder authority and cadence fixes

- **Server cadence:** `fire_cadence.ts` enforces reload and burstReload from actual server emission time, supports simultaneous/staggered installed copies, and bounds pending work (16 per weapon, two-second expiry). No client timestamp grants firing credit and stalled simulation does not create an unlimited catch-up volley. State and deduplication survive entity replacement/reconnect through the token-scoped combat authority. Death/jump/ownership/hull/system changes discard pending work without refilling cooldown. Tests include batched arrivals, burst pauses, failed spawns, malformed configuration, lifecycle transitions and cross-weapon log ordering.
- **Parsed costs:** `novaparse/src/parsers/WeaponParse.ts` now interprets documented ammo codes. `-1` is unlimited, `-999` retains self-destruction semantics, codes <= -1000 consume `abs(code + 1000) / 10` fuel units per shot, and 0–255 reverse-link ammunition outfits through all modifier slots. Evidence: repository `EVN_Bible.pdf` pp. 65/69 and decoded resource fields. Missing links and unsupported codes fail explicitly instead of silently granting unlimited ammo. Valid retail alternatives are represented as an ordered outfit list; consumption chooses the first available entry and spends only one unit. Qualified-key lookup in the ID-space proxy was corrected so enumerating outfits works. Bay ship IDs remain separate.
- **Player fuel/ammo:** `combat_resources.ts` maintains a server token-scoped ledger, initialized from saved balances/approved stock rather than initial client ammo/fuel. Actual player shots require initialization; failed/duplicate/replayed shots do not spend again. Flight merge policies prevent client ammo or fuel increases/removal. NPC fuel weapons use a finite tank. Energy here means fuel, not a new rechargeable battery.
- **Shop and lifecycle integration:** refuel, ammo buy/sell, hull purchase, landing and departure use revisioned receipts via `/player/combat/shop`. Catalog/service/capacity/price checks run on the server. Duplicate requests return receipts; after-final-await checks prevent delayed landing requests reopening a departed session. Bounded HTTP waits and recovery keep landing errors from orphaning the player.
- **Persistence:** ammo-only changes persist; combat spending advances store revisions. Flight saves can rebase only across combat-only writes without restoring pre-purchase credits or dropping unrelated state. Snapshot/HTTP saves cannot refill established balances. Ordinary snapshot rollback preserves current combat balances/hull; explicit New Pilot establishes fresh server defaults and retires old flight handles.
- **Async outfit updates:** outfit count/firing and hull-physics inputs are detached before catalog awaits, including a draft-revocation regression. This matters now that ammo consumption changes outfits during combat.

### Behavioral changes and remaining limits

- **Burst payment timing differs from the documented retail timing:** one-ammo-per-burst reserves/debits once per copy on its first successful shot, not at burst completion. Cancellation/reconnect cannot turn partially delivered bursts into free shots; no refund is issued for an interrupted burst.
- **Not fully authoritative economics/navigation:** credits, non-ammo inventory, mission prerequisites and movement still use legacy client-authored inputs. Jump/cloak fuel decreases are deduplicated against server-issued baselines but remain owner-reported, not independently validated navigation transactions. Future mission ammo grants require an explicit ledger grant path; arbitrary ammo-map changes are no longer trusted.
- Queue expiry deliberately drops stale shots; prediction may visually lead delayed or rejected authoritative shots. Production latency/jitter behavior and the complete retail asset set have not been exercised. Malformed weapon references now reject loading and need data correction rather than an unlimited-ammo fallback.
- Sweeps use endpoint geometry translated over the current tick: rotation, frame changes, world wrapping, observer corrections and historical fire-log fast-forward remain outside coverage. Equal-distance beam targets retain existing behavior.
- Refunds require available player state; durable recovery after process crashes/discarded state is not added. Player credit/inventory authority as a whole is not hardened by adding surrender request validation.
- General boarding/capture, purchases/transfers, escort commands, shop unlock correctness, full kill-attribution and disconnect ordering are not comprehensively audited. No new retail authenticity or multiplayer-completeness claims are made.

## Asteroid audio crash and release validation

The reported `sound_attenuation.ts:29` revoked-proxy exception was reproduced: asteroid impacts queued an Immer-backed movement position, which was revoked before the forwarded sound played. `SoundEvent.emit()` now copies coordinates at emission; all positional emitters use it. Regression coverage revokes the movement draft before forwarding/playback and verifies one correctly attenuated sound.

The PICT 7503–7506 Pixi warnings were separate cold-cache probes. `GameData.ts` checks `Assets.cache.has()` before reading cached assets; loading/fallback behavior remains intact.

Actual installed retail-data validation found and fixed the ammo proxy/alternative-outfit blockers before deployment. All **81 weapons** now parse through the real ID-space loader (52 unlimited, 8 fuel, 9 single-outfit, 12 alternative-outfit), and all ammo references resolve in the **242-outfit** catalog. This does not validate all rendering or gameplay paths.

## Validation

- Focused regressions were observed failing before their respective fixes.
- Final `npm run typecheck`: passed.
- Final `npm run build`: passed; pre-build build-info bytes restored afterward.
- Final integrated `npm test`: 175 test files, zero failures.
- Four configured skips: SocketChannelServer (native ws module shape), display_plugin (browser-only renderer), NovaParse and SndResource (legacy lamejs loader).
- `git diff --check`: passed.
- All four deployment-script test groups passed; installed pre-push equivalent `npm run check` passed.
- Earlier concurrent full-suite attempts reported a timing-sensitive motion-input failure and, separately, asteroid regressions while the fix was in progress. The final integrated run passed.

## Required live two-browser checks

1. Simultaneous firing: compare shot IDs, server health, impact/destruction and kill credit in both clients; include rapid weapons, guided rounds, point defense and overlapping targets.
2. Latency/jitter/tab suspension: inspect first volley, log overflow, projectile expiry, target motion and interest exit/re-entry. Check whether locally rejected/accepted impacts visibly disagree with server damage.
3. Asteroid contacts: compare health and destruction in both clients; verify player/NPC bounce, observer following, batching and expiry without double impulses. Late pre-death/jump impulses must not affect resumed movement.
4. Assistance/surrender: repeated clicks, competing players, switching targets, closing/reopening comms, helper departure/destruction, timeout and player death/jump while pending. Confirm one charge/payout, failed-rescue refund once, shared boarding purse debit and no false completion.
5. Death/respawn with contract/destination dialogs loading; old asynchronous results must not mutate the new player state.
6. Disconnect/reconnect and system transitions with in-flight shots and pending interactions; verify cleanup, retained cooldown and no replayed transactions.
7. Fuel/ammo weapons: run dry, refill/rearm, simultaneous and partial bursts, reconnect and restart. Confirm one authoritative debit and no free refill from stale state. Check NPC fuel exhaustion separately.
8. Landing/shop failure injection: lost responses, concurrent opens, delayed duplicate open after departure, stale save after purchase, slow response bodies and recovery retries. Verify no duplicate purchase, refunded spending, stranded menu or premature return to flight.
9. Run browser clients and server from the same updated build for logSeq/receipt compatibility. Installed weapon parsing/ammo references were checked before deployment as noted above.

These checks were not run in this audit.
