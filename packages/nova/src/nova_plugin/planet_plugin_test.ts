import 'jasmine';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { getIntegrationGameData } from '../communication/simulation_test_fixture.js';
import { completeEntity } from './entity_data_loader.js';
import { makeShip } from './make_ship.js';
import { makeSystem } from './make_system.js';
import { PlayerShipSelector } from './player_ship_plugin.js';
import { applyControlEvents } from './ship_control.js';
import {
    applySetPlanetTarget, LandEvent, LandingBlockedEvent, PlanetComponent,
    PlanetTargetComponent,
} from './planet_plugin.js';

// Sol (nova:130) has several ordinary planets plus the link-less wormhole.
const SYSTEM = 'nova:130';
const SHIP_UUID = 'landing test ship';

async function makeHarness() {
    const gameData = await getIntegrationGameData();
    const ids = await gameData.ids;
    const world = await makeSystem(SYSTEM, gameData);

    const shipId = [...ids.Ship].sort()[0]!;
    const shipData = await gameData.data.Ship.get(shipId);
    const ship = makeShip(shipData);
    ship.components.set(PlayerShipSelector, undefined);
    await completeEntity(world, ship);
    world.entities.set(SHIP_UUID, ship);

    // One step so the providers attach PlanetTargetComponent to the ship.
    world.step();
    return { world, ship };
}

function stellars(world: World): { uuid: string, position: Position }[] {
    const out: { uuid: string, position: Position }[] = [];
    for (const [uuid, entity] of world.entities) {
        if (entity.components.has(PlanetComponent)) {
            out.push({
                uuid,
                position: entity.components.get(MovementStateComponent)!.position,
            });
        }
    }
    return out;
}

function place(ship: Entity, position: Position, velocity = new Vector(0, 0)) {
    const movement = ship.components.get(MovementStateComponent)!;
    movement.position = position;
    movement.velocity = velocity;
}

function pressLand(world: World) {
    const lands: { id: string, uuid: string }[] = [];
    const blocked: { reason: string, isStation: boolean, entities?: unknown }[] = [];
    world.events.get(LandEvent).subscribe(({ data }) => lands.push(data));
    world.events.get(LandingBlockedEvent).subscribe(({ data, entities }) =>
        blocked.push({ ...data, entities }));
    applyControlEvents(world, undefined, [{ action: 'land', state: 'start' }]);
    world.step();
    return { lands, blocked };
}

describe('AttemptLandingSystem', () => {
    it('selects the nearest stellar when nothing is targeted', async () => {
        const { world, ship } = await makeHarness();
        const planets = stellars(world);
        // Sitting exactly on one stellar makes it unambiguously nearest.
        place(ship, planets[0].position);
        expect(ship.components.get(PlanetTargetComponent)!.target)
            .toBeUndefined();

        const { lands } = pressLand(world);

        expect(ship.components.get(PlanetTargetComponent)!.target)
            .toEqual(planets[0].uuid);
        // First press only selects; it never lands.
        expect(lands).toEqual([]);
    }, 30_000);

    it('lands on the ALREADY-selected stellar when in range and slow', async () => {
        const { world, ship } = await makeHarness();
        const planets = stellars(world);
        const target = planets[0];
        ship.components.get(PlanetTargetComponent)!.target = target.uuid;
        place(ship, target.position);

        const { lands, blocked } = pressLand(world);

        expect(blocked).toEqual([]);
        expect(lands.length).toBe(1);
        expect(lands[0].uuid).toEqual(target.uuid);
        // The selection is unchanged: it lands on the target, never retargets.
        expect(ship.components.get(PlanetTargetComponent)!.target)
            .toEqual(target.uuid);
    }, 30_000);

    it('does NOT retarget to the nearest when a far stellar is selected', async () => {
        const { world, ship } = await makeHarness();
        const planets = stellars(world);
        const near = planets[0];
        const selected = planets[1];
        // Sit on the near stellar, but keep the far one selected.
        ship.components.get(PlanetTargetComponent)!.target = selected.uuid;
        place(ship, new Position(selected.position.x + 5000,
            selected.position.y));

        const { lands, blocked } = pressLand(world);

        // Feedback, no land, and crucially the selection stays put.
        expect(lands).toEqual([]);
        expect(blocked.length).toBe(1);
        expect(blocked[0].reason).toEqual('tooFar');
        expect(ship.components.get(PlanetTargetComponent)!.target)
            .toEqual(selected.uuid);
        expect(ship.components.get(PlanetTargetComponent)!.target)
            .not.toEqual(near.uuid);
    }, 30_000);

    it('reports too-fast when over the selected stellar but moving', async () => {
        const { world, ship } = await makeHarness();
        const planets = stellars(world);
        const target = planets[0];
        ship.components.get(PlanetTargetComponent)!.target = target.uuid;
        // On the stellar (in range) but well above the landing speed gate.
        place(ship, target.position, new Vector(100, 0));

        const { lands, blocked } = pressLand(world);

        expect(lands).toEqual([]);
        expect(blocked.length).toBe(1);
        expect(blocked[0].reason).toEqual('tooFast');
    }, 30_000);

    it('targets the player ship with the blocked feedback event', async () => {
        const { world, ship } = await makeHarness();
        const planets = stellars(world);
        ship.components.get(PlanetTargetComponent)!.target = planets[1].uuid;
        place(ship, new Position(planets[1].position.x + 5000,
            planets[1].position.y));

        const { blocked } = pressLand(world);

        expect(blocked.length).toBe(1);
        expect(blocked[0].entities).toEqual([SHIP_UUID]);
    }, 30_000);
});

describe('applySetPlanetTarget', () => {
    it('selects, rejects invalid, and clears the stellar target', async () => {
        const { world, ship } = await makeHarness();
        const planets = stellars(world);
        const target = ship.components.get(PlanetTargetComponent)!;

        applySetPlanetTarget(world, undefined, planets[0].uuid);
        expect(target.target).toEqual(planets[0].uuid);

        // A non-stellar uuid is dropped, leaving the selection untouched.
        applySetPlanetTarget(world, undefined, 'not a real entity');
        expect(target.target).toEqual(planets[0].uuid);

        applySetPlanetTarget(world, undefined, null);
        expect(target.target).toBeUndefined();
    }, 30_000);
});
