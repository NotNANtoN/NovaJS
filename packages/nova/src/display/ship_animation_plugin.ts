import { GetEntity, UUID } from "nova_ecs/arg_types";
import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { Query } from "nova_ecs/query";
import { System } from "nova_ecs/system";
import { BeamDataComponent } from "../nova_plugin/beam_plugin.js";
import { SourceComponent } from "../nova_plugin/fire_weapon_plugin.js";
import { SimulationGameDataResource } from "../nova_plugin/game_data_resource.js";
import { CloakActiveComponent, CloakScannerComponent } from "../nova_plugin/cloak_plugin.js";
import { IonizationColorComponent } from "../nova_plugin/health_plugin.js";
import { IsIonizedComponent } from "../nova_plugin/ionization_plugin.js";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin.js";
import { ShipComponent } from "../nova_plugin/ship_plugin.js";
import { WeaponsStateComponent } from "../nova_plugin/weapons_state.js";
import { AnimationGraphicComponent } from "./animation_graphic_plugin.js";

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

export const ShipAnimationSystem = new System({
    name: "ShipAnimationSystem",
    args: [ShipComponent, WeaponsStateComponent, SimulationGameDataResource,
        AnimationGraphicComponent, TimeResource, IsIonizedComponent,
        IonizationColorComponent, Optional(CloakActiveComponent),
        PlayerScannerQuery, GetEntity, UUID, ActiveBeamsQuery] as const,
    step(ship, weaponStates, gameData, animation, time, ionized, ionizationColor,
        cloakActive, playerScanners, entity, uuid, activeBeams) {
        // For now, always hide the ship's shield.
        // TODO: Blink this when hit.
        const shield = animation.sprites.get('shieldImage');
        if (shield) {
            shield.pixiSprite.visible = false;
        }

        // Show the ship's weapon image iff a weapon is firing.
        const weaponImage = animation.sprites.get('weapImage');
        if (weaponImage) {
            weaponImage.pixiSprite.visible = shouldShowFiringAnimation(
                uuid, weaponStates,
                id => gameData.data.Weapon.getCached(id)?.useFiringAnimation,
                activeBeams);
        }

        // Blink running lights every two seconds.
        const runningLights = animation.sprites.get('lightImage');
        if (runningLights) {
            runningLights.pixiSprite.visible = time.time % 2000 < 1000;
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

export const ShipAnimationPlugin: Plugin = {
    name: "ShipAnimationPlugin",
    build(world) {
        world.addSystem(ShipAnimationSystem);
    }
}
