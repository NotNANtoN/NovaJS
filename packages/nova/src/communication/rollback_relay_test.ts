import 'jasmine';
import { MockCommunicator } from 'nova_ecs/plugins/mock_communicator';
import { RollbackRelay } from './rollback_relay.js';
import { canonicalDesyncHash, RollbackProtocolMessage, unwrapRollbackMessage, wrapRollbackMessage } from './rollback_protocol.js';
import { SimulationInput } from './simulation_input.js';

const CONTROL: SimulationInput[] = [
    { kind: 'control', events: [{ action: 'accelerate', state: 'start' }] },
];

describe('RollbackRelay', () => {
    let server: MockCommunicator;
    let peerA: MockCommunicator;
    let peerB: MockCommunicator;
    let relay: RollbackRelay;

    function received(peer: MockCommunicator): RollbackProtocolMessage[] {
        return peer.allMessages
            .map(m => unwrapRollbackMessage((m as { message: unknown }).message))
            .filter((m): m is RollbackProtocolMessage => m !== undefined);
    }

    beforeEach(() => {
        server = new MockCommunicator('server');
        peerA = new MockCommunicator('a');
        peerB = new MockCommunicator('b');
        const mockPeers = new Map([
            ['server', server], ['a', peerA], ['b', peerB],
        ]);
        for (const peer of mockPeers.values()) {
            peer.mockPeers = mockPeers;
            peer.peers.current.next(new Set(mockPeers.keys()));
        }
        relay = new RollbackRelay(server, { autoClock: false });
    });

    afterEach(() => {
        relay.close();
    });

    it('relays input records to the other peers and archives them', () => {
        peerA.sendMessage(wrapRollbackMessage({
            kind: 'inputs',
            record: { peerId: 'a', tick: 5, inputs: CONTROL },
        }) as never, 'server');

        const atB = received(peerB);
        expect(atB.length).toBe(1);
        expect(atB[0]).toEqual({
            kind: 'inputs',
            record: { peerId: 'a', tick: 5, inputs: CONTROL },
        });
        // The sender does not get an echo.
        expect(received(peerA).length).toBe(0);
        expect(relay.inputLog.length).toBe(1);
    });

    it('stamps the sender and clamps inputs out of the past', () => {
        relay.advanceTicks(100);
        peerA.sendMessage(wrapRollbackMessage({
            kind: 'inputs',
            // Claims to be someone else, in the past.
            record: { peerId: 'b', tick: 3, inputs: CONTROL },
        }) as never, 'server');

        expect(relay.inputLog[0]).toEqual({
            peerId: 'a',
            tick: 101,
            inputs: CONTROL,
        });
    });

    it('serves the input log from a tick to late joiners', () => {
        for (const tick of [5, 15, 25]) {
            peerA.sendMessage(wrapRollbackMessage({
                kind: 'inputs',
                record: { peerId: 'a', tick, inputs: CONTROL },
            }) as never, 'server');
        }
        peerB.allMessages.length = 0;
        peerB.sendMessage(wrapRollbackMessage({
            kind: 'inputLogRequest', fromTick: 10,
        }) as never, 'server');

        const atB = received(peerB);
        expect(atB.length).toBe(1);
        expect(atB[0]?.kind).toBe('inputLog');
        if (atB[0]?.kind !== 'inputLog') {
            return;
        }
        expect(atB[0].records.map(r => r.tick)).toEqual([15, 25]);
    });

    it('broadcasts a desync when peers report mismatched state hashes', () => {
        peerA.sendMessage(wrapRollbackMessage({
            kind: 'stateHash', tick: 60, hash: '11111111',
        }) as never, 'server');
        // Nothing happens until every peer has reported the tick.
        expect(received(peerB).length).toBe(0);

        peerB.sendMessage(wrapRollbackMessage({
            kind: 'stateHash', tick: 60, hash: '22222222',
        }) as never, 'server');
        const expected: RollbackProtocolMessage = {
            kind: 'desync',
            tick: 60,
            hashes: [['a', '11111111'], ['b', '22222222']],
        };
        expect(received(peerA)).toEqual([expected]);
        expect(received(peerB)).toEqual([expected]);
    });

    it('stays quiet when state hashes agree', () => {
        for (const peer of [peerA, peerB]) {
            peer.sendMessage(wrapRollbackMessage({
                kind: 'stateHash', tick: 60, hash: '33333333',
            }) as never, 'server');
        }
        expect(received(peerA).length).toBe(0);
        expect(received(peerB).length).toBe(0);
    });

    it('broadcasts its clock', () => {
        relay.advanceTicks(42);
        // Simulate the periodic sync manually (autoClock is off).
        server.sendMessage(wrapRollbackMessage({ kind: 'tickSync', tick: relay.tick }) as never);
        const atA = received(peerA);
        expect(atA).toEqual([{ kind: 'tickSync', tick: 42 }]);
    });
});

describe('canonicalDesyncHash', () => {
    it('picks the majority hash', () => {
        expect(canonicalDesyncHash([
            ['a', 'x'], ['b', 'y'], ['c', 'x'],
        ])).toBe('x');
    });

    it('breaks ties toward the lowest peerId', () => {
        expect(canonicalDesyncHash([['b', 'y'], ['a', 'x']])).toBe('x');
        expect(canonicalDesyncHash([['a', 'x'], ['b', 'y']])).toBe('x');
    });
});
