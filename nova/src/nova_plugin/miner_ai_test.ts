import 'jasmine';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import {
    advanceMovementState,
    MovementPhysics,
    MovementPhysicsComponent,
    MovementStateComponent,
    MovementType,
} from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import { AsteroidComponent } from './asteroid_plugin';
import { GameDataResource } from './game_data_resource';
import {
    createMinerSystems,
    isMiningShip,
    MINING_SEEK_RANGE,
    MINING_STANDOFF,
    MiningShipComponent,
} from './miner_ai';
import { NpcAIComponent } from './npc_components';
import { ChooseRandomTargetAI, FollowAI } from './npc_plugin';
import { PlatformResource } from './platform_plugin';
import { TargetComponent } from './target_component';

const outfitNames: Record<string, string> = {
    'nova:270': 'Asteroid Mining Laser',
    'nova:100': 'Shield Booster',
};

const gameData = {
    data: {
        Outfit: {
            get: async (id: string) => {
                const name = outfitNames[id];
                if (!name) {
                    throw new Error(`no outfit ${id}`);
                }
                return { name };
            },
        },
    },
} as never;

const MINER_PHYSICS: MovementPhysics = {
    acceleration: 200,
    maxVelocity: 400,
    movementType: MovementType.INERTIAL,
    turnRate: 3,
};

function movementAt(x: number, y: number) {
    return {
        accelerating: 1,
        position: new Position(x, y),
        rotation: new Angle(0),
        turnBack: false,
        turning: 0,
        velocity: new Vector(0, 0),
    };
}

async function makeWorld() {
    const world = new World('miner-test');
    world.resources.set(GameDataResource, gameData);
    world.resources.set(TimeResource, {
        time: 0, delta_ms: 1000 / 60, delta_s: 1 / 60, frame: 0,
    });
    world.resources.set(PlatformResource, 'node');
    await world.addPlugin(DeltaPlugin);
    world.addComponent(MiningShipComponent);
    world.addComponent(AsteroidComponent);
    const miners = createMinerSystems({
        chooseTarget: ChooseRandomTargetAI,
        follow: FollowAI,
    });
    world.addSystem(miners.target);
    world.addSystem(miners.approach);
    return world;
}

function makeMiner(mining: boolean, target?: string) {
    return new Entity()
        .addComponent(MiningShipComponent, { mining })
        .addComponent(NpcAIComponent, undefined)
        .addComponent(TargetComponent, { target })
        .addComponent(MultiplayerData, { owner: 'server' })
        .addComponent(MovementStateComponent, movementAt(0, 0))
        .addComponent(MovementPhysicsComponent, MINER_PHYSICS);
}

function makeRock(x: number, y: number) {
    return new Entity()
        .addComponent(AsteroidComponent, { id: 'nova:130', spin: 0 })
        .addComponent(MultiplayerData, { owner: 'server' })
        .addComponent(MovementStateComponent, movementAt(x, y));
}

function fly(world: World, miner: Entity, steps: number) {
    for (let step = 0; step < steps; step++) {
        world.step();
        const movement = miner.components.get(MovementStateComponent)!;
        Object.assign(movement, advanceMovementState(
            movement,
            MINER_PHYSICS,
            1 / 60,
            world.entities,
        ));
    }
}

describe('mining ships', () => {
    it('recognises a ship by its mining outfits', async () => {
        const miner = {
            ...getDefaultShipData(),
            id: 'nova:379',
            name: 'Asteroid Miner',
            outfits: { 'nova:270': 4 },
        };
        const freighter = {
            ...getDefaultShipData(),
            id: 'nova:130',
            name: 'Argosy',
            outfits: { 'nova:100': 1 },
        };
        expect(await isMiningShip(miner, gameData)).toBeTrue();
        expect(await isMiningShip(freighter, gameData)).toBeFalse();
    });

    it('targets the closest asteroid when nothing is hostile', async () => {
        const world = await makeWorld();
        const miner = makeMiner(true);
        world.entities.set('miner', miner);
        world.entities.set('far', makeRock(1_000, 0));
        world.entities.set('near', makeRock(200, 0));
        world.step();

        expect(miner.components.get(TargetComponent)!.target).toBe('near');
    });

    it('ignores asteroids beyond seek range', async () => {
        const world = await makeWorld();
        const miner = makeMiner(true);
        world.entities.set('miner', miner);
        world.entities.set('far', makeRock(MINING_SEEK_RANGE * 2, 0));
        world.step();

        expect(miner.components.get(TargetComponent)!.target).toBeUndefined();
    });

    it('keeps a hostile target instead of going back to mining', async () => {
        const world = await makeWorld();
        const miner = makeMiner(true, 'attacker');
        world.entities.set('miner', miner);
        world.entities.set('near', makeRock(200, 0));
        world.step();

        expect(miner.components.get(TargetComponent)!.target).toBe('attacker');
    });

    it('leaves ships that do not mine alone', async () => {
        const world = await makeWorld();
        const trader = makeMiner(false);
        world.entities.set('trader', trader);
        world.entities.set('near', makeRock(200, 0));
        world.step();

        expect(trader.components.get(TargetComponent)!.target).toBeUndefined();
    });

    it('arrives at mining range at low speed and holds station', async () => {
        const world = await makeWorld();
        const miner = makeMiner(true);
        world.entities.set('miner', miner);
        const rock = makeRock(2_000, 0);
        world.entities.set('rock', rock);

        fly(world, miner, 3_000);
        const arrived = miner.components.get(MovementStateComponent)!;
        const rockMovement = rock.components.get(MovementStateComponent)!;
        expect(rockMovement.position.subtract(arrived.position).length)
            .toBeGreaterThan(MINING_STANDOFF - 100);
        expect(rockMovement.position.subtract(arrived.position).length)
            .toBeLessThan(MINING_STANDOFF + 100);
        expect(arrived.velocity.length).toBeLessThan(20);

        fly(world, miner, 600);
        const held = miner.components.get(MovementStateComponent)!;
        expect(rockMovement.position.subtract(held.position).length)
            .toBeGreaterThan(MINING_STANDOFF - 100);
        expect(rockMovement.position.subtract(held.position).length)
            .toBeLessThan(MINING_STANDOFF + 100);
        expect(held.velocity.length).toBeLessThan(20);
    });

    it('holds the rock under its guns once parked', async () => {
        const world = await makeWorld();
        const miner = makeMiner(true);
        world.entities.set('miner', miner);
        const rock = makeRock(2_000, 0);
        world.entities.set('rock', rock);

        fly(world, miner, 3_000);
        const held = miner.components.get(MovementStateComponent)!;
        const rockMovement = rock.components.get(MovementStateComponent)!;
        // Braking leaves the nose pointing back the way the ship came, so a
        // parked miner that stops steering cannot hit the rock it came for.
        const toRock = rockMovement.position.subtract(held.position);
        const facing = held.rotation.getUnitVector();
        const alignment = (toRock.x * facing.x + toRock.y * facing.y)
            / toRock.length;
        expect(alignment).toBeGreaterThan(0.9);
    });

    it('does not thrust sideways while turning towards the rock', async () => {
        const world = await makeWorld();
        const miner = makeMiner(true);
        world.entities.set('miner', miner);
        world.entities.set('near', makeRock(2_000, 0));
        world.step();

        expect(miner.components.get(MovementStateComponent)!.accelerating)
            .toBe(0);
        expect(miner.components.get(MovementStateComponent)!.turnTo)
            .toEqual(new Angle(Math.PI / 2));
    });
});
