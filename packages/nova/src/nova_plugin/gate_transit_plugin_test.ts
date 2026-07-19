import "jasmine";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { World } from "nova_ecs/world";
import { getIntegrationGameData } from "../communication/simulation_test_fixture.js";
import { completeEntity } from "./entity_data_loader.js";
import { makeShip } from "./make_ship.js";
import { makeSystem } from "./make_system.js";
import { PlayerShipSelector } from "./player_ship_plugin.js";
import { LandEvent } from "./planet_plugin.js";
import { PlayerSoundEvent } from "./sound_plugin.js";
import { WARP_OUT_SOUND } from "./jump_plugin.js";
import { ShipPhysicsComponent, getShipMovementPhysics } from "./ship_plugin.js";
import {
    GateArrivalComponent, GateTransit, GateTransitEvent, GATE_EMERGENCE_DISTANCE,
} from "./gate_transit_plugin.js";
import { GateDestinationResolver } from "./gate_destination_resolver.js";

// Stock EV Nova hypergate pair (see the spöb scan): HG-V01 (spöb nova:1400) in
// system VNP-001 (nova:427) links to HG-V02 (spöb nova:1401) in VNP-002
// (nova:425), and back. Sol (nova:130) contains the link-less wormhole
// nova:465 (the Bible's "random wormhole").
const GATE_A_SPOB = 'nova:1400';
const GATE_B_SPOB = 'nova:1401';
const SYSTEM_A = 'nova:427';
const SYSTEM_B = 'nova:425';
const WORMHOLE_SPOB = 'nova:465';
const WORMHOLE_SYSTEM = 'nova:130';
const SHIP_UUID = 'gate test ship';

async function makeGateHarness(systemId: string) {
    const gameData = await getIntegrationGameData();
    const ids = await gameData.ids;
    const world = await makeSystem(systemId, gameData);

    const shipId = [...ids.Ship].sort()[0]!;
    const shipData = await gameData.data.Ship.get(shipId);
    const ship = makeShip(shipData);
    ship.components.set(PlayerShipSelector, undefined);
    await completeEntity(world, ship);
    world.entities.set(SHIP_UUID, ship);

    return { gameData, world, ship };
}

function stepUntil(world: World, predicate: () => boolean, maxSteps = 600) {
    for (let i = 0; i < maxSteps; i++) {
        if (predicate()) {
            return i;
        }
        world.step();
    }
    throw new Error(`Condition not met within ${maxSteps} steps`);
}

describe('gate transit', () => {
    it('does NOT auto-transit when landing on a hypergate', async () => {
        // Hypergate landings dock the ship and open the hypergate map (the
        // browser's flow); the sim must not choose a destination on its own.
        const { world } = await makeGateHarness(SYSTEM_A);
        world.step();

        let transit: GateTransit | undefined;
        world.events.get(GateTransitEvent).subscribe(({ data }) => {
            transit = data;
        });
        world.emit(LandEvent,
            { id: GATE_A_SPOB, uuid: `planet ${GATE_A_SPOB}` }, [SHIP_UUID]);
        world.step();
        world.step();
        expect(transit).toBeUndefined();
        expect(world.entities.has(SHIP_UUID)).toBeTrue();
    }, 30_000);

    it('transits immediately when landing on a wormhole', async () => {
        // Wormholes offer no choice: the sim removes the ship and carries it
        // on a GateTransitEvent. nova:465 is link-less, so the destination is
        // null (a random other wormhole, resolved by the browser from the
        // replicated draw).
        const { world } = await makeGateHarness(WORMHOLE_SYSTEM);
        world.step();

        let transit: GateTransit | undefined;
        world.events.get(GateTransitEvent).subscribe(({ data }) => {
            transit = data;
        });
        world.emit(LandEvent,
            { id: WORMHOLE_SPOB, uuid: `planet ${WORMHOLE_SPOB}` }, [SHIP_UUID]);
        stepUntil(world, () => transit !== undefined);

        expect(world.entities.has(SHIP_UUID)).toBeFalse();
        expect(transit!.uuid).toEqual(SHIP_UUID);
        expect(transit!.fromSpob).toEqual(WORMHOLE_SPOB);
        expect(transit!.destinationSpob).toBeNull();

        const arrival = transit!.entity.components.get(GateArrivalComponent)!;
        expect(arrival).toBeDefined();
        expect(arrival.destinationSpob).toBeNull();
        expect(arrival.randomDraw).toBeGreaterThanOrEqual(0);
        expect(arrival.randomDraw).toBeLessThan(1);
    }, 30_000);

    it('does not transit when landing on an ordinary planet', async () => {
        const { world } = await makeGateHarness(SYSTEM_A);
        world.step();

        let transit: GateTransit | undefined;
        world.events.get(GateTransitEvent).subscribe(({ data }) => {
            transit = data;
        });
        world.emit(LandEvent,
            { id: 'nova:128', uuid: 'planet nova:128' }, [SHIP_UUID]);
        world.step();
        world.step();
        expect(transit).toBeUndefined();
        expect(world.entities.has(SHIP_UUID)).toBeTrue();
    }, 30_000);

    it('arrives flying out of the destination gate with the jump-in sound',
        async () => {
        // The browser (hypergate map pick, or wormhole exit resolution) tags
        // the ship with a GateArrivalComponent and re-inserts it into the
        // destination system; the first tick there positions it flying out.
        const { gameData } = await makeGateHarness(SYSTEM_A);
        const destWorld = await makeSystem(SYSTEM_B, gameData);

        const ids = await gameData.ids;
        const shipData = await gameData.data.Ship.get([...ids.Ship].sort()[0]!);
        const ship = makeShip(shipData);
        ship.components.set(GateArrivalComponent, {
            destinationSpob: GATE_B_SPOB,
            emergenceAngle: null,
            randomDraw: 0.25,
        });
        await completeEntity(destWorld, ship);
        destWorld.entities.set(SHIP_UUID, ship);

        const sounds: string[] = [];
        destWorld.events.get(PlayerSoundEvent).subscribe(({ data }) => {
            sounds.push(data.id);
        });
        destWorld.step();
        expect(ship.components.has(GateArrivalComponent)).toBeFalse();

        // Positioned at the emergence distance from the gate (it may have
        // coasted outward for a tick before we observe it)...
        const gatePlanet = destWorld.entities.get(`planet ${GATE_B_SPOB}`)!;
        const gatePos = gatePlanet.components.get(MovementStateComponent)!.position;
        const movement = ship.components.get(MovementStateComponent)!;
        const offset = movement.position.subtract(gatePos);
        const physics = ship.components.get(ShipPhysicsComponent)!;
        const speed = getShipMovementPhysics(physics).maxVelocity;
        expect(offset.length).toBeGreaterThanOrEqual(GATE_EMERGENCE_DISTANCE - 1e-6);
        expect(offset.length).toBeLessThan(GATE_EMERGENCE_DISTANCE + speed * 0.05);

        // ...flying outward at the ship's regular top speed, facing out...
        expect(movement.velocity.length).toBeCloseTo(speed, 3);
        // Velocity is along the emergence offset (outward, not inward).
        expect(movement.velocity.dot(offset)).toBeGreaterThan(0);
        expect(movement.rotation.angle)
            .toBeCloseTo(movement.velocity.angle.angle, 6);

        // ...with the "jump in" sound (snd 130 Warp out) for the pilot.
        expect(sounds).toContain(WARP_OUT_SOUND);

        // The destination gate's own emergence angle (CustSndID 120°) decides
        // the direction: 120° in clock-angle radians.
        const expected = 120 * Math.PI / 180;
        const angleOff = Math.abs(movement.rotation.angle - (
            expected >= Math.PI ? expected - 2 * Math.PI : expected));
        expect(angleOff).toBeLessThan(1e-6);
    }, 30_000);

    it('resolves a real hypergate pair end-to-end (system and position)',
        async () => {
        const gameData = await getIntegrationGameData();
        const resolver = new GateDestinationResolver(gameData);

        // The destination spöb resolves to the system that contains it.
        const destSystem = await resolver.systemOf(GATE_B_SPOB);
        expect([SYSTEM_B, 'nova:619']).toContain(destSystem!);

        // And the reverse link resolves back to system A.
        const backSystem = await resolver.systemOf(GATE_A_SPOB);
        expect([SYSTEM_A, 'nova:621']).toContain(backSystem!);
    }, 30_000);
});

describe('GateDestinationResolver random wormhole', () => {
    it('picks a link-less wormhole exit deterministically from a draw',
        async () => {
        const gameData = await getIntegrationGameData();
        const resolver = new GateDestinationResolver(gameData);
        // A random wormhole exit is another link-less wormhole, chosen by the
        // seeded draw. nova:465 is a link-less wormhole (destinations empty).
        const exit0 = await resolver.randomWormholeExit('nova:465', 0);
        const exitSame = await resolver.randomWormholeExit('nova:465', 0);
        expect(exit0).toBeDefined();
        // Same draw => same exit (deterministic).
        expect(exit0).toEqual(exitSame);
        // Never returns the departure wormhole itself.
        expect(exit0).not.toEqual('nova:465');
        // The chosen exit is itself a resolvable wormhole in some system.
        const exitSystem = await resolver.systemOf(exit0!);
        expect(exitSystem).toBeDefined();
    }, 30_000);
});
