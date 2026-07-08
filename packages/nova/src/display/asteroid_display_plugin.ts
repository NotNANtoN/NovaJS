import { Entities } from "nova_ecs/arg_types";
import { Plugin } from "nova_ecs/plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { System } from "nova_ecs/system";
import { SingletonComponent } from "nova_ecs/world";
import { v4 } from "uuid";
import { AsteroidBreakEvent, DebrisComponent } from "../nova_plugin/asteroid_plugin.js";
import { DisplayAssetDataResource } from "../nova_plugin/game_data_resource.js";
import { AnimationGraphicComponent } from "./animation_graphic_plugin.js";
import { makeExplosion } from "./explosion_plugin.js";

/** How long a fading resource-box takes to disappear, ms. */
const DEBRIS_FADE_MS = 3000;

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

/** Fades resource-boxes out over their last few seconds. */
const DebrisFadeSystem = new System({
    name: 'DebrisFadeSystem',
    args: [DebrisComponent, AnimationGraphicComponent, TimeResource] as const,
    step(debris, graphic, time) {
        const remaining = debris.expires - time.time;
        graphic.container.alpha =
            Math.max(0, Math.min(1, remaining / DEBRIS_FADE_MS));
    },
});

export const AsteroidDisplayPlugin: Plugin = {
    name: 'AsteroidDisplayPlugin',
    build(world) {
        world.addSystem(AsteroidExplosionSystem);
        world.addSystem(DebrisFadeSystem);
    },
    remove(world) {
        world.removeSystem(AsteroidExplosionSystem);
        world.removeSystem(DebrisFadeSystem);
    },
};
