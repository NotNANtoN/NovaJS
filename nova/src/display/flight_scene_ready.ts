import { Entity } from 'nova_ecs/entity';
import { AsteroidComponent } from '../nova_plugin/asteroid_plugin';
import { PlanetComponent } from '../nova_plugin/planet_plugin';
import { ShipComponent } from '../nova_plugin/ship_plugin';
import { AnimationGraphicComponent } from './animation_graphic_plugin';

export const FLIGHT_LOAD_TIMEOUT_MS = 8_000;
export const FLIGHT_SNAPSHOT_GRACE_MS = 250;
export const FLIGHT_STABLE_FRAMES = 2;

export interface FlightSceneReadiness {
    playerReady: boolean;
    planetsReady: boolean;
    drawnReady: boolean;
    drawableCount: number;
}

function needsFlightGraphic(entity: Entity): boolean {
    return entity.components.has(PlanetComponent)
        || entity.components.has(ShipComponent)
        || entity.components.has(AsteroidComponent);
}

export function flightSceneReadiness(
    entities: Iterable<readonly [string, Entity]>,
    playerUuid: string,
    expectedPlanetCount: number,
): FlightSceneReadiness {
    let planetCount = 0;
    let planetsDrawn = 0;
    let drawableCount = 0;
    let drawnCount = 0;
    let playerReady = false;

    for (const [uuid, entity] of entities) {
        if (uuid === playerUuid) {
            playerReady = entity.components.has(AnimationGraphicComponent);
        }
        if (entity.components.has(PlanetComponent)) {
            planetCount += 1;
            if (entity.components.has(AnimationGraphicComponent)) {
                planetsDrawn += 1;
            }
        }
        if (needsFlightGraphic(entity)) {
            drawableCount += 1;
            if (entity.components.has(AnimationGraphicComponent)) {
                drawnCount += 1;
            }
        }
    }

    return {
        playerReady,
        planetsReady: expectedPlanetCount <= 0
            ? true
            : planetCount >= expectedPlanetCount && planetsDrawn === planetCount,
        drawnReady: drawableCount > 0 && drawnCount === drawableCount,
        drawableCount,
    };
}

export function isFlightSceneReady(readiness: FlightSceneReadiness): boolean {
    // Nearby NPC hulls and asteroids keep streaming in after the snapshot.
    // Waiting for every sprite holds the cockpit on first load (and on
    // every jump) even when the player's ship and the planets are drawn.
    return readiness.playerReady && readiness.planetsReady;
}

export interface WaitForFlightScene {
    step: () => void;
    afterStep?: () => Promise<void>;
    entities: () => Iterable<readonly [string, Entity]>;
    playerUuid: string;
    expectedPlanetCount: number;
    snapshotRequested?: () => boolean;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
    snapshotGraceMs?: number;
    stableFrames?: number;
}

/**
 * Pump the world until the player's hull, every planet in the system, and
 * whatever else is already in the scene have sprites. A short grace after the
 * first snapshot request lets nearby replicated ships arrive before we decide
 * the set is complete.
 */
export async function waitForFlightScene(
    options: WaitForFlightScene,
): Promise<boolean> {
    const now = options.now ?? (() => Date.now());
    const sleep = options.sleep ?? (ms => new Promise(resolve => {
        setTimeout(resolve, ms);
    }));
    const timeoutMs = options.timeoutMs ?? FLIGHT_LOAD_TIMEOUT_MS;
    const snapshotGraceMs = options.snapshotGraceMs ?? FLIGHT_SNAPSHOT_GRACE_MS;
    const neededStable = options.stableFrames ?? FLIGHT_STABLE_FRAMES;
    const deadline = now() + timeoutMs;
    let requestedAt: number | undefined;
    let lastDrawable = -1;
    let stable = 0;

    while (now() < deadline) {
        options.step();
        if (options.afterStep) {
            const remaining = deadline - now();
            if (remaining <= 0) {
                break;
            }
            await Promise.race([options.afterStep(), sleep(remaining)]);
        }
        if (requestedAt === undefined && options.snapshotRequested?.()) {
            requestedAt = now();
        }
        const readiness = flightSceneReadiness(
            options.entities(),
            options.playerUuid,
            options.expectedPlanetCount,
        );
        const snapshotReady = options.snapshotRequested === undefined
            || (requestedAt !== undefined
                && now() - requestedAt >= snapshotGraceMs);
        if (isFlightSceneReady(readiness) && snapshotReady) {
            if (readiness.drawableCount === lastDrawable) {
                stable += 1;
            } else {
                stable = 0;
                lastDrawable = readiness.drawableCount;
            }
            if (stable >= neededStable) {
                return true;
            }
        } else {
            stable = 0;
            lastDrawable = readiness.drawableCount;
        }
        await sleep(16);
    }
    return false;
}
