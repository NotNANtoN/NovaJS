import { GetEntity } from "nova_ecs/arg_types";
import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { System } from "nova_ecs/system";
import { SimulationGameDataResource } from "../nova_plugin/game_data_resource.js";
import { CloakActiveComponent } from "../nova_plugin/cloak_plugin.js";
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
const UNCLOAKED_ALPHA = 1.0;


export const ShipAnimationSystem = new System({
    name: "ShipAnimationSystem",
    args: [ShipComponent, WeaponsStateComponent, SimulationGameDataResource,
        AnimationGraphicComponent, TimeResource, IsIonizedComponent,
        IonizationColorComponent, Optional(CloakActiveComponent),
        GetEntity] as const,
    step(ship, weaponStates, gameData, animation, time, ionized, ionizationColor,
        cloakActive, entity) {
        // For now, always hide the ship's shield.
        // TODO: Blink this when hit.
        const shield = animation.sprites.get('shieldImage');
        if (shield) {
            shield.pixiSprite.visible = false;
        }

        // Show the ship's weapon image iff a weapon is firing.
        const weaponImage = animation.sprites.get('weapImage');
        if (weaponImage) {
            weaponImage.pixiSprite.visible = false;
            for (const [id, weaponState] of weaponStates) {
                if (weaponState.firing && gameData.data.Weapon.getCached(id)?.useFiringAnimation) {
                    weaponImage.pixiSprite.visible = true;
                    break;
                }
            }
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
        if (cloakActive?.active) {
            const isPlayerShip = entity.components.has(PlayerShipSelector);
            animation.container.alpha =
                isPlayerShip ? CLOAKED_ALPHA_SELF : CLOAKED_ALPHA_OTHER;
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
