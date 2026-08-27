# NovaJS roadmap

See [`docs/engine-overview.md`](engine-overview.md) for how the engine
works and [`docs/maturity.md`](maturity.md) for how far each area can be
trusted today.

Canonical status and work order as of 2026-08-27. Checked items have focused
automated regression coverage or a repository-level build/CI check; they do not
imply complete EV Nova retail parity.

The server-authoritative player mutation items below were checked off before
the 2026-08-26 reboot described in [`docs/maturity.md`](maturity.md), and the
code did not survive it. They are unchecked again because nothing in the tree
implements them: there are no mutation sessions, no intent-only protocol, no
capability negotiation, and no remote mutation port. Verify against the code
before checking any of them again.

## Completed/current foundation

- [x] Node 24 + Bun/esbuild supported build path, with `npm run check`, installed
  pre-commit/pre-push hooks, and GitHub Actions coverage.
- [x] Retail-style start menu composition, animated title logo, title music
  lifecycle, and no-assets fallback, with timing and music tests.
- [x] Landing selection from authoritative retail flags, service-button
  visibility, and stale metadata cache recovery, with landing and route cache
  tests.
- [x] Mission Computer/BBS retail artwork layout, variable-height rows, mission
  string formatting, Mission Info, and offer/accept/refuse interactions, with
  layout, text, availability, and mission runtime tests.
- [x] NCB expression evaluation, core state effects, mission availability,
  persisted mission bits/state, and procedural cargo/ferry fallback, with
  focused NCB, persistence, availability, and mission tests.
- [x] Normal hyperjump spool/departure/arrival behavior, one-hop route
  consumption, route persistence across starmap reopens, and death relocation
  kept separate from jump presentation, with jump, starmap, and death tests.
- [x] Staged player destruction and last-landed-position respawn, including
  cross-system relocation, with simulation and presentation tests.
- [x] Role- and relationship-aware faction hostility plus internal security
  threat propagation, with provocation and allied-response tests.
- [x] Primitive-safe delta replication and an initial component-authority
  registry for movement/firing paths, with primitive, full-state, delta, and
  authority regression tests.
- [x] Focused persistence, input-edge, held-fire, cache, render-lifecycle, and
  performance hardening covered by the current supported test suite.
- [x] Token-only Linode deployment from GitHub Actions: no manual SSH step,
  host-side deploy assets refreshed from the image and rolled back if unhealthy,
  HTTPS that survives a host recreate, per-IP request and bandwidth limits,
  nightly pilot-data backups to object storage, and lossless WebP artwork. See
  [`docs/DEPLOY.md`](DEPLOY.md).
- [x] Time to a usable main menu no longer depends on the 9.4 MB title music or
  the full artwork set: the menu renders immediately and upgrades to retail
  presentation as assets arrive.
- [x] Jump feel: braking before a jump, streaks and charge audio driven by the
  speed the jump actually adds, a silent departure for distant ships, and the
  arrival bang at the end of the flash rather than an explosion at its start.
- [x] Killed pilots end the session after the explosion, return to the menu, and
  cannot be flown again until a save is loaded.

## P0 correctness and data safety remaining

- [x] Define one canonical persisted `PlayerState` codec and one `PlayerStore`
  port; remove duplicate projections/defaults/fingerprints only after migration,
  restart, snapshot restore, and malformed-data tests pass. The port now
  declares what it actually returns, HTTP and peer responses go through one
  whitelisting projection so store bookkeeping cannot leak, and menu/client
  defaults come from `createInitialPlayerState()`.
- [x] Preserve and validate saved ship snapshots across process restart; add a
  round-trip test covering ship, cargo, outfits, missions, date, and position.
  Stored ships are decoded component by component, so one obsolete component
  cannot discard a hull; session-lifecycle components are excluded by name; a
  hull that no longer matches falls back to a fresh ship. The stored ship is
  refreshed when the pilot leaves a spaceport, which is what makes Outfitter
  and Shipyard purchases survive a reload.
- [x] Consolidate NCB mutation semantics behind one detached transaction
  runtime and ordered ECS effect queue; route BBS, landing, expiration,
  ship-goal, shipyard, outfitter, and trade intents through the shared local
  mutation boundary.
- [ ] Move player-state and mission mutations to an authoritative validation
  boundary; test forged availability, cargo, credits, mission, and ship-change
  network commands before enabling those paths for multiplayer.
  - [ ] Add the strict intent-only protocol, capability negotiation, monotonic
    revisions, durable reconciliation, replay idempotency, remote purchase
    adapter, and negotiated raw-replication lock. Monotonic per-token revisions
    with conflict rejection do exist in the store; the rest does not.
  - [ ] Issue stable resolved retail/procedural mission offers server-side and
    move offer accept/refuse, active-mission abort, landing completion/failure,
    expiration, ship goals, rewards, date, and arrival snapshots behind the
    revisioned authority session.
  - [ ] Move jump-route/date and death/respawn state transitions behind the
    server authority session, advertise `worldLifecycle`, and enable strict
    new/new negotiation. Accepted jumps commit at begin before presentation;
    death relocation is server-detected and server-completed. Legacy peers
    retain owner-authoritative compatibility for all fields.
  - [ ] Harden the strict boundary with server-selected, retryable capability
    negotiation; token-keyed serialized CAS sessions; authoritative new-pilot
    creation and entity binding; reconnect-stable offer scopes; durable pending
    death state; generation-bound world transfers; and a server movement
    validation shadow used by landing. Legacy mutation authority is now an
    explicit, disabled-by-default deployment policy.
- [x] Add explicit migration/version handling for every persisted schema change,
  including rollback-safe fixtures from currently supported pilot files. Records
  carry `schemaVersion`, an ordered migration registry upgrades unversioned
  pilots in place, and a record written by newer code is refused rather than
  downgraded.
- [x] Never destroy pilot data that cannot be read. An undecodable file or
  record is quarantined verbatim, writes for that token are refused, and the
  menu says so and blocks New Pilot and Enter Ship so nothing is overwritten.
  A single malformed snapshot is dropped without taking the pilot with it.
- [x] Flush pending writes on `SIGTERM`/`SIGINT`, and recover the write chain
  after a failed write instead of silently dropping every later save.

## P1 single-player retail completeness

- [ ] Implement the remaining retail mission selectors and resolve each selector
  once at the correct offer/accept event; add fixtures for fixed, random,
  government, adjacent-system, return, and unavailable targets.
- [ ] Implement remaining mission goals and effects, including boarding/rescue,
  escort/defense variants, ship/outfit mutations, abort/failure, deadlines, and
  chained missions; test success, refusal, failure, expiry, save/reload, and
  repeated landing for each supported lifecycle.
- [ ] Parse and schedule `crön` resources, persist their state, and render
  conditionally available news; test ordering, recurrence, NCB gates, and
  save/reload behavior.
- [ ] Map the richer Bar/spaceport character content, including retail resource
  8504, while retaining mission-board fallback; add representative data fixtures
  and navigation tests.
- [ ] Add retail hail/comms selection, dialogue, and response effects with
  pause/input behavior covered in browser-level tests.
- [ ] Complete landing descriptions and artwork selection across inhabited,
  uninhabited, restricted, and unavailable-resource cases; verify service flags
  and fallback behavior against retail data fixtures.
- [ ] Build a story regression corpus covering the major faction openings,
  branching bits, ranks, mission chains, and endings; run it through new pilot,
  save/reload, and restored-snapshot paths.
- [ ] Audit plug-in overlays for mission, `crön`, Bar, landing, and text resource
  precedence; add compatibility fixtures before claiming general plug-in
  support.

## P2 engine fidelity and performance

- [ ] Finish world/plugin teardown and PIXI ownership: dispose subscriptions,
  async graphics, containers, textures, emitters, and render targets exactly
  once; add repeated jump/menu/landing lifecycle tests and a GPU-memory soak.
- [ ] Migrate remaining display objects to managed graphics without destroying
  shared textures or reusable objects; cover late async completion and
  externally destroyed roots.
- [ ] Consolidate persistence schemas and transport codecs after the P0 safety
  contract is tested, then remove duplicate browser/server state interfaces.
- [ ] Pay down full `tsc --noEmit` debt without weakening compiler settings;
  make typecheck gating only after the repository passes cleanly on Node 24.
- [ ] Extend combat and AI regression coverage for collision broad/narrow
  phases, beams, point defense, bursts, large time deltas, NPC goals, fleet
  behavior, and long-running system simulation.
- [ ] Define tested compatibility profiles for browser/Pixi capabilities, EV
  Nova data versions, and plug-in resource precedence; document graceful
  fallbacks for each profile.
- [ ] Remove the Pixi `SCALE_MODE` warning by moving filtering policy to owned
  textures/renderers, with pixel-art and scaled-UI visual regressions.

## Asteroids and the political map

Both are implemented and covered by tests; see `docs/asteroids-and-territory.md`.
Remaining gaps:

- [ ] Ram damage from flying into an asteroid, and asteroid selection with the
  target key.
- [ ] NPC miners storing and selling the ore they mine.
- [ ] Real `jünk` commodity names for ice and crystal yields.
- [ ] Government territory that follows mission bits rather than the static
  `gövt` owner.

## P3 optional enhancements

- [ ] Prototype living planets as an opt-in layer: ambient audio, subtle landing
  animation, traffic, reactive chatter, and a news terminal.
- [ ] Evaluate pre-generated, optional TTS for selected story text, including
  pronunciation review, storage budget, subtitles, and copyright constraints.
- [ ] Design and ship the TCTLIDS storyline only as a separate plug-in, with new
  assets and no changes to retail canon or redistributed EV Nova content.

## Parked: multiplayer faction design

Multiplayer expansion remains parked until the P0 and P1 single-player work is
complete. The optional direction is shared, server-authoritative faction
territory, infrastructure, reputation, and procedural war missions rather than
attempting to synchronize each pilot's retail storyline. Do not start this work
without first defining authoritative state, old/new client compatibility,
recovery behavior, and multiplayer-specific regression coverage.
