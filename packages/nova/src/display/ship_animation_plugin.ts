import { GetEntity, UUID } from "nova_ecs/arg_types";
import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { Query } from "nova_ecs/query";
import { System } from "nova_ecs/system";
import { ShipAnimationMode } from "novadatainterface/animation";
import { AnimationComponent } from "../nova_plugin/animation_plugin.js";
import { BeamDataComponent } from "../nova_plugin/beam_plugin.js";
import { SourceComponent } from "../nova_plugin/fire_weapon_plugin.js";
import { SimulationGameDataResource } from "../nova_plugin/game_data_resource.js";
import { CloakActiveComponent, CloakScannerComponent } from "../nova_plugin/cloak_plugin.js";
import { DisabledComponent } from "../nova_plugin/disabled_component.js";
import { FoldStateComponent } from "../nova_plugin/fold_state.js";
import { foldRatePerSecond, moveToward } from "../nova_plugin/fold_state.js";
import { IonizationColorComponent } from "../nova_plugin/health_plugin.js";
import { IsIonizedComponent } from "../nova_plugin/ionization_plugin.js";
import { JumpComponent } from "../nova_plugin/jump_plugin.js";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin.js";
import { ShipComponent } from "../nova_plugin/ship_plugin.js";
import { WeaponsStateComponent } from "../nova_plugin/weapons_state.js";
import { AnimationGraphic } from "./animation_graphic.js";
import { AnimationGraphicComponent, ObjectDrawSystem } from "./animation_graphic_plugin.js";
import { blinkPhaseFromUuid, runningLightState } from "./running_light_blink.js";

// How visible a ship is while cloaked. Other ships fade to nearly
// invisible; your own ship stays faintly visible so you can still fly it
// (matching EV Nova, where the player's cloaked ship is a faint ghost).
const CLOAKED_ALPHA_OTHER = 0.0;
const CLOAKED_ALPHA_SELF = 0.25;
// A cloaked ship revealed on screen by the player's cloak scanner shows
// as a faint ghost rather than fully solid.
const CLOAKED_ALPHA_REVEALED = 0.4;
const UNCLOAKED_ALPHA = 1.0;

// The local player's cloak scanner, if any. Used to reveal other ships'
// cloaks on screen (scanner ModVal 0x0002).
const PlayerScannerQuery = new Query(
    [PlayerShipSelector, CloakScannerComponent] as const);


// All beams currently being emitted, along with the uuid of the ship that
// fired each one. Used to keep a ship's firing animation on for as long as
// the beam is actually firing, not just while the fire key is held.
const ActiveBeamsQuery = new Query(
    [SourceComponent, BeamDataComponent] as const, 'ActiveBeamsQuery');

/**
 * Whether the given ship should show its firing animation (weapon image).
 *
 * The animation is on while a weapon whose `useFiringAnimation` flag is set is
 * being fired, and also while any beam fired by this ship is still being
 * emitted. Beams keep firing (for their shot duration) after the fire key is
 * released, so we key their part of the animation off the beam entities that
 * actually exist rather than off the fire input.
 */
export function shouldShowFiringAnimation(
    uuid: string,
    weaponStates: Iterable<[string, { firing: boolean }]>,
    useFiringAnimation: (weaponId: string) => boolean | undefined,
    activeBeams: Iterable<readonly [string, unknown]>,
): boolean {
    for (const [id, weaponState] of weaponStates) {
        if (weaponState.firing && useFiringAnimation(id)) {
            return true;
        }
    }

    for (const [source] of activeBeams) {
        if (source === uuid) {
            return true;
        }
    }

    return false;
}

/** shän animation timings are in 30ths of a second (Bible: AnimDelay "in
 * 30ths of a second"); WeapDecay shares that frame unit. */
const SHAN_FRAMES_PER_SECOND = 30;

/**
 * How much weapon-overlay alpha the shän's WeapDecay burns per second.
 *
 * Bible (shän WeapDecay): "The rate at which the weapon glow sprite fades
 * out to transparency, if applicable. 50 is a good median number - lower
 * numbers yield slower decays." It says nothing about units, but stock
 * values span exactly 0..100 (histogram over all 111 stock shäns with a
 * weapImage: 0x3 3x3 5x35 10x19 25x1 30x9 50x17 75x18 100x6), so it reads
 * as percent of full alpha per animation frame: 100 fades in one frame
 * (~33 ms), the Bible's median 50 in two (~67 ms), and the most common
 * stock value 5 — the Fed Destroyer family, shäns nova:141 and nova:214
 * ("Fed Destroyer; Carrier") — in twenty (~0.67 s). WeapDecay 0 means no
 * fade at all; the overlay snaps off when firing stops (the behaviour
 * before decay existed).
 *
 * NOT the Fed Carrier: shäns nova:143 and nova:218-222 ("Fed Carrier",
 * base rlëD nova:1030) define no WeapImage at all and carry WeapDecay 0,
 * so that ship has no weapon-effect overlay to fade — see
 * shouldShowFiringAnimation's caller, which is gated on the sprite
 * existing, and the ShanParse regression spec that pins it.
 */
export function weapDecayAlphaPerSecond(weapDecay: number): number {
    return Math.max(0, weapDecay) / 100 * SHAN_FRAMES_PER_SECOND;
}

/**
 * Advances the weapon-effect overlay's alpha one display frame: firing
 * snaps it to fully opaque, and otherwise it decays linearly toward
 * transparent at `alphaPerSecond`. An alphaPerSecond of 0 (WeapDecay 0)
 * means "no fade", i.e. straight to 0.
 */
export function advanceWeaponFlash(alpha: number, firing: boolean,
    alphaPerSecond: number, deltaS: number): number {
    if (firing) {
        return 1;
    }
    if (alphaPerSecond <= 0) {
        return 0;
    }
    return Math.max(0, alpha - alphaPerSecond * deltaS);
}

export const ShipAnimationSystem = new System({
    name: "ShipAnimationSystem",
    args: [ShipComponent, WeaponsStateComponent, SimulationGameDataResource,
        AnimationGraphicComponent, TimeResource, IsIonizedComponent,
        IonizationColorComponent, Optional(CloakActiveComponent),
        Optional(DisabledComponent), PlayerScannerQuery, GetEntity, UUID,
        ActiveBeamsQuery] as const,
    step(ship, weaponStates, gameData, animation, time, ionized, ionizationColor,
        cloakActive, disabled, playerScanners, entity, uuid, activeBeams) {
        // For now, always hide the ship's shield.
        // TODO: Blink this when hit.
        const shield = animation.sprites.get('shieldImage');
        if (shield) {
            shield.pixiSprite.visible = false;
        }

        // Draw the ship's weapon-effect overlay (shän WeapImage: the Fed
        // Destroyer's muzzle flashes) on top of the hull while it fires,
        // then fade it back out at the shän's WeapDecay rate. The overlay
        // is an additive sprite in the same graphic as the base image, so
        // ObjectDrawSystem's rotation write and (for multi-set ships like
        // the Manticore) ShipBaseSetAnimationSystem's selectBaseSet keep
        // it frame-aligned with the hull for free.
        if (animation.sprites.has('weapImage')) {
            const firing = shouldShowFiringAnimation(
                uuid, weaponStates,
                id => gameData.data.Weapon.getCached(id)?.useFiringAnimation,
                activeBeams);
            animation.weaponFlashAlpha = advanceWeaponFlash(
                animation.weaponFlashAlpha, firing,
                weapDecayAlphaPerSecond(animation.weapDecay), time.delta_s);
            animation.weapAlpha = animation.weaponFlashAlpha;
        }

        // Flash the running lights per the ship's shän blink pattern (steady,
        // square strobe, triangle pulse, or random). A per-ship phase offset
        // from the uuid keeps a fleet of identical ships from blinking in
        // unison. A disabled ship's lights go dark entirely (dead in space;
        // EVN Bible ship disabling). Display-only; no sim state involved.
        const runningLights = animation.sprites.get('lightImage');
        if (runningLights) {
            const light = runningLightState(
                animation.blink, time.time, blinkPhaseFromUuid(uuid));
            runningLights.pixiSprite.visible = !disabled && light.visible;
            runningLights.pixiSprite.alpha = light.alpha;
        }

        const sprite = animation.sprites.get('baseImage')?.pixiSprite;
        if (sprite) {
            if (ionized) {
                sprite.tint = ionizationColor.color & 0xFFFFFF;
            } else {
                sprite.tint = 0xffffff;
            }
        }

        // Cloak transparency (display-only). A cloaked ship fades toward
        // invisible; your own ship stays a faint ghost so you can fly it.
        // If the local player has a cloak scanner that reveals cloaked
        // ships on screen (ModVal 0x0002), other cloaked ships show as a
        // faint ghost instead of vanishing.
        if (cloakActive?.active) {
            const isPlayerShip = entity.components.has(PlayerShipSelector);
            const playerRevealsOnScreen =
                playerScanners[0]?.[1]?.revealsOnScreen === true;
            if (isPlayerShip) {
                animation.container.alpha = CLOAKED_ALPHA_SELF;
            } else if (playerRevealsOnScreen) {
                animation.container.alpha = CLOAKED_ALPHA_REVEALED;
            } else {
                animation.container.alpha = CLOAKED_ALPHA_OTHER;
            }
        } else {
            animation.container.alpha = UNCLOAKED_ALPHA;
        }
    },
});

/**
 * Which base sprite set a continuously-animating ship (shän 0x0008) shows
 * at time `timeMs`: the sets advance `setsPerSecond` per second and wrap.
 * Returned UNwrapped (a monotonically increasing raw index); the caller
 * mods it by each sprite sheet's own set count, so the base image and the
 * alt-image overlay each cycle through however many sets they hold.
 */
export function continuousRawSet(timeMs: number, setsPerSecond: number): number {
    return Math.floor((timeMs / 1000) * setsPerSecond);
}

/**
 * Which base sprite set a folding ship (shän 0x0002) shows at fold
 * `progress` in [0, 1], mapped linearly and clamped.
 *
 * The stock fold art runs UNFOLDED -> FOLDED, i.e. **set 0 is the fully
 * DEPLOYED pose and the LAST set is the folded rest pose**, so progress
 * (0 = folded, 1 = unfolded — the FoldStateComponent's meaning, which the
 * WeaponsSystem fire gate depends on) maps to the sets in REVERSE. The
 * Bible never states which end of the sequence is which (see 0x0002: the
 * extra frames "are used for animated ship parts such as for
 * folding/unfolding wings", and "will be cycled" on landing/takeoff and
 * hyperspace, with no start/end frame specified), so this is pinned to the
 * actual rlëD art instead:
 *
 * - Argosy (nova:138, shän base rlëD nova:1020, 6 sets of 36): set 0 has
 *   the side nacelles splayed OUT away from the hull; set 5 has them
 *   tucked flush IN against it. The Argosy sits with its nacelles in and
 *   spreads them for hyperspace, so rest = set 5.
 * - Asteroid Miner (extra-outfits:807, base rlëD nova:1128, 6 sets of 36):
 *   set 0 has the claws swept wide OPEN, set 5 has them wrapped tight
 *   against the body. The miner rests wrapped and unwraps to fire, so
 *   rest = set 5 and the fire gate's "fully unfolded" = set 0.
 *
 * See ship_animation_test.ts, which pins both of these.
 */
export function foldSetIndex(progress: number, baseSetCount: number): number {
    const lastSet = Math.max(0, baseSetCount - 1);
    const clampedProgress = Math.min(1, Math.max(0, progress));
    const index = Math.round((1 - clampedProgress) * lastSet);
    return Math.min(lastSet, Math.max(0, index));
}

/**
 * Advances an Argosy-style jump-folding ship's DISPLAY fold progress toward
 * unfolded while it is in a hyperspace jump and back toward folded
 * otherwise, at the shän AnimDelay rate. Display-only (jump folding gates
 * nothing); miner claws use the sim FoldStateComponent instead.
 */
export function advanceJumpFold(graphic: AnimationGraphic,
    mode: ShipAnimationMode, jumping: boolean, deltaS: number): number {
    const target = jumping ? 1 : 0;
    graphic.foldProgress = moveToward(graphic.foldProgress, target,
        foldRatePerSecond(mode) * deltaS);
    return graphic.foldProgress;
}

/**
 * Drives the ship base-set animation — the third and last write to a ship
 * graphic's frames each display tick, after ObjectDrawSystem has set the
 * heading (rotation) and normal/left/right set. It composes the animation
 * SET with that heading: every base set is a full FramesPer-frame rotation
 * set, so selectBaseSet() picks the set and re-derives the frame within it.
 *
 *  - continuous (0x0008): the sets (and the alt-image overlay) cycle on
 *    logical time — spinning rings (Leviathan, Manticore, Thunderforge).
 *  - folding (0x0002): the sets are a fold sequence, running DEPLOYED
 *    (set 0) -> FOLDED (last set) in the stock art; see foldSetIndex.
 *    Miner claws (unfoldWhenFiring) read the synced sim
 *    FoldStateComponent so the graphic matches the fire gate exactly;
 *    every other folding ship (the Argosy) folds display-side off its
 *    jump state.
 *
 * Disabled honoring: stopWhenDisabled freezes a continuous animation at
 * its rest set; hideAltWhenDisabled hides the alt overlay.
 *
 * Documented seams (checked against ALL stock shäns):
 * - Landing/takeoff folding: the Bible also cycles the fold on landing
 *   and takeoff, but NovaJS's landing is instant (no takeoff sequence),
 *   so the fold keys only off the hyperspace jump state. N/A until a
 *   takeoff sequence exists.
 * - Inherent alt-overlay cycling WITHOUT 0x0008: the Bible says the alt
 *   image always cycles at AnimDelay. The only stock ship with an alt
 *   image (Aurora Thunderforge, shän 380) is ALSO 0x0008, which this
 *   system's continuous path covers (it cycles every multi-set sprite,
 *   the alt overlay included), so no stock content exercises a
 *   non-0x0008 overlay and that path is deliberately not built.
 * - keyCarried (0x0004): no stock shän sets it; the parse emits the
 *   mode but no display consumer exists. Wiring it up means reading the
 *   synced outfit/bay state for the shïp's KeyCarried type and calling
 *   selectBaseSet(1) here.
 */
export const ShipBaseSetAnimationSystem = new System({
    name: "ShipBaseSetAnimationSystem",
    args: [ShipComponent, AnimationComponent, AnimationGraphicComponent,
        TimeResource, Optional(JumpComponent), Optional(FoldStateComponent),
        Optional(DisabledComponent)] as const,
    step(_ship, animation, graphic, time, jump, foldState, disabled) {
        const mode = animation.animationMode;
        if (!mode) {
            return; // Plain rotation-only or banking ship: nothing to do.
        }

        if (mode.purpose === 'continuous') {
            const frozen = !!disabled && mode.stopWhenDisabled;
            const rawSet = frozen
                ? 0 : continuousRawSet(time.time, mode.setsPerSecond);
            for (const sprite of graphic.sprites.values()) {
                const sets = sprite.setCountForFramesPer(mode.framesPer);
                if (sets <= 1) {
                    continue; // Single-set sprite: leave rotation as-is.
                }
                sprite.selectBaseSet(rawSet % sets, mode.framesPer);
            }
        } else if (mode.purpose === 'folding') {
            // Miner claws are sim-gated; other folding ships fold on jump.
            const progress = mode.unfoldWhenFiring
                ? (foldState?.progress ?? 0)
                : advanceJumpFold(graphic, mode, jump !== undefined,
                    time.delta_s);
            const setIndex = foldSetIndex(progress, mode.baseSetCount);
            for (const sprite of graphic.sprites.values()) {
                if (sprite.setCountForFramesPer(mode.framesPer) <= 1) {
                    continue;
                }
                sprite.selectBaseSet(setIndex, mode.framesPer);
            }
        }
        // keyCarried (0x0004) is a documented seam (see plugin docs).

        // Hide the alt-image overlay while disabled, if the ship asks for it.
        if (mode.hideAltWhenDisabled) {
            const alt = graphic.sprites.get('altImage');
            if (alt) {
                alt.pixiSprite.visible = !disabled;
            }
        }
    },
    after: [ObjectDrawSystem],
});

export const ShipAnimationPlugin: Plugin = {
    name: "ShipAnimationPlugin",
    build(world) {
        world.addSystem(ShipAnimationSystem);
        world.addSystem(ShipBaseSetAnimationSystem);
    },
    remove(world) {
        world.removeSystem(ShipAnimationSystem);
        world.removeSystem(ShipBaseSetAnimationSystem);
    }
}
