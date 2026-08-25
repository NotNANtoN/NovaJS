# Design ideas & future directions

Captured from design discussions (Aug 2026). These ideas are **optional and
parked**; they are not scheduled work or claims about current capabilities. See
the canonical [`docs/roadmap.md`](roadmap.md) for priorities and completion
status. This file records intent so ideas survive between sessions.

## Faction multiplayer (parked until single-player is complete)

The original EV Nova mission/storyline structure does not fit multiplayer:
missions are personal, story bits are per-pilot, and the galaxy is static per
player. Instead of porting single-player missions, redesign around factions:

- **Join a faction, not a storyline.** Players pick (or earn their way into)
  Federation, Rebellion, Aurorans, Polaris, pirates, etc. Reputation and rank
  systems already exist in the engine.
- **Territory control.** Factions can capture systems/planets. Ownership is
  server-authoritative shared state — a natural fit for the existing ECS +
  delta replication model.
- **Player-funded infrastructure.** Players buy planetary defenses, defense
  fleets, maybe upgrades for "their" planet (better shipyard tech level,
  trade bonuses). Uses the existing money/outfit/spawn systems.
- **Dynamic missions instead of authored ones.** Procedural missions (already
  implemented for cargo/ferry) generated from the war state: raid convoys,
  defend a siege, scout enemy systems.
- Engine prerequisites already in place: ownership model, delta sync,
  server-authoritative NPC spawning, faction relations. Design work is the
  main lift, not netcode.

## TCTLIDS secret storyline (custom content, wave ~11)

Principles agreed:

- Keep S7evyn and all original easter eggs exactly as they are in retail.
- The Wraith and Krypt remain observable in deep space as in the original.
- **TCTLIDS** ("The Creature That Lives In Deep Space") is referenced in the
  data but has no assets and is never observable — that vacuum is our
  opportunity: build a secret storyline around it without contradicting canon.
- Discovery through exploration: no BBS entry points. Anomalous sensor
  readings in remote systems, escalating encounters, a small chain of new
  systems in deep space.
- New assets required (ship sprites, possibly a new government/race). Ship it
  as a **plug-in** (standard Nova plug-in mechanism, which the engine already
  parses) so the base data stays untouched and it works for other players.

## Living planets (new idea, undesigned)

Goal: landing should feel like visiting a place, not opening a menu.

Candidate mechanics, roughly ordered by effort:

- **Ambient audio per planet class** — spaceport hum, wind on desert worlds,
  rain on ocean worlds. Cheap, big atmosphere win. (Original game had none.)
- **Animated landscape shots** — subtle parallax/ken-burns pan over the
  existing landing PICT, weather overlays (rain, heat shimmer). Uses retail
  art, no new assets.
- **Rotating spaceport chatter** — a small pool of flavor lines per
  government/tech level shown in the spaceport ("dock workers are on strike
  again"), some reacting to game state (war news, storyline bits, the
  player's rank/legal status).
- **Time-of-day / traffic** — ships landing and taking off in the background
  of the landing screen; already-parsed `düde` tables tell us who plausibly
  visits.
- **News terminal** — original game has news via `crön` resources (wave 8);
  presenting it as a terminal in the bar rather than static text adds life
  for free once crons land.
- **NPC personas in the bar** — named recurring characters per planet with a
  few lines each; possibly the hook for mission-giving beyond the BBS.

## TTS narration for story text (new idea, evaluating)

There is a lot of high-quality mission/description prose. Options:

- **Pre-generated, not live**: batch-generate audio once per text with a
  modern TTS model, ship as audio files, play with existing sound pipeline.
  No runtime dependency, no cracks/latency at play time, can hand-curate
  and re-generate the bad ones.
- **Voice casting per source**: different voices per government/character
  (Auroran gravel, Polaris calm, Vell-os telepathy with an effect chain)
  rather than one narrator; mission text is already attributed to sources.
- **Always subtitled and optional**: keep text primary; audio is a toggle,
  default off on first run. Preserves the reading charm for purists.
- Risks acknowledged: AI voices can crack/mispronounce (mitigated by
  pre-generation and curation); some of the game's charm is in reading;
  storage cost (hundreds of `dësc` resources — start with major storyline
  missions only, not every outfit description).
- Legal note: the text itself is ATMOS-copyrighted, so generated audio is a
  derivative work — fine for personal use, same distribution caveats as
  assets (see repo policy of never shipping copyrighted content).

## Related documents

- [`docs/roadmap.md`](roadmap.md) — canonical prioritized implementation status
  and remaining work.
- `docs/engine-improvements.md` — engine limitations research and the
  low-risk improvement backlog with sources.
