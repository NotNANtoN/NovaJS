import 'jasmine';
import { CommunicatorResource } from 'nova_ecs/plugins/multiplayer_plugin';
import { MockCommunicator } from 'nova_ecs/plugins/mock_communicator';
import { hashWorld } from 'nova_ecs/plugins/world_hash';
import { World } from 'nova_ecs/world';
import { makeShip } from '../nova_plugin/make_ship.js';
import { makeSystem } from '../nova_plugin/make_system.js';
import { completeEntity } from '../nova_plugin/entity_data_loader.js';
import { ControlledByComponent, PEER_LOCAL_COMPONENTS } from '../nova_plugin/ship_control.js';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { Position } from 'nova_ecs/datatypes/position';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Vector } from 'nova_ecs/datatypes/vector';
import { RollbackRelay } from './rollback_relay.js';
import { SimulationBridgeClient, SimulationBridgeHost } from './simulation_bridge.js';
import { getIntegrationGameData } from './simulation_test_fixture.js';

/**
 * The pure input-driven room, end to end with real bridge hosts and a
 * real relay (mock sockets): peers exchange only input records, and
 * their worlds converge to identical state.
 */
describe('Input-driven rooms', () => {
    let comms: Map<string, MockCommunicator>;
    let relay: RollbackRelay;

    beforeEach(() => {
        comms = new Map([
            ['server', new MockCommunicator('server')],
            ['a', new MockCommunicator('a')],
            ['b', new MockCommunicator('b')],
        ]);
        for (const comm of comms.values()) {
            comm.mockPeers = comms;
            comm.peers.current.next(new Set(comms.keys()));
        }
        relay = new RollbackRelay(comms.get('server')!, { autoClock: false });
    });

    afterEach(() => {
        relay.close();
    });

    async function makePeer(peerId: string) {
        const gameData = await getIntegrationGameData();
        const ids = await gameData.ids;
        const systemId = [...ids.System].sort()[0]!;
        const world = await makeSystem(systemId, gameData, 'worker');
        world.resources.set(CommunicatorResource, comms.get(peerId)!);
        const host = new SimulationBridgeHost(world, gameData);
        const serializer = world.resources.get(
            (await import('nova_ecs/plugins/serializer_plugin')).SerializerResource)!;
        const client = new SimulationBridgeClient(host, serializer);
        return { world, host, client };
    }

    async function makePeerShip(peerId: string, world: World) {
        const gameData = await getIntegrationGameData();
        const ids = await gameData.ids;
        const shipData = await gameData.data.Ship.get([...ids.Ship].sort()[0]!);
        const ship = makeShip(shipData);
        ship.components.set(ControlledByComponent, { peerId });
        const movement = ship.components.get(MovementStateComponent)!;
        movement.position = new Position(peerId === 'a' ? 100 : -100, 50);
        movement.rotation = new Angle(1);
        movement.velocity = new Vector(0, 0);
        await completeEntity(world, ship);
        return ship;
    }

    it('converges two peers exchanging only input records', async () => {
        const peerA = await makePeer('a');
        const peerB = await makePeer('b');

        // Each peer inserts its own ship (an input record, relayed).
        await peerA.client.addEntity('ship a', await makePeerShip('a', peerA.world));
        await peerB.client.addEntity('ship b', await makePeerShip('b', peerB.world));

        for (let tick = 1; tick <= 120; tick++) {
            if (tick === 10) {
                peerA.host.controlEvents([{ action: 'accelerate', state: 'start' }]);
            }
            if (tick === 20) {
                peerB.host.controlEvents([{ action: 'turnLeft', state: 'start' }]);
                peerB.host.controlEvents([{ action: 'firePrimary', state: 'start' }]);
            }
            peerA.host.step();
            peerB.host.step();
        }
        // A few quiet ticks so the final records cross over.
        for (let i = 0; i < 5; i++) {
            peerA.host.step();
            peerB.host.step();
        }

        const hashA = hashWorld(peerA.world, PEER_LOCAL_COMPONENTS);
        const hashB = hashWorld(peerB.world, PEER_LOCAL_COMPONENTS);
        expect(hashA.hash).toEqual(hashB.hash);
        // Both worlds contain both ships.
        expect(peerA.world.entities.has('ship a')).toBeTrue();
        expect(peerA.world.entities.has('ship b')).toBeTrue();
        expect(peerB.world.entities.has('ship a')).toBeTrue();
        expect(peerB.world.entities.has('ship b')).toBeTrue();
    }, 120_000);

    it('a late joiner reconstructs the world from the input log', async () => {
        const peerA = await makePeer('a');
        await peerA.client.addEntity('ship a', await makePeerShip('a', peerA.world));
        for (let tick = 1; tick <= 60; tick++) {
            if (tick === 5) {
                peerA.host.controlEvents([{ action: 'accelerate', state: 'start' }]);
            }
            peerA.host.step();
            relay.advanceTicks(1);
        }

        // B joins late: genesis + the relay's log reconstructs A's world.
        const peerB = await makePeer('b');
        const joined = await peerB.host.joinRoom();
        expect(joined).toBeTrue();

        // Let B reach A's tick (the relay clock may be slightly ahead).
        while ((peerB.world.resources.get(
            (await import('nova_ecs/plugins/time_plugin')).TimeResource)!.frame)
            < 60) {
            peerB.host.step();
        }

        const hashA = hashWorld(peerA.world, PEER_LOCAL_COMPONENTS);
        const hashB = hashWorld(peerB.world, PEER_LOCAL_COMPONENTS);
        expect(hashB.hash).toEqual(hashA.hash);
        expect(peerB.world.entities.has('ship a')).toBeTrue();
    }, 120_000);
});
