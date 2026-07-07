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

    it('convicts a peer after consecutive mismatched checkpoints', () => {
        relay.close();
        relay = new RollbackRelay(server, {
            autoClock: false,
            desyncThreshold: 3,
        });
        const report = (peer: MockCommunicator, tick: number, hash: string) =>
            peer.sendMessage(wrapRollbackMessage(
                { kind: 'stateHash', tick, hash }) as never, 'server');

        // Two mismatched checkpoints: below the threshold, no desync —
        // a rollback correction deeper than the settle margin briefly
        // makes honest reports describe an abandoned timeline.
        report(peerA, 60, '11111111');
        report(peerB, 60, '22222222');
        report(peerA, 120, '33333333');
        report(peerB, 120, '44444444');
        expect(received(peerA).length).toBe(0);

        // An agreeing checkpoint resets the streak...
        report(peerA, 180, '55555555');
        report(peerB, 180, '55555555');
        // ...so two more mismatches still stay quiet...
        report(peerA, 240, '66666666');
        report(peerB, 240, '77777777');
        report(peerA, 300, '88888888');
        report(peerB, 300, '99999999');
        expect(received(peerA).length).toBe(0);

        // ...but the third consecutive mismatch convicts.
        report(peerA, 360, 'aaaaaaaa');
        report(peerB, 360, 'bbbbbbbb');
        const expected: RollbackProtocolMessage = {
            kind: 'desync',
            tick: 360,
            hashes: [['a', 'aaaaaaaa'], ['b', 'bbbbbbbb']],
        };
        expect(received(peerA)).toEqual([expected]);
        expect(received(peerB)).toEqual([expected]);
    });

    it('adds the archive reference hash to desync votes', () => {
        relay.close();
        relay = new RollbackRelay(server, {
            autoClock: false,
            referenceHash: () => '11111111',
            desyncThreshold: 1,
        });
        peerA.sendMessage(wrapRollbackMessage({
            kind: 'stateHash', tick: 60, hash: '11111111',
        }) as never, 'server');
        peerB.sendMessage(wrapRollbackMessage({
            kind: 'stateHash', tick: 60, hash: '22222222',
        }) as never, 'server');
        const desyncs = received(peerB).filter(m => m.kind === 'desync');
        expect(desyncs).toEqual([{
            kind: 'desync',
            tick: 60,
            hashes: [
                ['a', '11111111'],
                ['b', '22222222'],
                // The archive's vote, under the server's identity:
                // peer a is provably the canonical one, so peer b
                // resyncs even though peers alone would be a tie.
                ['server', '11111111'],
            ],
        }]);
        expect(canonicalDesyncHash(desyncs[0]!.kind === 'desync'
            ? desyncs[0].hashes : [])).toBe('11111111');
    });

    it('convicts a lone peer that disagrees with the archive', () => {
        relay.close();
        relay = new RollbackRelay(server, {
            autoClock: false,
            referenceHash: () => '11111111',
            desyncThreshold: 1,
        });
        // Only peer a reports (b is throttled or gone). The set never
        // completes, so nothing fires until the stale sweep forces
        // the comparison — where the archive is the second witness.
        peerA.sendMessage(wrapRollbackMessage({
            kind: 'stateHash', tick: 60, hash: '22222222',
        }) as never, 'server');
        expect(received(peerA).length).toBe(0);
        (relay as unknown as {
            compareStateHashes(tick: number, force: boolean): void,
        }).compareStateHashes(60, true);
        const desyncs = received(peerA).filter(m => m.kind === 'desync');
        expect(desyncs).toEqual([{
            kind: 'desync',
            tick: 60,
            hashes: [['a', '22222222'], ['server', '11111111']],
        }]);
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

    it('prefers the server witness on ties', () => {
        const preferred = new Set(['server']);
        // 'a' sorts below 'server', but the archive is the log's true
        // simulation: the lone diverged peer must resync.
        expect(canonicalDesyncHash(
            [['a', 'x'], ['server', 'y']], preferred)).toBe('y');
        // Majority still beats preference.
        expect(canonicalDesyncHash(
            [['a', 'x'], ['b', 'x'], ['server', 'y']], preferred)).toBe('x');
    });
});
