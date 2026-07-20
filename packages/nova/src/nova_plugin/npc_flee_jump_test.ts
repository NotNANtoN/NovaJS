import 'jasmine';
import { MockGameData } from 'novadatainterface/mock_game_data';
import { getDefaultShipData } from 'novadatainterface/ship_data';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { World } from 'nova_ecs/world';
import { completeEntity } from './entity_data_loader.js';
import { JUMP_DISTANCE } from './jump_plugin.js';
import { makeShip } from './make_ship.js';
import { makeSystem } from './make_system.js';
import { FLEE_JUMP_BLOCK_RANGE, NpcComponent } from './npc_ai_plugin.js';

/**
 * A fleeing NPC outside the no-jump radius, facing +x (directly away
 * from its aggressor), with the aggressor placed by each spec.
 */
async function makeFleeWorld(chaserOffset: { x: number, y: number } | null,
    npcDistance = JUMP_DISTANCE + 500) {
    const gameData = new MockGameData();
    gameData.data.Ship.map.set('test:ship', {
        ...getDefaultShipData(), id: 'test:ship',
    });
    const world = await makeSystem('test:system', gameData);

    async function addShip(uuid: string, x: number, y: number,
        setup: (ship: ReturnType<typeof makeShip>) => void = () => { }) {
        const ship = makeShip(gameData.data.Ship.map.get('test:ship')!);
        ship.components.set(MovementStateComponent, {
            accelerating: 0,
            position: new Position(x, y),
            rotation: new Angle(Math.PI / 2), // Facing +x.
            turnBack: false,
            turning: 0,
            velocity: new Vector(0, 0),
        });
        setup(ship);
        await completeEntity(world, ship);
        world.entities.set(uuid, ship);
    }

    if (chaserOffset) {
        await addShip('chaser', npcDistance + chaserOffset.x,
            chaserOffset.y);
    }
    await addShip('npc', npcDistance, 0, ship => {
        ship.components.set(NpcComponent, {
            aiType: 1,
            mode: 'flee',
            aggressor: chaserOffset ? 'chaser' : undefined,
        });
    });
    return world;
}

function stillThere(world: World) {
    return world.entities.has('npc');
}

describe('fleeing ships jump away', () => {
    it('a fleeing ship outside the no-jump radius jumps out ' +
        '(despawns) when its chaser is far away', async () => {
            const world = await makeFleeWorld(
                { x: -FLEE_JUMP_BLOCK_RANGE * 3, y: 0 });
            for (let i = 0; i < 5 && stillThere(world); i++) {
                world.step();
            }
            expect(stillThere(world)).toBeFalse();
        });

    it('a chaser right behind (close, in the rear cone) blocks the ' +
        'jump: the ship keeps running', async () => {
            const world = await makeFleeWorld(
                { x: -FLEE_JUMP_BLOCK_RANGE * 0.4, y: 0 });
            for (let i = 0; i < 30; i++) {
                world.step();
            }
            expect(stillThere(world)).toBeTrue();
        });

    it('a close chaser AHEAD does not block the jump', async () => {
        const world = await makeFleeWorld(
            { x: FLEE_JUMP_BLOCK_RANGE * 0.4, y: 0 });
        for (let i = 0; i < 5 && stillThere(world); i++) {
            world.step();
        }
        expect(stillThere(world)).toBeFalse();
    });

    it('inside the no-jump radius the ship cannot jump yet', async () => {
        const world = await makeFleeWorld(
            { x: -FLEE_JUMP_BLOCK_RANGE * 3, y: 0 }, JUMP_DISTANCE * 0.5);
        for (let i = 0; i < 30; i++) {
            world.step();
        }
        expect(stillThere(world)).toBeTrue();
    });
});
