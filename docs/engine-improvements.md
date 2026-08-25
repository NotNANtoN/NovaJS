# EV Nova engine improvement catalog

Research compiled 2026-08-24 from the EVN Bible, the Ambrosia bug archive, patch
notes, and the Endless Sky / Cosmic Frontier (Kestrel) / NovaSwift remake
communities. The guiding rule (from the upstream NovaJS README): improve engine
issues only where doing so does not negatively affect gameplay.

The safest strategy is to remove accidental technical constraints while
retaining the original simulation rules. Changes to rendering, timing
infrastructure, persistence, tools, and data capacity are generally safe.
Changes to projectile physics, turning behavior, damage, or AI decision-making
can materially alter combat.

Ratings: **Risk** = gameplay/balance risk; **Effort** = rough TypeScript/PixiJS
implementation effort.

## Recommended improvements, ordered by low risk and player value

### 1. Make all simulation timing independent of render FPS

- **Original limitation:** EV Nova mixes 30ths-of-a-second timers with frame-count-based behavior. Weapon reload may use the 30 Hz timer while beam duration and firing frequency depend on rendered frames. Non-simultaneous weapons can fire only once per frame. This causes different DPS on different machines and visible gaps or overlaps in beams.
- **Evidence:** [Ambrosia bug archive](http://asw.forums.cytheraguides.com/topic/22013/comprehensive-list-of-known-bugs-in-ev-nova), especially the "FPS vs 30ths of a second" entry.
- **Modern approach:** NovaJS already has the right foundation with a fixed server timestep. Endless Sky uses interpolation/tweening for rendering; its [animation tweening documentation](https://github.com/endless-sky/endless-sky/wiki/AnimationTweening) separates animation presentation from simulation.
- **NovaJS recommendation:** Audit every weapon, animation, explosion, afterburner, and AI timer. Convert legacy 30ths values into deterministic simulation durations rather than multiplying by render delta.
- **Risk:** Low if calibrated against original 30 Hz behavior; medium if weapon cadence changes.
- **Effort:** Medium.

### 2. Smooth ship rotation without changing canonical turn physics

- **Original limitation:** Most ship sprites contain **36 frames per revolution**, approximately 10° apart. The Bible explicitly documents `FramesPer`, usually 36. EV Nova also has a player-only turn-rate bug: displayed turn values effectively become multiples of 10, or 30°/second.
- **Evidence:** [Nova Bible](https://andrews05.github.io/evstuff/guides/evnbible.html); [Ambrosia bug archive](http://asw.forums.cytheraguides.com/topic/22013/comprehensive-list-of-known-bugs-in-ev-nova).
- **Modern approach:** Endless Sky renders a single sprite using OpenGL at arbitrary angles: [Creating Ships](https://github.com/endless-sky/endless-sky/wiki/CreatingShips). Cosmic Frontier/Kestrel supports higher-resolution graphics and project updates describe 90-frame rotation assets.
- **NovaJS recommendation:** Keep a canonical floating-point heading for gameplay, but interpolate sprite orientation between source frames. Treat "continuous visual rotation" separately from any change to turn-rate mechanics.
- **Risk:** Low for visual interpolation; medium if player turn rates are changed.
- **Effort:** Small to medium.

### 3. Fix resolution, HiDPI, and sprite-selection problems

- **Original limitation:** Windows Nova was effectively tied to one configured resolution. Small asteroid sprites can disappear at higher resolutions unless padded to roughly 50–100 pixels. Some image selection logic scales a smaller nebula image upward instead of selecting a larger image and reducing it.
- **Evidence:** [EV Nova User Guide](https://download.escape-velocity.games/extras/EV%20Nova%20User%20Guide.pdf); [Ambrosia bug archive](http://asw.forums.cytheraguides.com/topic/22013/comprehensive-list-of-known-bugs-in-ev-nova).
- **Modern approach:** Kestrel supports larger sprites, GPU rendering, shaders, and HiDPI displays: [Cosmic Frontier technology documentation](https://evn.fandom.com/wiki/Cosmic_Frontier).
- **NovaJS recommendation:** Use logical world coordinates with a DPI-aware camera; choose assets by native size and provide a fallback for undersized legacy sprites.
- **Risk:** Low, provided world scale and collision coordinates remain unchanged.
- **Effort:** Medium.

### 4. Replace hard entity caps with soft, graceful limits

- **Original limitation:** The Nova Bible documents limits including 64 ships per system, 128 shots, 64 beams, 32 explosions, 16 asteroids, 2,048 systems, and 2,048 stellar objects.
- **Evidence:** [Nova Bible](https://andrews05.github.io/evstuff/guides/evnbible.html).
- **Modern approach:** Modern ECS engines use dynamic collections and can separate simulation capacity from visual effect budgets. Kestrel explicitly removes the numerical limits that came from the old resource system.
- **NovaJS recommendation:** Keep classic limits as an optional compatibility profile, but make arrays/pools dynamic. If overloaded, degrade particles and cosmetic effects first rather than deleting mission ships or projectiles.
- **Risk:** Low for normal scenarios; medium if exceeding 64 ships changes encounter composition.
- **Effort:** Medium.

### 5. Improve map routing, map bounds, and coordinate precision

- **Original limitation:** Government borders are drawn only inside a fixed 512×512 map area. Map outfits may fail to reveal the shortest route because link traversal depends on resource ordering rather than shortest-path distance.
- **Evidence:** [Ambrosia bug archive](http://asw.forums.cytheraguides.com/topic/22013/comprehensive-list-of-known-bugs-in-ev-nova).
- **Modern approach:** Endless Sky has route planning and a zoomable map. Cosmic Frontier adds configurable map styling and larger engine-side graphics.
- **NovaJS recommendation:** Use BFS/Dijkstra for route distance, render borders from actual map bounds, and preserve the original jump-distance rules. Use 32- or 64-bit logical coordinates internally.
- **Risk:** Low for routing correctness; medium if plugins intentionally rely on old route ordering.
- **Effort:** Medium.

Note: there is strong evidence for **16-bit resource IDs and resource-map
offsets**, but no reliable source establishing a general 16-bit
world-coordinate wraparound bug. Treat coordinate wrapping as unconfirmed
until reproduced.

### 6. Add snapshots, mission history, and optional mission markers

- **Original limitation:** The game automatically saves on takeoff, but has no convenient multi-slot snapshot system. Players commonly backed up pilot files manually. Mission triggers could fail, after which landing could overwrite the only useful save.
- **Evidence:** [EV Nova speedrunning documentation](https://evnova.miraheze.org/wiki/Speedrunning); [MobyGames player review](https://www.mobygames.com/game/9881/escape-velocity-nova/user-review/2437041/).
- **Modern approach:** Endless Sky provides autosaves and manual snapshots. Cosmic Frontier documents expanded mission information. Its ecosystem also uses optional mission markers: [Endless Sky PR #12548](https://github.com/endless-sky/endless-sky/pull/12548).
- **NovaJS recommendation:** Add multiple local save snapshots, a mission history/progress view, and optional markers disabled by default to avoid spoilers.
- **Risk:** Low; mission markers should be opt-in.
- **Effort:** Small to medium.

### 7. Improve targeting and input configuration

- **Original limitation:** EV Nova has targeting controls, but they are relatively primitive: `N` cycles targets, `R` selects the nearest hostile, and control customization is limited and platform-dependent. Windowed mode and resolution configuration were also awkward.
- **Evidence:** [EV Nova User Guide](https://download.escape-velocity.games/extras/EV%20Nova%20User%20Guide.pdf).
- **Modern approach:** Endless Sky adds configurable controls and broader targeting assistance.
- **NovaJS recommendation:** Add key rebinding, target filters, target cycling by category, and controller support without changing default bindings.
- **Risk:** Low.
- **Effort:** Small.

### 8. Correct mission cargo and objective bookkeeping

- **Original limitation:** Multi-ship cargo missions can transfer the entire quantity from the first ship while still requiring the player to board the remaining ships. Some missions can complete a travel objective before required cargo is collected.
- **Evidence:** [Ambrosia bug archive](http://asw.forums.cytheraguides.com/topic/22013/comprehensive-list-of-known-bugs-in-ev-nova); [Mïsn documentation](https://evnova.miraheze.org/wiki/M%C3%AFsn).
- **NovaJS recommendation:** Represent cargo objectives as stateful requirements: source ship, quantity obtained, required boarding events, and delivery prerequisites.
- **Risk:** Low for intended missions; medium for plugins that accidentally depend on the bug.
- **Effort:** Medium.

### 9. Repair cron date-range and double-termination behavior

- **Original limitation:** Zero-duration crons may run `OnStart` and `OnEnd` together or terminate twice. Date ranges can be interpreted as separate day/month and year constraints, making events occur on only a few dates instead of throughout the intended interval.
- **Evidence:** [Crön documentation](https://evnova.miraheze.org/wiki/Cr%C3%B6n); [Cron Behavior forum thread](http://asw.forums.cytheraguides.com/topic/17946/cron-behavior/1); [Ambrosia bug archive](http://asw.forums.cytheraguides.com/topic/22013/comprehensive-list-of-known-bugs-in-ev-nova).
- **NovaJS recommendation:** Implement a compatibility mode for legacy cron behavior, then offer corrected semantics for new scenarios. Ensure each activation and termination has an event ID and executes once.
- **Risk:** Medium because some plugins contain workarounds for the bugs.
- **Effort:** Medium.

### 10. Make beam and point-defense collision handling geometrically correct

- **Original limitation:** Beam hit detection is documented as unreliable; beams can pass through large portions of ships. Point-defense beams can continue firing at targets outside their range after destroying an in-range target.
- **Evidence:** [Ambrosia bug archive](http://asw.forums.cytheraguides.com/topic/22013/comprehensive-list-of-known-bugs-in-ev-nova); [Nova patch notes](https://evnova.miraheze.org/wiki/Nova:Patch_Notes).
- **NovaJS recommendation:** Use segment-vs-circle/polygon tests, clip beams at the first valid collision (partially done), and revalidate point-defense range and target eligibility every simulation tick.
- **Risk:** Low to medium; beams may deal their intended damage more reliably.
- **Effort:** Medium.

### 11. Evaluate weapon arcs from the actual mount position

- **Original limitation:** EV Nova determines whether a target is in a weapon's firing arc from the ship center rather than the weapon exit point. A front-quadrant turret can therefore fire backward from its physical mount.
- **Evidence:** [Ambrosia bug archive](http://asw.forums.cytheraguides.com/topic/22013/comprehensive-list-of-known-bugs-in-ev-nova).
- **NovaJS recommendation:** Calculate arc, origin, and line-of-fire from the mount transform. Preserve the old behavior in a legacy compatibility mode if plugin testing exposes dependence on it.
- **Risk:** Medium, especially for turret-heavy ships.
- **Effort:** Small to medium.

### 12. Improve escort formation and arrival steering, not global AI behavior

- **Original limitation:** Escorts have historically wobbled, flown backward, overshot planets, or become confused. Patch notes mention escort wobbling and fast-ship planet stopping-radius fixes. Asteroid miners can loop indefinitely when configured to scoop without the required equipment.
- **Evidence:** [Nova patch notes](https://evnova.miraheze.org/wiki/Nova:Patch_Notes); [Ambrosia bug archive](http://asw.forums.cytheraguides.com/topic/22013/comprehensive-list-of-known-bugs-in-ev-nova).
- **Modern approach:** NovaSwift uses inertialess formation flight to reproduce tight EV-style escorts while preserving Newtonian behavior for lone ships: [NovaSwift AI documentation](https://raw.githubusercontent.com/SirStig/NovaSwift/main/docs/AI.md).
- **NovaJS recommendation:** Add formation-slot steering, arrival/slowdown behavior, and explicit "cannot perform mining" fallbacks. Do not globally replace the AI with a more competent combat planner.
- **Risk:** Medium.
- **Effort:** Medium to large.

### 13. Make AI cloaking transitions explicit

- **Original limitation:** AI cloaking behavior is inconsistent: ships may cloak while leaving but not entering, remain cloaked longer than expected, or launch carried fighters despite incompatible cloak flags.
- **Evidence:** [Ambrosia bug archive](http://asw.forums.cytheraguides.com/topic/22013/comprehensive-list-of-known-bugs-in-ev-nova); [Nova patch notes](https://evnova.miraheze.org/wiki/Nova:Patch_Notes).
- **NovaJS recommendation:** Model cloak eligibility and transitions as explicit AI states, with a compatibility profile for original timing.
- **Risk:** Medium because cloak timing affects surprise attacks and mission difficulty.
- **Effort:** Medium.

### 14. Preserve mission ships, auxiliary ships, and carried fighters across saves

- **Original limitation:** Non-infinite auxiliary mission ships can disappear after quitting. Ship-changing operators can produce an empty fighter bay instead of transferring carried fighters. Ejection into a ship with zero inherent shields can immediately destroy or immobilize the player.
- **Evidence:** [Ambrosia bug archive](http://asw.forums.cytheraguides.com/topic/22013/comprehensive-list-of-known-bugs-in-ev-nova); [Nova patch notes](https://evnova.miraheze.org/wiki/Nova:Patch_Notes).
- **NovaJS recommendation:** Store mission auxiliary ships, carried ships, and ejection state as persistent records. Rebuild resource pools from the destination hull before applying damage.
- **Risk:** Low to medium.
- **Effort:** Medium.

## Improvements that require caution

### 15. Correct shield-to-armor boundary damage

- A shot that removes the last shield points may also apply its full armor damage rather than only the proportional remainder. Implement behind a compatibility flag and compare against stock combat before enabling by default.
- **Risk:** Medium to high. **Effort:** Small to medium.

### 16. Fix negative recoil for player weapons

- Negative recoil reportedly does not work for the player even though it works for AI ships. Apply recoil through the same simulation path for all ships, but test high-recoil weapons carefully.
- **Risk:** Medium. **Effort:** Small.

### 17. Add firing-ship velocity to projectile velocity only as an opt-in mode

- Unguided projectiles do not inherit the firing ship's velocity; fast ships can outrun their own shots ("Monty Python" maneuver). Preserve classic behavior by default; physically correct projectiles belong in an explicitly different ruleset.
- **Evidence:** [Weapon Type documentation](https://evnova.miraheze.org/wiki/Weapon_Type).
- **Risk:** High. **Effort:** Medium.

### 18. Do not globally add rotational inertia or accelerated turning

- Endless Sky deliberately retained immediate turning because rotational momentum would make aiming harder and fundamentally change combat ([Endless Sky issue #9545](https://github.com/endless-sky/endless-sky/issues/9545)). Improve sprite smoothness and determinism, but retain classic control response.
- **Risk:** High. **Effort:** Large.

## Resource-format and modding improvements

Classic Mac resource files have practical limitations: 16-bit map fields,
roughly 5,460 resource definitions per file, three-byte data offsets, and
approximately 16 MB per resource file
([OpenNova technical article](https://opennovablog.wordpress.com/)).
Kestrel supports legacy `.ndat`/`.rez` plus an extended format with 64-bit IDs.
NovaJS should keep the parser compatible with original files but use wide
internal IDs and dynamic resource collections. No gameplay risk; large effort
if an extended format is added.

## What modern projects deliberately preserve

- **Endless Sky:** arbitrary-angle rendering and interpolation, but immediate turning and simple movement kept on purpose.
- **Cosmic Frontier/Kestrel:** preserves original design and backward compatibility while removing resource-format limits.
- **NovaSwift:** explicit Classic/Enhanced philosophy — modern AI and QoL features opt-in, classic behavior faithful by default.

## Already fixed in this fork (do not duplicate)

- The 1=X weapon bug (accumulator-based firing).
- The Auto-Machine-Gun beam-stacking bug.
- Frame-rate-dependent beam DPS (delta-time damage).

Several other bugs were fixed in official Nova patches (turreted-beam
alignment, mission ships stopping while the player was cloaked, some AI
carrier failures); verify against the current implementation before reopening.

**Compatibility warning:** the Ambrosia bug archive explicitly says not to fix
the `Gxxx`/`Dxxx` outfit purchase bug blindly, because plugins rely on its
workaround. Any such correction needs version detection or a legacy
compatibility mode.
