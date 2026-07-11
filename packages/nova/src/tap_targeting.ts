import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { World } from 'nova_ecs/world';
import { Space } from './display/space_resource.js';
import { PlanetComponent } from './nova_plugin/planet_plugin.js';
import { ControlledByComponent } from './nova_plugin/ship_control.js';
import { ShipComponent } from './nova_plugin/ship_plugin.js';

/**
 * Tap (or click — this works with a mouse too) on the game view:
 * - on a ship: target it,
 * - on a planet: autopilot to it and land.
 *
 * Purely a picker: it translates screen taps into "target uuid X" /
 * "navigate to uuid Y" and leaves the acting to the caller.
 */

export interface TapHandlers {
    getWorld(): World | undefined;
    getMyPeerId(): string | undefined;
    targetShip(uuid: string): void;
    navigateToPlanet(uuid: string): void;
}

/** How close (world units ≈ px) a tap must be to count as a hit. */
const SHIP_PICK_RADIUS = 45;
const PLANET_PICK_RADIUS = 70;
/** Longer presses / larger drags are not taps. */
const TAP_MS = 400;
const TAP_SLOP_PX = 12;

function pickNearest(world: World, myPeerId: string | undefined,
    worldX: number, worldY: number) {
    let bestShip: { uuid: string, distance: number } | undefined;
    let bestPlanet: { uuid: string, distance: number } | undefined;
    for (const [uuid, entity] of world.entities) {
        const movement = entity.components.get(MovementStateComponent);
        if (!movement) {
            continue;
        }
        const isShip = entity.components.has(ShipComponent);
        const isPlanet = entity.components.has(PlanetComponent);
        if (!isShip && !isPlanet) {
            continue;
        }
        if (isShip && entity.components.get(ControlledByComponent)?.peerId
            === myPeerId && myPeerId !== undefined) {
            continue; // Don't target your own ship.
        }
        const distance = Math.hypot(movement.position.x - worldX,
            movement.position.y - worldY);
        if (isShip && distance <= SHIP_PICK_RADIUS
            && (!bestShip || distance < bestShip.distance)) {
            bestShip = { uuid, distance };
        }
        if (isPlanet && distance <= PLANET_PICK_RADIUS
            && (!bestPlanet || distance < bestPlanet.distance)) {
            bestPlanet = { uuid, distance };
        }
    }
    return { bestShip, bestPlanet };
}

export function installTapTargeting(view: HTMLElement,
    handlers: TapHandlers): void {
    let start: {
        pointerId: number, x: number, y: number, time: number,
    } | undefined;

    view.addEventListener('pointerdown', event => {
        // Track single-pointer presses only; a second finger (pinch,
        // button press) voids the tap.
        start = start ? undefined : {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            time: performance.now(),
        };
    });
    view.addEventListener('pointerup', event => {
        const press = start;
        if (!press || event.pointerId !== press.pointerId) {
            return;
        }
        start = undefined;
        if (performance.now() - press.time > TAP_MS
            || Math.hypot(event.clientX - press.x,
                event.clientY - press.y) > TAP_SLOP_PX) {
            return;
        }
        const world = handlers.getWorld();
        const space = world?.resources.get(Space);
        if (!world || !space) {
            return;
        }
        // The camera only translates (CenterShipSystem sets position;
        // no zoom or rotation), so screen → world is a subtraction.
        const worldX = event.clientX - space.position.x;
        const worldY = event.clientY - space.position.y;
        const { bestShip, bestPlanet } = pickNearest(
            world, handlers.getMyPeerId(), worldX, worldY);
        if (bestShip) {
            handlers.targetShip(bestShip.uuid);
        } else if (bestPlanet) {
            handlers.navigateToPlanet(bestPlanet.uuid);
        }
    });
    view.addEventListener('pointercancel', () => {
        start = undefined;
    });
}
