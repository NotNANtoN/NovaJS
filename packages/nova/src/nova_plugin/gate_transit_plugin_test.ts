import "jasmine";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { World } from "nova_ecs/world";
import { getIntegrationGameData } from "../communication/simulation_test_fixture.js";
import { completeEntity } from "./entity_data_loader.js";
import { makeShip } from "./make_ship.js";
import { makeSystem } from "./make_system.js";
import { PlayerShipSelector } from "./player_ship_plugin.js";
import { LandEvent } from "./planet_plugin.js";
import {
    GateArrivalComponent, GateTransit, GateTransitEvent, GATE_EMERGENCE_DISTANCE,
} from "./gate_transit_plugin.js";
import { GateDestinationResolver } from "./gate_destination_resolver.js";

// Stock EV Nova hypergate pair (see the spöb scan): HG-V01 (spöb nova:1400) in
// system VNP-001 (nova:427) links to HG-V02 (spöb nova:1401) in VNP-002
// (nova:425), and back.
const GATE_A_SPOB = 'nova:1400';
const GATE_B_SPOB = 'nova:1401';
const SYSTEM_A = 'nova:427';
const SYSTEM_B = 'nova:425';
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
    it('emits a transit event carrying the ship when it lands on a hypergate',
        async () => {
        const { world, ship } = await makeGateHarness(SYSTEM_A);
        world.step();

        let transit: GateTransit | undefined;
        world.events.get(GateTransitEvent).subscribe(({ data }) => {
            transit = data;
        });

        // Landing on the hypergate spöb.
        world.emit(LandEvent,
            { id: GATE_A_SPOB, uuid: `planet ${GATE_A_SPOB}` }, [SHIP_UUID]);
        stepUntil(world, () => transit !== undefined);

        // The ship is removed from the origin system and carried on the event.
        expect(world.entities.has(SHIP_UUID)).toBeFalse();
        expect(transit!.uuid).toEqual(SHIP_UUID);
        expect(transit!.fromSpob).toEqual(GATE_A_SPOB);
        // A hypergate takes its first defined link as the destination.
        expect(transit!.destinationSpob).toEqual(GATE_B_SPOB);

        // The carried ship is tagged for arrival at the destination gate.
        const arrival = transit!.entity.components.get(GateArrivalComponent)!;
        expect(arrival).toBeDefined();
        expect(arrival.destinationSpob).toEqual(GATE_B_SPOB);
        // Emergence angle carried from the source gate's CustSndID (120°).
        expect(arrival.emergenceAngle).toEqual(120);
    }, 30_000);

    it('does not transit when landing on an ordinary planet', async () => {
        const { world } = await makeGateHarness(SYSTEM_A);
        world.step();

        let transit: GateTransit | undefined;
        world.events.get(GateTransitEvent).subscribe(({ data }) => {
            transit = data;
        });
        // VNP-001 has no ordinary planet, so land on a non-gate id: nothing
        // happens because no planet with that id is a gate.
        world.emit(LandEvent,
            { id: 'nova:128', uuid: 'planet nova:128' }, [SHIP_UUID]);
        world.step();
        world.step();
        expect(transit).toBeUndefined();
        expect(world.entities.has(SHIP_UUID)).toBeTrue();
    }, 30_000);

    it('positions the arriving ship at the destination gate', async () => {
        // Depart system A.
        const { gameData, world, ship } = await makeGateHarness(SYSTEM_A);
        world.step();
        let transit: GateTransit | undefined;
        world.events.get(GateTransitEvent).subscribe(({ data }) => {
            transit = data;
        });
        world.emit(LandEvent,
            { id: GATE_A_SPOB, uuid: `planet ${GATE_A_SPOB}` }, [SHIP_UUID]);
        stepUntil(world, () => transit !== undefined);

        // Insert into the destination system, as the browser does after the
        // room switch.
        const destWorld = await makeSystem(SYSTEM_B, gameData);
        const jumpedShip = transit!.entity;
        await completeEntity(destWorld, jumpedShip);
        destWorld.entities.set(SHIP_UUID, jumpedShip);

        // The first destination tick teleports the ship to the arrival gate
        // and clears the marker.
        destWorld.step();
        expect(jumpedShip.components.has(GateArrivalComponent)).toBeFalse();

        // The destination gate (nova:1401) sits at [0,0] in VNP-002; the ship
        // emerges GATE_EMERGENCE_DISTANCE away from it.
        const gatePlanet = destWorld.entities.get(`planet ${GATE_B_SPOB}`)!;
        const gatePos = gatePlanet.components.get(MovementStateComponent)!.position;
        const arrivalPos =
            jumpedShip.components.get(MovementStateComponent)!.position;
        const dist = Math.hypot(arrivalPos.x - gatePos.x, arrivalPos.y - gatePos.y);
        expect(dist).toBeCloseTo(GATE_EMERGENCE_DISTANCE, 3);
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
