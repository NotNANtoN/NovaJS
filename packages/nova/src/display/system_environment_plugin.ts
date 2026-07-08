import { Plugin } from "nova_ecs/plugin";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { Query } from "nova_ecs/query";
import { Resource } from "nova_ecs/resource";
import { System } from "nova_ecs/system";
import { SimulationGameDataResource } from "../nova_plugin/game_data_resource.js";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin.js";
import { SystemIdResource } from "../nova_plugin/system_id_resource.js";
import { AnimationGraphicComponent, ObjectDrawSystem } from "./animation_graphic_plugin.js";
import { PixiAppResource } from "./pixi_app_resource.js";
import { StarfieldResource } from "./starfield_plugin.js";

/**
 * Per-system visual environment: background colour and murk.
 *
 * Both are static per-system data (from the sÿst resource), read here
 * display-side so they never touch the deterministic simulation. See the
 * EVN Bible's sÿst docs for the semantics:
 *  - Background colour renders behind the starfield (black if zero).
 *  - Murk (0-100) fogs space objects: the farther an object is from the
 *    player's ship, the more it fades into the background colour, and murk
 *    controls how aggressive that falloff is. A negative murk value is
 *    treated as zero murk but also hides the starfield.
 */

/** How murk is currently being applied, and the hook outfits use to modify it. */
export interface MurkState {
    /** The system's base murk (0-100), straight from the sÿst resource. */
    readonly systemMurk: number;
    /**
     * Amount of murk removed by outfits (the "murk modifier" outfit
     * modifier, EVN Bible / ResForge outf case 28: "the amount by which to
     * increase or decrease the current system's murkiness level"). Positive
     * clears murk (extending how far the player can see); negative deepens
     * it. The effective murk is clamped to 0-100. Defaults to 0; an outfit
     * hook can change it.
     */
    murkReduction: number;
}

export const MurkResource = new Resource<MurkState>('Murk');

/** The effective murk after outfit reductions, clamped to 0-100. */
export function effectiveMurk(murk: MurkState): number {
    return Math.max(0, Math.min(100, murk.systemMurk - murk.murkReduction));
}

/**
 * The distance (in Nova pixels) beyond which objects vanish entirely under
 * full (100) murk. Lower murk scales this range up proportionally.
 */
export const FULL_MURK_VANISH_DISTANCE = 300;

/**
 * How much of an object murk leaves visible at a given distance from the
 * player's ship, as an alpha in [0, 1].
 *
 * Objects vanish completely at
 *     vanish = FULL_MURK_VANISH_DISTANCE * (100 / murk)
 * so the vanishing range is inversely proportional to the effective murk
 * (murk 100 -> 300px, murk 50 -> 600px, murk -> 0 -> unbounded). The nearer
 * half of that range renders fully; alpha then falls linearly to zero across
 * the outer half:
 *     alpha = 1                             for d <= vanish / 2
 *     alpha = (vanish - d) / (vanish / 2)   for vanish / 2 < d < vanish
 *     alpha = 0                             for d >= vanish
 *
 * Because the renderer background is already the system's background colour,
 * fading alpha toward zero blends the object into that colour with no
 * per-pixel tint math. Murk-clearing outfits (murkReduction) lower the
 * effective murk, which extends the vanishing range and softens the falloff.
 */
export function murkAlpha(distance: number, murk: MurkState): number {
    const m = effectiveMurk(murk);
    if (m <= 0) {
        return 1;
    }
    const vanish = FULL_MURK_VANISH_DISTANCE * (100 / m);
    const clear = vanish / 2;
    if (distance <= clear) {
        return 1;
    }
    if (distance >= vanish) {
        return 0;
    }
    return (vanish - distance) / (vanish - clear);
}

const PlayerPositionQuery =
    new Query([MovementStateComponent, PlayerShipSelector] as const);

/**
 * Fades each space object into the background colour based on its distance
 * from the player's ship. The player's own ship is at distance zero, so it
 * always renders fully. Runs every frame after ObjectDrawSystem so pooled
 * graphics reacquired by new entities pick up the right alpha immediately.
 */
const MurkFadeSystem = new System({
    name: 'MurkFadeSystem',
    args: [MurkResource, AnimationGraphicComponent, MovementStateComponent,
        PlayerPositionQuery] as const,
    step(murk, graphic, movementState, players) {
        const player = players[0];
        if (!player) {
            graphic.container.alpha = 1;
            return;
        }
        const [{ position: playerPosition }] = player;
        const distance = movementState.position
            .subtract(playerPosition).length;
        graphic.container.alpha = murkAlpha(distance, murk);
    },
    after: [ObjectDrawSystem],
});

export const SystemEnvironmentPlugin: Plugin = {
    name: 'SystemEnvironment',
    async build(world) {
        const gameData = world.resources.get(SimulationGameDataResource);
        if (!gameData) {
            throw new Error('Expected SimulationGameData resource to exist');
        }
        const systemId = world.resources.get(SystemIdResource);
        if (!systemId) {
            throw new Error('Expected SystemId resource to exist');
        }
        const app = world.resources.get(PixiAppResource);
        if (!app) {
            throw new Error('Expected PIXI App resource to exist');
        }

        const systemData = await gameData.data.System.get(systemId);

        // Background colour: renders behind everything, and is what murk
        // fades objects into. Zero is pure black, which is also PIXI's
        // default, so a normal system looks unchanged.
        app.renderer.background.color = systemData.backgroundColor;

        // A negative murk value hides the starfield (Bible: "less than zero
        // is equivalent to zero murk but also hides the starfield").
        if (systemData.murk < 0) {
            const starfield = world.resources.get(StarfieldResource);
            if (starfield) {
                starfield.container.visible = false;
            }
        }

        world.resources.set(MurkResource, {
            systemMurk: Math.max(0, systemData.murk),
            murkReduction: 0,
        });
        world.addSystem(MurkFadeSystem);
    },
    remove(world) {
        world.removeSystem(MurkFadeSystem);

        const app = world.resources.get(PixiAppResource);
        if (app) {
            app.renderer.background.color = 0x000000;
        }

        world.resources.delete(MurkResource);
    }
};
