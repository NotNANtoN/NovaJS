import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { System } from 'nova_ecs/system';
import * as PIXI from 'pixi.js';
import { JumpComponent, JUMP_ARRIVAL_DELAY_MS, JUMP_DEPART_DELAY_MS } from '../nova_plugin/jump_plugin.js';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin.js';
import { PixiAppResource } from './pixi_app_resource.js';

/** How quickly the overlay clears if a jump ends without the usual
 * arrival ramp (units of full-fades per second). */
const FALLBACK_FADE_RATE = 2;

// The overlay is a module-level singleton attached to the PIXI app's
// root stage rather than the per-system display world's stage: display
// worlds are torn down and rebuilt across a system transition, and the
// screen must stay white from the moment the departing world vanishes
// until the destination world has loaded and the arriving ship fades
// back in. Display-only state; never part of the simulation.
let overlay: PIXI.Graphics | undefined;
function getOverlay(): PIXI.Graphics {
    if (!overlay) {
        overlay = new PIXI.Graphics();
        overlay.name = 'JumpFadeOverlay';
        overlay.beginFill(0xffffff);
        overlay.drawRect(0, 0, 1, 1);
        overlay.endFill();
        overlay.alpha = 0;
        overlay.eventMode = 'none';
    }
    return overlay;
}

function clamp01(value: number) {
    return Math.min(1, Math.max(0, value));
}

/**
 * Fades the screen to white while the player's ship makes its
 * hyperspace departure burn, and back in as it sheds speed on arrival.
 * The fade tracks the jump stages synced from the simulation; between
 * the two worlds (while the destination loads) no player entity exists,
 * this system doesn't run, and the overlay simply stays white.
 */
const JumpFadeSystem = new System({
    name: 'JumpFadeSystem',
    args: [TimeResource, PixiAppResource, Optional(JumpComponent),
        PlayerShipSelector] as const,
    step(time, app, jump) {
        const overlay = getOverlay();
        // Keep the overlay above every display world's stage.
        if (app.stage.children[app.stage.children.length - 1] !== overlay) {
            app.stage.addChild(overlay);
        }
        overlay.width = app.screen.width;
        overlay.height = app.screen.height;

        let rate: number;
        if (jump?.stage === 'accelerating') {
            rate = 1000 / JUMP_DEPART_DELAY_MS;
        } else if (jump?.stage === 'arriving') {
            rate = -1000 / JUMP_ARRIVAL_DELAY_MS;
        } else {
            rate = -FALLBACK_FADE_RATE;
        }
        overlay.alpha = clamp01(overlay.alpha + rate * time.delta_s);
        overlay.visible = overlay.alpha > 0;
    }
});

export const JumpFadePlugin: Plugin = {
    name: 'JumpFadePlugin',
    build(world) {
        const app = world.resources.get(PixiAppResource);
        if (!app) {
            throw new Error('Expected PixiAppResource to exist');
        }
        app.stage.addChild(getOverlay());
        world.addSystem(JumpFadeSystem);
    },
    remove(world) {
        world.removeSystem(JumpFadeSystem);
        // The overlay intentionally stays attached to the app stage:
        // the display world is removed mid-jump, and the white cover
        // must persist until the destination world fades it back in.
    }
};
