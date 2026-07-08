import { Plugin } from "nova_ecs/plugin";
import { Resource } from "nova_ecs/resource";
import { System } from "nova_ecs/system";
import * as PIXI from "pixi.js";
import { SimulationGameDataResource } from "../nova_plugin/game_data_resource.js";
import { SystemIdResource } from "../nova_plugin/system_id_resource.js";
import { PixiAppResource } from "./pixi_app_resource.js";
import { ResizeEvent } from "./screen_size_plugin.js";
import { Stage } from "./stage_resource.js";
import { StarfieldResource } from "./starfield_plugin.js";

/**
 * Per-system visual environment: background colour and murk.
 *
 * Both are static per-system data (from the sÿst resource), read here
 * display-side so they never touch the deterministic simulation. See the
 * EVN Bible's sÿst docs for the semantics:
 *  - Background colour renders behind the starfield (black if zero).
 *  - Murk (0-100) fogs the whole view toward the background colour. A
 *    negative murk value is treated as zero murk but also hides the
 *    starfield.
 */

/** How murk is currently being applied, and the hook outfits use to modify it. */
export interface MurkState {
    /** The system's base murk (0-100), straight from the sÿst resource. */
    readonly systemMurk: number;
    /**
     * Amount of murk removed by outfits (the "murk modifier" outfit
     * modifier, EVN Bible / ResForge outf case 28: "the amount by which to
     * increase or decrease the current system's murkiness level"). Positive
     * clears murk; negative deepens it. The effective murk is clamped to
     * 0-100. Defaults to 0; an outfit hook can change it.
     */
    murkReduction: number;
}

export const MurkResource = new Resource<MurkState>('Murk');

/** The effective murk after outfit reductions, clamped to 0-100. */
export function effectiveMurk(murk: MurkState): number {
    return Math.max(0, Math.min(100, murk.systemMurk - murk.murkReduction));
}

/**
 * The strongest haze murk applies, as an alpha over the whole view. Murk 100
 * does not fully hide the scene (the player can still fly), matching Nova's
 * "question their glasses prescription" rather than a total whiteout.
 */
const MAX_MURK_ALPHA = 0.85;

class MurkVeil {
    /** A full-screen rectangle tinted to the background colour. */
    readonly graphics = new PIXI.Graphics();
    private width = window.innerWidth;
    private height = window.innerHeight;

    constructor(private color: number, private murk: MurkState) {
        this.graphics.name = 'MurkVeil';
        this.redraw();
    }

    resize(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.redraw();
    }

    /** Recompute the veil after murk, size, or reductions change. */
    redraw() {
        const alpha = (effectiveMurk(this.murk) / 100) * MAX_MURK_ALPHA;
        this.graphics.clear();
        this.graphics.visible = alpha > 0;
        if (alpha <= 0) {
            return;
        }
        this.graphics.beginFill(this.color, alpha);
        this.graphics.drawRect(0, 0, this.width, this.height);
        this.graphics.endFill();
    }
}

const MurkVeilResource = new Resource<MurkVeil>('MurkVeil');

const MurkResize = new System({
    name: 'MurkResize',
    events: [ResizeEvent],
    args: [MurkVeilResource, ResizeEvent] as const,
    step(veil, { x, y }) {
        veil.resize(x, y);
    }
});

const UpdateMurk = new System({
    name: 'UpdateMurk',
    args: [MurkVeilResource] as const,
    step(veil) {
        // Cheap: redraw only clears and refills a single rectangle, and
        // outfit hooks change murkReduction rarely. Keeping it per-frame
        // means murk-modifier outfits take effect immediately.
        veil.redraw();
    }
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
        const stage = world.resources.get(Stage);
        if (!stage) {
            throw new Error('Expected Stage resource to exist');
        }
        const app = world.resources.get(PixiAppResource);
        if (!app) {
            throw new Error('Expected PIXI App resource to exist');
        }

        const systemData = await gameData.data.System.get(systemId);

        // Background colour: renders behind everything. Zero is pure black,
        // which is also PIXI's default, so a normal system looks unchanged.
        app.renderer.background.color = systemData.backgroundColor;

        // A negative murk value hides the starfield (Bible: "less than zero
        // is equivalent to zero murk but also hides the starfield").
        if (systemData.murk < 0) {
            const starfield = world.resources.get(StarfieldResource);
            if (starfield) {
                starfield.container.visible = false;
            }
        }

        const murkState: MurkState = {
            systemMurk: Math.max(0, systemData.murk),
            murkReduction: 0,
        };
        world.resources.set(MurkResource, murkState);

        // The veil hazes the view toward the background colour. It sits above
        // the space/starfield but below the status bar, which is added to the
        // stage after this plugin.
        const veil = new MurkVeil(systemData.backgroundColor, murkState);
        stage.addChild(veil.graphics);
        world.resources.set(MurkVeilResource, veil);
        world.addSystem(MurkResize);
        world.addSystem(UpdateMurk);
    },
    remove(world) {
        world.removeSystem(UpdateMurk);
        world.removeSystem(MurkResize);

        const app = world.resources.get(PixiAppResource);
        if (app) {
            app.renderer.background.color = 0x000000;
        }

        const stage = world.resources.get(Stage);
        const veil = world.resources.get(MurkVeilResource);
        if (stage && veil) {
            stage.removeChild(veil.graphics);
        }
        world.resources.delete(MurkVeilResource);
        world.resources.delete(MurkResource);
    }
};
