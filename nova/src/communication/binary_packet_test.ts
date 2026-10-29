import 'jasmine';
import { isRight } from 'nova_ecs/either';
import { Message } from 'nova_ecs/plugins/multiplayer_plugin';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementState, quantizeMovementState } from 'nova_ecs/plugins/movement_plugin';
import {
    decodeFastBinaryPacket,
    isBinaryPacket,
    isUnreliableDatagramCandidate,
    tryEncodeFastBinaryPacket,
} from './binary_packet';
import { CommunicatorMessage, MessageType } from './CommunicatorMessage';
import { RtcDatagramClient, UnreliableDatagramClient } from './datagram_channel';
import { SocketChannelClient } from './SocketChannelClient';
import { SocketMessage } from './SocketMessage';
import { trackOn } from './test_utils';

function wrapGameMessage(
    inner: Message,
    options: { room?: string; source?: string; destination?: string | Set<string> } = {},
): SocketMessage {
    return JSON.parse(JSON.stringify(SocketMessage.encode({
        message: CommunicatorMessage.encode({
            type: MessageType.message,
            source: options.source ?? 'server',
            ...(options.destination !== undefined ? { destination: options.destination } : {}),
            message: {
                room: options.room ?? 'nova:128',
                message: Message.encode(inner),
            },
        }),
    })));
}

describe('Binary packet codec (P4) & Unreliable datagram channel (P5)', () => {
    it('round-trips client input command batches and clock probes with zero precision loss', () => {
        const original = wrapGameMessage({
            sentAt: 1712345678.125,
            clockProbe: { id: 42 },
            inputs: new Map([
                [
                    '550e8400-e29b-41d4-a716-446655440000',
                    [
                        {
                            seq: 101,
                            dtMs: 1000 / 60,
                            accelerating: 1,
                            turning: -1,
                            turnBack: false,
                            turnTo: null,
                        },
                        {
                            seq: 102,
                            dtMs: 1000 / 60,
                            accelerating: 0.75,
                            turning: 0.25,
                            turnBack: true,
                            turnTo: new Angle(1.23456789),
                        },
                        {
                            seq: 103,
                            dtMs: 1000 / 60,
                            accelerating: 0,
                            turning: 0,
                            turnBack: false,
                            turnTo: 'target-ship-uuid-99',
                        },
                    ],
                ],
            ]),
        }, { source: 'client-1', destination: 'server' });

        expect(isUnreliableDatagramCandidate(original)).toBeTrue();
        const bytes = tryEncodeFastBinaryPacket(original);
        expect(bytes).toBeDefined();
        expect(isBinaryPacket(bytes)).toBeTrue();

        const jsonBytes = Buffer.byteLength(JSON.stringify(original));
        expect(bytes!.byteLength).toBeLessThan(jsonBytes * 0.6);

        const decoded = decodeFastBinaryPacket(bytes!);
        expect(decoded).toEqual(original);
    });

    it('round-trips server inputAcks and clock replies with exact IEEE-754 float64 fidelity', () => {
        const original = wrapGameMessage({
            sentAt: 987654.321,
            clockReply: { id: 7, receivedAt: 987650.1, sentAt: 987654.321 },
            inputAcks: new Map([
                [
                    'player-ship-1',
                    {
                        seq: 512,
                        state: {
                            position: new Position(1234.567890123, -9876.543210987),
                            velocity: new Vector(234.56789, -111.222333),
                            rotation: new Angle(-2.718281828),
                            turning: 1,
                            turnBack: false,
                            accelerating: 1,
                            targetSpeed: 300.125,
                        },
                    },
                ],
            ]),
        });

        expect(isUnreliableDatagramCandidate(original)).toBeTrue();
        const bytes = tryEncodeFastBinaryPacket(original)!;
        expect(bytes).toBeDefined();
        const decoded = decodeFastBinaryPacket(bytes)!;
        expect(decoded).toEqual(original);
    });

    it('compresses multi-ship quantized movement snapshots by >60% compared to JSON', () => {
        const delta = new Map<string, any>();
        const movementTimestamps = new Map<string, number>();
        const movementSequences = new Map<string, number>();

        for (let i = 0; i < 12; i++) {
            const uuid = `550e8400-e29b-41d4-a716-4466554400${String(i).padStart(2, '0')}`;
            const state = quantizeMovementState({
                position: new Position(1000.25 + i * 37.5, -2000.75 + i * 19.25),
                velocity: new Vector(120.3 - i * 4.1, -85.7 + i * 2.2),
                rotation: new Angle(-1.571 + i * 0.125),
                turning: i % 3 === 0 ? 1 : i % 3 === 1 ? -1 : 0,
                turnBack: i % 4 === 0,
                accelerating: i % 2,
            });
            delta.set(uuid, {
                componentStates: new Map([['MovementState', MovementState.encode(state)]]),
            });
            movementTimestamps.set(uuid, 50000 + i * 16.666666666666668);
            movementSequences.set(uuid, 1000 + i);
        }

        const original = wrapGameMessage({
            sentAt: 50200,
            delta,
            movementTimestamps,
            movementSequences,
        });

        const jsonBytes = Buffer.byteLength(JSON.stringify(original));
        const binary = tryEncodeFastBinaryPacket(original)!;
        expect(binary).toBeDefined();
        expect(binary.byteLength).toBeLessThan(jsonBytes * 0.4);

        const decoded = decodeFastBinaryPacket(binary)!;
        expect(decoded).toEqual(original);
        const commDecoded = CommunicatorMessage.decode(decoded.message);
        expect(isRight(commDecoded)).toBeTrue();
        if (isRight(commDecoded) && commDecoded.right.type === MessageType.message) {
            const roomMsg = commDecoded.right.message as { room: string; message: unknown };
            const msgDecoded = Message.decode(roomMsg.message);
            expect(isRight(msgDecoded)).toBeTrue();
        }
    });

    it('keeps reliable messages (full state, chat, non-movement deltas, pings) on the JSON reliable path', () => {
        const pingMsg: SocketMessage = { ping: true };
        expect(isUnreliableDatagramCandidate(pingMsg)).toBeFalse();
        expect(tryEncodeFastBinaryPacket(pingMsg)).toBeUndefined();

        const chatMsg = wrapGameMessage({
            sentAt: 1000,
            chat: [{
                id: 'c1',
                from: 'p1',
                fromName: 'Pilot',
                to: 'all',
                text: 'Hello Frankfurt!',
                time: 1000,
            }],
        });
        expect(isUnreliableDatagramCandidate(chatMsg)).toBeFalse();
        expect(tryEncodeFastBinaryPacket(chatMsg)).toBeUndefined();
    });

    it('routes ephemeral movement/input packets over the unreliable datagram channel when open and falls back to WebSocket when closed', () => {
        const [callbacks, on] = trackOn();
        const webSocket = jasmine.createSpyObj<WebSocket>(
            'webSocketSpy',
            ['addEventListener', 'send', 'close', 'removeEventListener'],
            {
                CONNECTING: 0,
                OPEN: 1,
                CLOSING: 2,
                CLOSED: 3,
                readyState: 1,
            },
        );
        webSocket.addEventListener.and.callFake(on);

        const sentDatagrams: Uint8Array[] = [];
        let datagramOpen = true;
        const datagram: UnreliableDatagramClient = {
            get isOpen() {
                return datagramOpen;
            },
            send(payload: Uint8Array) {
                if (!datagramOpen) return false;
                sentDatagrams.push(payload);
                return true;
            },
            close: jasmine.createSpy('close'),
        };

        const client = new SocketChannelClient({ webSocket, datagram, warn: () => {} });
        const received: unknown[] = [];
        client.message.subscribe(m => received.push(m));

        // 1. Ephemeral input packet goes through the unreliable datagram channel
        const ephemeral = wrapGameMessage({
            sentAt: 100,
            clockProbe: { id: 1 },
        });
        client.send(ephemeral.message);
        expect(sentDatagrams.length).toBe(1);
        expect(webSocket.send).not.toHaveBeenCalled();

        // 2. Receiving that binary datagram on the client decodes and emits the message
        datagram.onDatagram!(sentDatagrams[0]);
        expect(received.length).toBe(1);
        expect(received[0]).toEqual(ephemeral.message);

        // 3. Reliable packet (e.g. room join) goes through the reliable WebSocket as JSON
        client.send({ type: MessageType.message, message: { room: 'nova:128', inRoom: true } });
        expect(sentDatagrams.length).toBe(1);
        expect(webSocket.send).toHaveBeenCalledTimes(1);
        expect(typeof webSocket.send.calls.mostRecent().args[0]).toBe('string');

        // 4. When datagram channel closes, ephemeral packets seamlessly fall back to binary WebSocket frames
        datagramOpen = false;
        client.send(ephemeral.message);
        expect(webSocket.send).toHaveBeenCalledTimes(2);
        expect(webSocket.send.calls.mostRecent().args[0]).toBeInstanceOf(Uint8Array);

        // 5. Receiving a binary frame over WebSocket also decodes and emits
        callbacks.message[0]({ data: webSocket.send.calls.mostRecent().args[0] } as MessageEvent);
        expect(received.length).toBe(2);
    });

    it('adapts an RTCDataChannel-like object via RtcDatagramClient', () => {
        const listeners = new Map<string, (ev: any) => void>();
        const rtcMock = {
            readyState: 'open',
            binaryType: 'blob',
            send: jasmine.createSpy('send'),
            close: jasmine.createSpy('close'),
            addEventListener: (type: string, fn: (ev: any) => void) => listeners.set(type, fn),
            removeEventListener: (type: string) => listeners.delete(type),
        };
        const adapter = new RtcDatagramClient(rtcMock);
        expect(rtcMock.binaryType).toBe('arraybuffer');
        expect(adapter.isOpen).toBeTrue();

        const sample = new Uint8Array([1, 2, 3]);
        expect(adapter.send(sample)).toBeTrue();
        expect(rtcMock.send).toHaveBeenCalledWith(sample);

        let received: ArrayBuffer | ArrayBufferView | undefined;
        adapter.onDatagram = data => { received = data; };
        listeners.get('message')?.({ data: sample });
        expect(received).toBe(sample);

        adapter.close();
        expect(rtcMock.close).toHaveBeenCalled();
    });
});
