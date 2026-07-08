import { Entities } from "nova_ecs/arg_types";
import { Plugin } from "nova_ecs/plugin";
import { MovementState, MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { System } from "nova_ecs/system";
import { SingletonComponent } from "nova_ecs/world";
import { v4 } from "uuid";
import { AsteroidBreakEvent, AsteroidComponent, DebrisComponent } from "../nova_plugin/asteroid_plugin.js";
import { DisplayAssetDataResource } from "../nova_plugin/game_data_resource.js";
import { AnimationGraphic } from "./animation_graphic.js";
import { AnimationGraphicComponent, ObjectDrawSystem } from "./animation_graphic_plugin.js";
import { makeExplosion } from "./explosion_plugin.js";

/** How long a fading resource-box takes to disappear, ms. */
const DEBRIS_FADE_MS = 3000;
/**
 * Resource-boxes render as chunks of the asteroid that broke: its own
 * sprite at this scale (asteroid sprites are 50x50, so chunks are
 * ~17 px — clearly visible, unlike the Bible's 8x8 box sprites).
 */
const DEBRIS_SCALE = 0.35;

/** Shows a röid's explosion when an asteroid breaks apart. */
const AsteroidExplosionSystem = new System({
    name: 'AsteroidExplosionSystem',
    events: [AsteroidBreakEvent],
    args: [AsteroidBreakEvent, DisplayAssetDataResource, Entities,
        SingletonComponent] as const,
    step(breakEvent, gameData, entities) {
        if (!breakEvent.explosion) {
            return;
        }
        const explosionData =
            gameData.data.Explosion.getCached(breakEvent.explosion);
        if (!explosionData) {
            // Kicked off a background load; the next breakup shows it.
            return;
        }
        entities.set(v4(),
            makeExplosion(explosionData, breakEvent.position));
    },
});

/**
 * Draws a tumbling body. Asteroid sprite frames are a pre-rendered 3D
 * tumble sequence, NOT view rotations, so the generic ObjectDrawSystem
 * mapping (rotation -> nearest frame + residual screen-space rotation)
 * composes two different rotations and looks wrong. Instead the sim's
 * rotation angle is the tumble phase: it picks the frame directly, one
 * full revolution playing the sequence once, with no screen-space
 * rotation at all. Runs after ObjectDrawSystem to override it.
 */
function drawTumble(movement: MovementState, graphic: AnimationGraphic) {
    // [-pi, pi) -> [0, 1)
    const phase = (movement.rotation.angle + Math.PI) / (2 * Math.PI);
    for (const sprite of graphic.sprites.values()) {
        if (sprite.frames <= 0) {
            continue; // Textures still loading.
        }
        sprite.frame = Math.min(sprite.frames - 1,
            Math.floor(phase * sprite.frames));
        sprite.pixiSprite.rotation = 0;
    }
}

const AsteroidTumbleSystem = new System({
    name: 'AsteroidTumbleSystem',
    args: [AsteroidComponent, MovementStateComponent,
        AnimationGraphicComponent] as const,
    step(_asteroid, movement, graphic) {
        drawTumble(movement, graphic);
    },
    after: [ObjectDrawSystem],
});

/** Tumbles, scales, and fades resource-boxes. */
const DebrisDrawSystem = new System({
    name: 'DebrisDrawSystem',
    args: [DebrisComponent, MovementStateComponent, AnimationGraphicComponent,
        TimeResource] as const,
    step(debris, movement, graphic, time) {
        drawTumble(movement, graphic);
        graphic.container.scale.set(DEBRIS_SCALE);
        const remaining = debris.expires - time.time;
        graphic.container.alpha =
            Math.max(0, Math.min(1, remaining / DEBRIS_FADE_MS));
    },
    after: [ObjectDrawSystem],
});

export const AsteroidDisplayPlugin: Plugin = {
    name: 'AsteroidDisplayPlugin',
    build(world) {
        world.addSystem(AsteroidExplosionSystem);
        world.addSystem(AsteroidTumbleSystem);
        world.addSystem(DebrisDrawSystem);
    },
    remove(world) {
        world.removeSystem(AsteroidExplosionSystem);
        world.removeSystem(AsteroidTumbleSystem);
        world.removeSystem(DebrisDrawSystem);
    },
};
