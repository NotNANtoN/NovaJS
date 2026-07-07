import 'jasmine';
import { CommunicatorResource } from 'nova_ecs/plugins/multiplayer_plugin';
import { MockCommunicator } from 'nova_ecs/plugins/mock_communicator';
import { hashWorld } from 'nova_ecs/plugins/world_hash';
import { World } from 'nova_ecs/world';
import { makeShip } from '../nova_plugin/make_ship.js';
import { makeNpc } from '../nova_plugin/npc_plugin.js';
import { makeSystem } from '../nova_plugin/make_system.js';
import { completeEntity } from '../nova_plugin/entity_data_loader.js';
import { ControlledByComponent, PEER_LOCAL_COMPONENTS } from '../nova_plugin/ship_control.js';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { Position } from 'nova_ecs/datatypes/position';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Vector } from 'nova_ecs/datatypes/vector';
import { RollbackRelay } from './rollback_relay.js';
import { RoomArchive } from './room_archive.js';
import { unwrapRollbackMessage } from './rollback_protocol.js';
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
            // Insertion records integrate after async staging; real
            // clients await every step, so yield like they do.
            await new Promise(resolve => setImmediate(resolve));
        }
        // A few quiet ticks so the final records cross over.
        for (let i = 0; i < 5; i++) {
            peerA.host.step();
            peerB.host.step();
            await new Promise(resolve => setImmediate(resolve));
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

    it('a late joiner reconstructs from an archived baseline plus the log tail', async () => {
        // Replace the plain relay with one wired to a trailing archive
        // (short interval so the test stays quick).
        relay.close();
        let archive: RoomArchive | undefined;
        relay = new RollbackRelay(comms.get('server')!, {
            autoClock: false,
            baseline: () => archive?.latest,
        });
        const makeArchiveWorld = async () => {
            const gameData = await getIntegrationGameData();
            const ids = await gameData.ids;
            return makeSystem([...ids.System].sort()[0]!, gameData, 'node');
        };
        archive = new RoomArchive(relay, makeArchiveWorld,
            { intervalTicks: 30, autoUpdate: false });

        const peerA = await makePeer('a');
        await peerA.client.addEntity('ship a', await makePeerShip('a', peerA.world));
        for (let tick = 1; tick <= 90; tick++) {
            if (tick === 5) {
                peerA.host.controlEvents(
                    [{ action: 'accelerate', state: 'start' }]);
            }
            peerA.host.step();
            relay.advanceTicks(1);
            if (tick % 10 === 0) {
                await archive.update();
            }
        }
        await archive.update();
        expect(archive.latest).toBeDefined();
        expect(archive.latest!.tick).toBeGreaterThanOrEqual(60);
        // The log before the baseline is gone: reconstruction can no
        // longer start from genesis, only from the baseline.
        expect(relay.inputLog.every(
            record => record.tick > archive!.latest!.tick)).toBeTrue();

        const peerB = await makePeer('b');
        let baselineTick: number | undefined;
        comms.get('b')!.messages.subscribe(({ message }) => {
            const rollbackMessage = unwrapRollbackMessage(message);
            if (rollbackMessage?.kind === 'catchUp') {
                baselineTick = rollbackMessage.baseline?.tick;
            }
        });
        const joined = await peerB.host.joinRoom();
        expect(joined).toBeTrue();
        expect(baselineTick).toBe(archive.latest!.tick);

        const { TimeResource } = await import('nova_ecs/plugins/time_plugin');
        const target = peerA.world.resources.get(TimeResource)!.frame;
        while (peerB.world.resources.get(TimeResource)!.frame < target) {
            peerB.host.step();
        }
        const hashA = hashWorld(peerA.world, PEER_LOCAL_COMPONENTS);
        const hashB = hashWorld(peerB.world, PEER_LOCAL_COMPONENTS);
        expect(hashB.hash).toEqual(hashA.hash);
        expect(peerB.world.entities.has('ship a')).toBeTrue();
    }, 240_000);

    it('the archive tracks a land, ship purchase, and relaunch', async () => {
        // The spaceport flow as the room sees it: removeEntity at
        // landing, then addEntity of a *different* ship on the same
        // uuid at departure. The archive must simulate it identically
        // to the peers (live, the archive diverged around this
        // sequence).
        relay.close();
        let archive: RoomArchive | undefined;
        relay = new RollbackRelay(comms.get('server')!, {
            autoClock: false,
            baseline: () => archive?.latest,
            referenceHash: tick => archive?.hashAt(tick),
        });
        const makeArchiveWorld = async () => {
            const gameData = await getIntegrationGameData();
            const ids = await gameData.ids;
            return makeSystem([...ids.System].sort()[0]!, gameData, 'node');
        };
        archive = new RoomArchive(relay, makeArchiveWorld,
            { intervalTicks: 30, autoUpdate: false });

        const peerA = await makePeer('a');
        const peerB = await makePeer('b');
        await peerA.client.addEntity('ship a', await makePeerShip('a', peerA.world));

        const step = async (ticks: number) => {
            for (let i = 0; i < ticks; i++) {
                peerA.host.step();
                peerB.host.step();
                relay.advanceTicks(1);
                await new Promise(resolve => setImmediate(resolve));
            }
            await archive!.update();
        };

        await step(35);
        // Land: the ship leaves the simulation.
        peerA.client.removeEntity('ship a');
        await step(35);
        // Depart with a purchased ship: a fresh entity, same uuid.
        const gameData = await getIntegrationGameData();
        const carrierData = await gameData.data.Ship.get('nova:143');
        const carrier = makeShip(carrierData!);
        carrier.components.set(ControlledByComponent, { peerId: 'a' });
        await peerA.client.addEntity('ship a', carrier);
        await step(90);

        const hashArchive = hashWorld(archive.archiveWorld!, PEER_LOCAL_COMPONENTS);
        const hashA = hashWorld(peerA.world, PEER_LOCAL_COMPONENTS);
        const hashB = hashWorld(peerB.world, PEER_LOCAL_COMPONENTS);
        expect(hashB.hash).toEqual(hashA.hash);
        if (hashArchive.hash !== hashA.hash) {
            const { diffWorldHashes } = await import('nova_ecs/plugins/world_hash');
            fail('Archive diverged: '
                + diffWorldHashes(hashArchive, hashA).slice(0, 10).join('; '));
        }
    }, 240_000);

    it('combat and a player death stay in lockstep across peers and the archive', async () => {
        relay.close();
        let archive: RoomArchive | undefined;
        relay = new RollbackRelay(comms.get('server')!, {
            autoClock: false,
            baseline: () => archive?.latest,
            referenceHash: tick => archive?.hashAt(tick),
        });
        const makeArchiveWorld = async () => {
            const gameData = await getIntegrationGameData();
            const ids = await gameData.ids;
            return makeSystem([...ids.System].sort()[0]!, gameData, 'node');
        };
        archive = new RoomArchive(relay, makeArchiveWorld,
            { intervalTicks: 60, autoUpdate: false });

        const peerA = await makePeer('a');
        const peerB = await makePeer('b');
        // A's controlled shuttle between two hostile carriers: it will
        // die (exercising the respawn path) amid full combat
        // (missiles, turret bolts, blasts) that every world — worker
        // peers and the node archive — must simulate identically.
        const ship = await makePeerShip('a', peerA.world);
        await peerA.client.addEntity('ship a', ship);
        const gameData = await getIntegrationGameData();
        // A Fed Carrier (missiles, turrets, bays) and a Raven (beams,
        // point defense — the live-session loadout that coincided with
        // an archive divergence) both in weapons range.
        for (const [i, [shipId, x]] of ([
            ['nova:143', -120], ['nova:164', 320],
        ] as const).entries()) {
            const npcData = await gameData.data.Ship.get(shipId);
            const npc = makeNpc(npcData!);
            const movement = npc.components.get(MovementStateComponent)!;
            movement.position = new Position(x, 50);
            movement.rotation = new Angle(i === 0 ? Math.PI / 2 : -Math.PI / 2);
            movement.velocity = new Vector(0, 0);
            await completeEntity(peerA.world, npc);
            await peerA.client.addEntity(`npc ${i}`, npc);
        }

        for (let tick = 1; tick <= 900; tick++) {
            peerA.host.step();
            peerB.host.step();
            relay.advanceTicks(1);
            if (tick % 30 === 0) {
                await archive.update();
            }
            await new Promise(resolve => setImmediate(resolve));
        }
        await archive.update();

        const hashA = hashWorld(peerA.world, PEER_LOCAL_COMPONENTS);
        const hashB = hashWorld(peerB.world, PEER_LOCAL_COMPONENTS);
        const hashArchive = hashWorld(archive.archiveWorld!, PEER_LOCAL_COMPONENTS);
        expect(hashB.hash).toEqual(hashA.hash);
        if (hashArchive.hash !== hashA.hash) {
            const { diffWorldHashes } = await import('nova_ecs/plugins/world_hash');
            fail('Archive diverged: '
                + diffWorldHashes(hashArchive, hashA).slice(0, 10).join('; '));
        }
        // The player ship died and respawned (teleport bumps the
        // counter) — on every world, not just its owner's.
        const shipA = peerA.world.entities.get('ship a');
        expect(shipA).toBeDefined();
        expect(shipA!.components.get(MovementStateComponent)!.teleportCount ?? 0)
            .toBeGreaterThan(0);
        expect(peerB.world.entities.has('ship a')).toBeTrue();
        expect(archive.archiveWorld!.entities.has('ship a')).toBeTrue();
    }, 240_000);

    it('detects a desync and the diverged peer resyncs from the log', async () => {
        const peerA = await makePeer('a');
        const peerB = await makePeer('b');
        await peerA.client.addEntity('ship a', await makePeerShip('a', peerA.world));
        await peerB.client.addEntity('ship b', await makePeerShip('b', peerB.world));

        const desyncTicks: number[] = [];
        comms.get('a')!.messages.subscribe(({ message }) => {
            const rollbackMessage = unwrapRollbackMessage(message);
            if (rollbackMessage?.kind === 'desync') {
                desyncTicks.push(rollbackMessage.tick);
            }
        });

        for (let tick = 1; tick <= 50; tick++) {
            if (tick === 10) {
                peerA.host.controlEvents([{ action: 'accelerate', state: 'start' }]);
            }
            peerA.host.step();
            peerB.host.step();
            // Yield so async-staged insertion records integrate.
            await new Promise(resolve => setImmediate(resolve));
        }
        // Corrupt peer B outside the input timeline: from here its
        // simulation diverges from the log's true simulation.
        const shipB = peerB.world.entities.get('ship b')!;
        shipB.components.get(MovementStateComponent)!.position =
            new Position(500, 500);

        // The tick-60 checkpoint hashes differ; they settle and reach
        // the relay at tick 90.
        for (let tick = 51; tick <= 150 && desyncTicks.length === 0; tick++) {
            peerA.host.step();
            peerB.host.step();
            await new Promise(resolve => setImmediate(resolve));
        }
        expect(desyncTicks).toEqual([60]);
        expect(peerB.host.desyncCount).toBe(1);

        // 'a' wins the canonical tie-break, so B is the one resyncing:
        // genesis plus the relay's log. Let the async join finish, then
        // step B back up to A's tick.
        await new Promise(resolve => setTimeout(resolve));
        const { TimeResource } = await import('nova_ecs/plugins/time_plugin');
        const target = peerA.world.resources.get(TimeResource)!.frame;
        while (peerB.world.resources.get(TimeResource)!.frame < target) {
            peerB.host.step();
        }

        const hashA = hashWorld(peerA.world, PEER_LOCAL_COMPONENTS);
        const hashB = hashWorld(peerB.world, PEER_LOCAL_COMPONENTS);
        expect(hashB.hash).toEqual(hashA.hash);
        expect(peerB.world.entities.has('ship a')).toBeTrue();
        expect(peerB.world.entities.has('ship b')).toBeTrue();
    }, 240_000);
});
