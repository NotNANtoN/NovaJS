# NovaJS roadmap

Canonical status and work order as of 2026-08-25. Checked items have focused
automated regression coverage or a repository-level build/CI check; they do not
imply complete EV Nova retail parity.

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

## P0 correctness and data safety remaining

- [ ] Define one canonical persisted `PlayerState` codec and one `PlayerStore`
  port; remove duplicate projections/defaults/fingerprints only after migration,
  restart, snapshot restore, and malformed-data tests pass.
- [ ] Preserve and validate saved ship snapshots across process restart; add a
  round-trip test covering ship, cargo, outfits, missions, date, and position.
- [ ] Consolidate NCB test context and side effects behind one runtime adapter;
  prove identical behavior for BBS accept/refuse, landing, expiration, and
  scripted operations before deleting the duplicate adapters.
- [ ] Move player-state and mission mutations to an authoritative validation
  boundary; test forged availability, cargo, credits, mission, and ship-change
  inputs before enabling those paths for multiplayer.
- [ ] Add explicit migration/version handling for every persisted schema change,
  including rollback-safe fixtures from currently supported pilot files.

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
