import "jasmine";
import { Position } from "nova_ecs/datatypes/position";
import { Vector } from "nova_ecs/datatypes/vector";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { World } from "nova_ecs/world";
import { getIntegrationGameData } from "../communication/simulation_test_fixture.js";
import { completeEntity } from "./entity_data_loader.js";
import { FinishJump, FinishJumpEvent, JumpComponent, JumpRouteComponent, JUMP_ARRIVAL_DELAY_MS, JUMP_BASE_SPEED, JUMP_DEPART_DELAY_MS, JUMP_DISTANCE, JUMP_SPINUP_DELAY_MS, WARP_OUT_SOUND, WARP_UP_FAST_SOUND, WARP_UP_SOUND } from "./jump_plugin.js";
import { makeShip } from "./make_ship.js";
import { makeSystem, SIMULATION_STEP_MS } from "./make_system.js";
import { applyControlEvents } from "./ship_control.js";
import { PlayerShipSelector } from "./player_ship_plugin.js";
import { ShipPhysicsComponent } from "./ship_plugin.js";
import { SoundEvent } from "./sound_plugin.js";

const SHIP_UUID = 'jump test ship';

async function findLinkedSystems() {
    const gameData = await getIntegrationGameData();
    const ids = await gameData.ids;
    for (const systemId of [...ids.System].sort()) {
        const system = await gameData.data.System.get(systemId);
        if (system.links.length > 0) {
            return {
                originId: systemId,
                destinationId: [...system.links].sort()[0]!,
            };
        }
    }
    throw new Error('Expected a system with hyperspace links');
}

async function makeJumpHarness() {
    const gameData = await getIntegrationGameData();
    const ids = await gameData.ids;
    const { originId, destinationId } = await findLinkedSystems();
    const world = await makeSystem(originId, gameData);

    // Pick a ship with default jump behavior (inertial, must slow
    // down to jump) so the full sequence is exercised.
    let shipData;
    for (const shipId of [...ids.Ship].sort()) {
        const candidate = await gameData.data.Ship.get(shipId);
        if (!candidate.physics.inertialess
            && !candidate.physics.canJumpWithoutSlowing) {
            shipData = candidate;
            break;
        }
    }
    if (!shipData) {
        throw new Error('Expected a ship with default jump behavior');
    }
    const ship = makeShip(shipData);
    ship.components.set(PlayerShipSelector, undefined);
    ship.components.set(JumpRouteComponent, { route: [destinationId] });
    await completeEntity(world, ship);
    world.entities.set(SHIP_UUID, ship);

    const origin = await gameData.data.System.get(originId);
    const destination = await gameData.data.System.get(destinationId);
    const expectedDirection = new Vector(
        destination.position[0] - origin.position[0],
        destination.position[1] - origin.position[1]).angle.angle;

    return { gameData, world, ship, originId, destinationId, expectedDirection };
}

function pressHyperjump(world: World) {
    applyControlEvents(world, undefined,
        [{ action: 'hyperjump', state: 'start' }]);
    world.step();
}

/** Steps the world until the predicate holds. Returns steps taken. */
function stepUntil(world: World, predicate: () => boolean,
    maxSteps = 3000): number {
    for (let i = 0; i < maxSteps; i++) {
        if (predicate()) {
            return i;
        }
        world.step();
    }
    throw new Error(`Condition not met within ${maxSteps} steps`);
}

function ticksFor(delayMs: number) {
    return Math.ceil(delayMs / SIMULATION_STEP_MS);
}

describe('jump sequence', () => {
    it('refuses to jump inside the no-jump zone', async () => {
        const { world, ship } = await makeJumpHarness();
        const movement = ship.components.get(MovementStateComponent)!;
        movement.position = new Position(0, -(JUMP_DISTANCE / 2));
        world.step();

        pressHyperjump(world);
        expect(ship.components.get(JumpComponent)).toBeUndefined();
        // The route is not consumed by a refused jump.
        expect(ship.components.get(JumpRouteComponent)!.route.length)
            .toEqual(1);
    }, 30_000);

    it('stops, aligns, spins up, and accelerates out', async () => {
        const { world, ship, destinationId, expectedDirection } =
            await makeJumpHarness();
        const movement = ship.components.get(MovementStateComponent)!;
        movement.position = new Position(0, -(JUMP_DISTANCE * 2));
        movement.velocity = new Vector(100, 0);
        world.step();

        const physics = ship.components.get(ShipPhysicsComponent)!;
        const jumpSpeed = JUMP_BASE_SPEED * physics.jumpSpeedMult;

        let finishJump: FinishJump | undefined;
        world.events.get(FinishJumpEvent).subscribe(({ data }) => {
            finishJump = data;
        });

        pressHyperjump(world);
        const jump = ship.components.get(JumpComponent)!;
        expect(jump).toBeDefined();
        expect(jump.stage).toEqual('stopping');
        expect(jump.to).toEqual(destinationId);
        expect(jump.direction).toBeCloseTo(expectedDirection, 6);
        // The route was consumed.
        expect(ship.components.get(JumpRouteComponent)!.route.length)
            .toEqual(0);

        // Control is taken away: holding accelerate must not prevent
        // the ship from stopping.
        applyControlEvents(world, undefined,
            [{ action: 'accelerate', state: 'start' }]);

        stepUntil(world, () => jump.stage !== 'stopping');
        expect(jump.stage).toEqual('aligning');
        expect(movement.velocity.length).toEqual(0);

        stepUntil(world, () => jump.stage !== 'aligning');
        expect(jump.stage).toEqual('spinup');
        expect(movement.rotation.angle).toBeCloseTo(expectedDirection, 6);
        // The ship holds still while the hyperdrive spins up.
        const spinupTicks = stepUntil(world, () => jump.stage !== 'spinup');
        expect(spinupTicks).toBeGreaterThanOrEqual(
            ticksFor(JUMP_SPINUP_DELAY_MS) - 1);
        expect(spinupTicks).toBeLessThanOrEqual(
            ticksFor(JUMP_SPINUP_DELAY_MS) + 1);
        expect(movement.velocity.length).toEqual(0);

        expect(jump.stage).toEqual('accelerating');
        // Partway through departure the ship exceeds its normal
        // maximum speed.
        for (let i = 0; i < ticksFor(JUMP_DEPART_DELAY_MS * 0.75); i++) {
            world.step();
        }
        expect(movement.velocity.length).toBeGreaterThan(physics.speed);

        stepUntil(world, () => finishJump !== undefined);
        expect(world.entities.has(SHIP_UUID)).toBeFalse();
        expect(finishJump!.to).toEqual(destinationId);
        expect(finishJump!.uuid).toEqual(SHIP_UUID);

        // The departing entity carries its arrival state: at the edge
        // of the no-jump zone on the inbound side, at full jump speed,
        // heading along the travel direction.
        const jumpedShip = finishJump!.entity;
        const arrivalJump = jumpedShip.components.get(JumpComponent)!;
        expect(arrivalJump.stage).toEqual('arriving');
        expect(arrivalJump.stageStart).toBeUndefined();
        const arrivalMovement =
            jumpedShip.components.get(MovementStateComponent)!;
        // The jump-in point is the edge of the no-jump zone; the ship
        // may have coasted inward for a tick or two before the event
        // was published.
        expect(arrivalMovement.position.length)
            .toBeLessThanOrEqual(JUMP_DISTANCE);
        expect(arrivalMovement.position.length)
            .toBeGreaterThan(JUMP_DISTANCE
                - 2 * jumpSpeed * SIMULATION_STEP_MS / 1000);
        expect(arrivalMovement.velocity.length).toBeCloseTo(jumpSpeed, 3);
        expect(arrivalMovement.velocity.angle.angle)
            .toBeCloseTo(expectedDirection, 6);
        expect(arrivalMovement.rotation.angle)
            .toBeCloseTo(expectedDirection, 6);
    }, 30_000);

    it('skips stopping for ships that can jump without slowing', async () => {
        const { world, ship } = await makeJumpHarness();
        const movement = ship.components.get(MovementStateComponent)!;
        movement.position = new Position(0, -(JUMP_DISTANCE * 2));
        movement.velocity = new Vector(100, 0);
        const physics = ship.components.get(ShipPhysicsComponent)!;
        ship.components.set(ShipPhysicsComponent,
            { ...physics, canJumpWithoutSlowing: true });
        world.step();

        pressHyperjump(world);
        const jump = ship.components.get(JumpComponent)!;
        expect(jump.stage).toEqual('aligning');
        // Still moving: the ship never comes to a stop.
        expect(movement.velocity.length).toBeGreaterThan(0);
    }, 30_000);

    it('plays the warp-up sound when the departure burn begins', async () => {
        const { world, ship } = await makeJumpHarness();
        const movement = ship.components.get(MovementStateComponent)!;
        movement.position = new Position(0, -(JUMP_DISTANCE * 2));
        world.step();

        const sounds: string[] = [];
        world.events.get(SoundEvent).subscribe(({ data }) => {
            sounds.push(data.id);
        });

        pressHyperjump(world);
        const jump = ship.components.get(JumpComponent)!;
        stepUntil(world, () => jump.stage === 'spinup');
        expect(sounds).not.toContain(WARP_UP_SOUND);
        stepUntil(world, () => jump.stage === 'accelerating');
        world.step();
        expect(sounds).toContain(WARP_UP_SOUND);
        expect(sounds).not.toContain(WARP_UP_FAST_SOUND);
    }, 30_000);

    it('plays the double-speed warp-up for fast-jumping ships', async () => {
        const { world, ship } = await makeJumpHarness();
        const movement = ship.components.get(MovementStateComponent)!;
        movement.position = new Position(0, -(JUMP_DISTANCE * 2));
        const physics = ship.components.get(ShipPhysicsComponent)!;
        ship.components.set(ShipPhysicsComponent,
            { ...physics, jumpSpeedMult: 1.5 });
        world.step();

        const sounds: string[] = [];
        world.events.get(SoundEvent).subscribe(({ data }) => {
            sounds.push(data.id);
        });

        pressHyperjump(world);
        const jump = ship.components.get(JumpComponent)!;
        stepUntil(world, () => jump.stage === 'accelerating');
        world.step();
        expect(sounds).toContain(WARP_UP_FAST_SOUND);
        expect(sounds).not.toContain(WARP_UP_SOUND);
    }, 30_000);

    it('respects the jump distance modifier from outfits', async () => {
        const { world, ship } = await makeJumpHarness();
        const movement = ship.components.get(MovementStateComponent)!;
        movement.position = new Position(0, -(JUMP_DISTANCE / 2));
        const physics = ship.components.get(ShipPhysicsComponent)!;
        // An outfit shrank the no-jump zone below the ship's distance.
        ship.components.set(ShipPhysicsComponent,
            { ...physics, jumpDistanceMod: -(JUMP_DISTANCE * 0.75) });
        world.step();

        pressHyperjump(world);
        expect(ship.components.get(JumpComponent)).toBeDefined();
    }, 30_000);

    it('arrives with inbound velocity and returns control', async () => {
        const { gameData, world, ship, destinationId } =
            await makeJumpHarness();
        const movement = ship.components.get(MovementStateComponent)!;
        movement.position = new Position(0, -(JUMP_DISTANCE * 2));
        world.step();

        let finishJump: FinishJump | undefined;
        world.events.get(FinishJumpEvent).subscribe(({ data }) => {
            finishJump = data;
        });
        pressHyperjump(world);
        stepUntil(world, () => finishJump !== undefined);

        // Insert the ship into the destination system, as the
        // simulation bridge does after the room join completes.
        const destWorld = await makeSystem(destinationId, gameData);
        const jumpedShip = finishJump!.entity;
        await completeEntity(destWorld, jumpedShip);
        destWorld.entities.set(SHIP_UUID, jumpedShip);

        const arrivalMovement =
            jumpedShip.components.get(MovementStateComponent)!;
        const physics = jumpedShip.components.get(ShipPhysicsComponent)!;
        const jumpSpeed = JUMP_BASE_SPEED * physics.jumpSpeedMult;
        expect(arrivalMovement.velocity.length).toBeCloseTo(jumpSpeed, 3);

        const sounds: string[] = [];
        destWorld.events.get(SoundEvent).subscribe(({ data }) => {
            sounds.push(data.id);
        });

        // The ship coasts in above its normal max speed with control
        // locked, decelerating as it goes.
        applyControlEvents(destWorld, undefined,
            [{ action: 'turnLeft', state: 'start' }]);
        destWorld.step();
        destWorld.step();
        // The warp-out sound plays on the destination's first tick.
        expect(sounds).toContain(WARP_OUT_SOUND);
        expect(arrivalMovement.velocity.length).toBeGreaterThan(physics.speed);
        expect(arrivalMovement.velocity.length).toBeLessThan(jumpSpeed);
        expect(arrivalMovement.turning).toEqual(0);

        const arrivalTicks = stepUntil(destWorld,
            () => !jumpedShip.components.has(JumpComponent));
        expect(arrivalTicks).toBeLessThanOrEqual(
            ticksFor(JUMP_ARRIVAL_DELAY_MS) + 2);
        // Hyperspace speed has been shed and control is back.
        destWorld.step();
        expect(arrivalMovement.velocity.length)
            .toBeLessThanOrEqual(physics.speed + 1e-6);
        destWorld.step();
        expect(arrivalMovement.turning).not.toEqual(0);
    }, 30_000);
});
