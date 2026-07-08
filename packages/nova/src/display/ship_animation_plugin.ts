import { UUID } from "nova_ecs/arg_types";
import { Plugin } from "nova_ecs/plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { Query } from "nova_ecs/query";
import { System } from "nova_ecs/system";
import { BeamDataComponent } from "../nova_plugin/beam_plugin.js";
import { SourceComponent } from "../nova_plugin/fire_weapon_plugin.js";
import { SimulationGameDataResource } from "../nova_plugin/game_data_resource.js";
import { IonizationColorComponent } from "../nova_plugin/health_plugin.js";
import { IsIonizedComponent } from "../nova_plugin/ionization_plugin.js";
import { ShipComponent } from "../nova_plugin/ship_plugin.js";
import { WeaponsStateComponent } from "../nova_plugin/weapons_state.js";
import { AnimationGraphicComponent } from "./animation_graphic_plugin.js";


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
    args: [ShipComponent, WeaponsStateComponent, SimulationGameDataResource, AnimationGraphicComponent, TimeResource, IsIonizedComponent, IonizationColorComponent, UUID, ActiveBeamsQuery] as const,
    step(ship, weaponStates, gameData, animation, time, ionized, ionizationColor, uuid, activeBeams) {
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
    },
});

export const ShipAnimationPlugin: Plugin = {
    name: "ShipAnimationPlugin",
    build(world) {
        world.addSystem(ShipAnimationSystem);
    }
}
