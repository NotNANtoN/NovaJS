import { MessageType } from './CommunicatorMessage';
import { SocketMessage } from './SocketMessage';

/**
 * Magic header for NovaJS binary wire frames:
 * Byte 0: 0x4e ('N') — distinct from JSON frames which always start with 0x7b ('{').
 * Byte 1: 0x01 (protocol version 1).
 */
export const BINARY_PACKET_MAGIC = 0x4e;
export const BINARY_PACKET_VERSION = 0x01;

const FLAG_HAS_SOURCE = 1 << 0;
const FLAG_HAS_DEST_STRING = 1 << 1;
const FLAG_HAS_DEST_ARRAY = 1 << 2;
const FLAG_HAS_SENT_AT = 1 << 3;
const FLAG_HAS_CLOCK_PROBE = 1 << 4;
const FLAG_HAS_CLOCK_REPLY = 1 << 5;
const FLAG_HAS_INPUTS = 1 << 6;
const FLAG_HAS_SECTION_2 = 1 << 7;

const FLAG2_HAS_INPUT_ACKS = 1 << 0;
const FLAG2_HAS_MOVEMENT_DELTAS = 1 << 1;
const FLAG2_HAS_MOVEMENT_TIMESTAMPS = 1 << 2;
const FLAG2_HAS_MOVEMENT_SEQUENCES = 1 << 3;

const MOVE_HAS_POSITION = 1 << 0;
const MOVE_HAS_VELOCITY = 1 << 1;
const MOVE_HAS_ROTATION = 1 << 2;
const MOVE_HAS_TURNING = 1 << 3;
const MOVE_HAS_TURN_BACK = 1 << 4;
const MOVE_HAS_ACCELERATING = 1 << 5;
const MOVE_HAS_TURN_TO = 1 << 6;
const MOVE_HAS_TARGET_SPEED = 1 << 7;

const MOVE2_QUANTIZED_POS = 1 << 0;
const MOVE2_QUANTIZED_VEL = 1 << 1;
const MOVE2_QUANTIZED_ROT = 1 << 2;
const MOVE2_COMPACT_CONTROLS = 1 << 3;
const MOVE2_TURN_BACK_VALUE = 1 << 4;
const MOVE2_TURN_TO_KIND_SHIFT = 5; // 2 bits: 0=null, 1=angle, 2=string
const MOVE2_TARGET_SPEED_NULL = 1 << 7;

const ALLOWED_FAST_MESSAGE_KEYS = new Set([
    'sentAt',
    'clockProbe',
    'clockReply',
    'inputs',
    'inputAcks',
    'delta',
    'movementTimestamps',
    'movementSequences',
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class BinaryWriter {
    private buffer: ArrayBuffer;
    private view: DataView;
    private bytes: Uint8Array;
    offset = 0;
    readonly stringIndices = new Map<string, number>();
    readonly strings: string[] = [];

    constructor(initialCapacity = 512) {
        this.buffer = new ArrayBuffer(initialCapacity);
        this.view = new DataView(this.buffer);
        this.bytes = new Uint8Array(this.buffer);
    }

    internString(value: string): number {
        let index = this.stringIndices.get(value);
        if (index === undefined) {
            index = this.strings.length;
            this.strings.push(value);
            this.stringIndices.set(value, index);
        }
        return index;
    }

    private ensure(extra: number): void {
        const needed = this.offset + extra;
        if (needed <= this.buffer.byteLength) return;
        let nextCap = this.buffer.byteLength * 2;
        while (nextCap < needed) nextCap *= 2;
        const nextBuffer = new ArrayBuffer(nextCap);
        new Uint8Array(nextBuffer).set(this.bytes.subarray(0, this.offset));
        this.buffer = nextBuffer;
        this.view = new DataView(this.buffer);
        this.bytes = new Uint8Array(this.buffer);
    }

    writeU8(value: number): void {
        this.ensure(1);
        this.view.setUint8(this.offset, value & 0xff);
        this.offset += 1;
    }

    writeU16(value: number): void {
        this.ensure(2);
        this.view.setUint16(this.offset, value & 0xffff, true);
        this.offset += 2;
    }

    writeI16(value: number): void {
        this.ensure(2);
        this.view.setInt16(this.offset, value, true);
        this.offset += 2;
    }

    writeI32(value: number): void {
        this.ensure(4);
        this.view.setInt32(this.offset, value, true);
        this.offset += 4;
    }

    writeF64(value: number): void {
        this.ensure(8);
        this.view.setFloat64(this.offset, value, true);
        this.offset += 8;
    }

    writeRawBytes(data: Uint8Array): void {
        this.ensure(data.byteLength);
        this.bytes.set(data, this.offset);
        this.offset += data.byteLength;
    }

    writeStringRef(value: string): void {
        const idx = this.internString(value);
        if (this.strings.length <= 255 && idx < 255) {
            this.writeU8(idx);
        } else {
            this.writeU8(255);
            this.writeU16(idx);
        }
    }

    finish(): Uint8Array {
        return this.bytes.slice(0, this.offset);
    }
}

class BinaryReader {
    private view: DataView;
    private bytes: Uint8Array;
    offset = 0;
    strings: string[] = [];

    constructor(data: ArrayBuffer | ArrayBufferView) {
        if (ArrayBuffer.isView(data)) {
            this.bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        } else {
            this.bytes = new Uint8Array(data);
            this.view = new DataView(data);
        }
    }

    readU8(): number {
        const v = this.view.getUint8(this.offset);
        this.offset += 1;
        return v;
    }

    readU16(): number {
        const v = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return v;
    }

    readI16(): number {
        const v = this.view.getInt16(this.offset, true);
        this.offset += 2;
        return v;
    }

    readI32(): number {
        const v = this.view.getInt32(this.offset, true);
        this.offset += 4;
        return v;
    }

    readF64(): number {
        const v = this.view.getFloat64(this.offset, true);
        this.offset += 8;
        return v;
    }

    readStringRef(): string {
        const first = this.readU8();
        const idx = first === 255 ? this.readU16() : first;
        if (idx >= this.strings.length) {
            throw new RangeError('String table index out of bounds');
        }
        return this.strings[idx];
    }

    readRawString(): string {
        const byteLen = this.readU16();
        if (this.offset + byteLen > this.bytes.byteLength) {
            throw new RangeError('String length exceeds packet bounds');
        }
        const slice = this.bytes.subarray(this.offset, this.offset + byteLen);
        this.offset += byteLen;
        return textDecoder.decode(slice);
    }
}

function isExactQuarter(value: number): boolean {
    if (!Number.isFinite(value) || Object.is(value, -0)) return false;
    const scaled = Math.round(value * 4);
    return scaled >= -0x7fffffff && scaled <= 0x7fffffff && Object.is(scaled * 0.25, value);
}

function isExactTenth(value: number): boolean {
    if (!Number.isFinite(value) || Object.is(value, -0)) return false;
    const scaled = Math.round(value / 0.1);
    return scaled >= -0x7fffffff && scaled <= 0x7fffffff && Object.is(scaled * 0.1, value);
}

function isExactMilliAngle(value: number): boolean {
    if (!Number.isFinite(value) || Object.is(value, -0)) return false;
    const scaled = Math.round(value / 0.001);
    return scaled >= -32767 && scaled <= 32767 && Object.is(scaled * 0.001, value);
}

function encodeSmallIntControl(value: number): number | undefined {
    if (Object.is(value, 0)) return 0;
    if (Object.is(value, 1)) return 1;
    if (Object.is(value, -1)) return 2;
    return undefined;
}

function decodeSmallIntControl(code: number): number {
    if (code === 1) return 1;
    if (code === 2) return -1;
    return 0;
}

interface ExtractedMovementEntry {
    uuid: string;
    section: 'componentStates' | 'componentDeltas';
    movement: Record<string, any>;
}

function isPlainMovementObject(value: unknown): value is Record<string, any> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const obj = value as Record<string, any>;
    for (const key of Object.keys(obj)) {
        if (
            key !== 'position'
            && key !== 'velocity'
            && key !== 'rotation'
            && key !== 'turning'
            && key !== 'turnBack'
            && key !== 'accelerating'
            && key !== 'turnTo'
            && key !== 'targetSpeed'
        ) {
            return false;
        }
    }
    if ('position' in obj && obj.position !== undefined) {
        if (
            typeof obj.position !== 'object'
            || obj.position === null
            || typeof obj.position.x !== 'number'
            || typeof obj.position.y !== 'number'
        ) {
            return false;
        }
    }
    if ('velocity' in obj && obj.velocity !== undefined) {
        if (
            typeof obj.velocity !== 'object'
            || obj.velocity === null
            || typeof obj.velocity.x !== 'number'
            || typeof obj.velocity.y !== 'number'
        ) {
            return false;
        }
    }
    if ('rotation' in obj && obj.rotation !== undefined) {
        if (
            typeof obj.rotation !== 'object'
            || obj.rotation === null
            || typeof obj.rotation.angle !== 'number'
        ) {
            return false;
        }
    }
    if ('turning' in obj && obj.turning !== undefined && typeof obj.turning !== 'number') {
        return false;
    }
    if ('turnBack' in obj && obj.turnBack !== undefined && typeof obj.turnBack !== 'boolean') {
        return false;
    }
    if ('accelerating' in obj && obj.accelerating !== undefined && typeof obj.accelerating !== 'number') {
        return false;
    }
    if ('turnTo' in obj && obj.turnTo !== undefined && obj.turnTo !== null) {
        if (
            typeof obj.turnTo !== 'string'
            && (typeof obj.turnTo !== 'object' || typeof obj.turnTo.angle !== 'number')
        ) {
            return false;
        }
    }
    if (
        'targetSpeed' in obj
        && obj.targetSpeed !== undefined
        && obj.targetSpeed !== null
        && typeof obj.targetSpeed !== 'number'
    ) {
        return false;
    }
    return true;
}

function extractMovementOnlyDeltas(deltaArray: unknown): ExtractedMovementEntry[] | undefined {
    if (!Array.isArray(deltaArray)) return undefined;
    const out: ExtractedMovementEntry[] = [];
    for (const item of deltaArray) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string') {
            return undefined;
        }
        const [uuid, entityDelta] = item as [string, Record<string, any>];
        if (typeof entityDelta !== 'object' || entityDelta === null) {
            return undefined;
        }
        for (const key of Object.keys(entityDelta)) {
            if (key !== 'componentStates' && key !== 'componentDeltas' && key !== 'removeComponents') {
                return undefined;
            }
        }
        if (Array.isArray(entityDelta.removeComponents) && entityDelta.removeComponents.length > 0) {
            return undefined;
        }
        const states = entityDelta.componentStates;
        const deltas = entityDelta.componentDeltas;
        const hasStates = Array.isArray(states) && states.length > 0;
        const hasDeltas = Array.isArray(deltas) && deltas.length > 0;
        if (hasStates && hasDeltas) {
            return undefined;
        }
        if (!hasStates && !hasDeltas) {
            return undefined;
        }
        const list = (hasStates ? states : deltas) as unknown[];
        if (list.length !== 1) {
            return undefined;
        }
        const entry = list[0];
        if (
            !Array.isArray(entry)
            || entry.length !== 2
            || entry[0] !== 'MovementState'
            || !isPlainMovementObject(entry[1])
        ) {
            return undefined;
        }
        out.push({
            uuid,
            section: hasStates ? 'componentStates' : 'componentDeltas',
            movement: entry[1],
        });
    }
    return out;
}

function collectMovementStrings(writer: BinaryWriter, m: Record<string, any>): void {
    if (typeof m.turnTo === 'string') {
        writer.internString(m.turnTo);
    }
}

function writeMovementObject(writer: BinaryWriter, m: Record<string, any>): void {
    let mask = 0;
    let mask2 = 0;
    const hasPos = m.position !== undefined;
    const hasVel = m.velocity !== undefined;
    const hasRot = m.rotation !== undefined;
    const hasTurning = m.turning !== undefined;
    const hasTurnBack = m.turnBack !== undefined;
    const hasAcc = m.accelerating !== undefined;
    const hasTurnTo = 'turnTo' in m && m.turnTo !== undefined;
    const hasTargetSpeed = 'targetSpeed' in m && m.targetSpeed !== undefined;

    if (hasPos) mask |= MOVE_HAS_POSITION;
    if (hasVel) mask |= MOVE_HAS_VELOCITY;
    if (hasRot) mask |= MOVE_HAS_ROTATION;
    if (hasTurning) mask |= MOVE_HAS_TURNING;
    if (hasTurnBack) mask |= MOVE_HAS_TURN_BACK;
    if (hasAcc) mask |= MOVE_HAS_ACCELERATING;
    if (hasTurnTo) mask |= MOVE_HAS_TURN_TO;
    if (hasTargetSpeed) mask |= MOVE_HAS_TARGET_SPEED;

    const qPos = hasPos && isExactQuarter(m.position.x) && isExactQuarter(m.position.y);
    const qVel = hasVel && isExactTenth(m.velocity.x) && isExactTenth(m.velocity.y);
    const qRot = hasRot && isExactMilliAngle(m.rotation.angle);
    if (qPos) mask2 |= MOVE2_QUANTIZED_POS;
    if (qVel) mask2 |= MOVE2_QUANTIZED_VEL;
    if (qRot) mask2 |= MOVE2_QUANTIZED_ROT;

    const turnCode = hasTurning ? encodeSmallIntControl(m.turning) : 0;
    const accCode = hasAcc ? encodeSmallIntControl(m.accelerating) : 0;
    const compactControls = (turnCode !== undefined) && (accCode !== undefined);
    if (compactControls) mask2 |= MOVE2_COMPACT_CONTROLS;
    if (hasTurnBack && m.turnBack === true) mask2 |= MOVE2_TURN_BACK_VALUE;

    let turnToKind = 0;
    if (hasTurnTo) {
        if (m.turnTo === null) turnToKind = 0;
        else if (typeof m.turnTo === 'string') turnToKind = 2;
        else turnToKind = 1;
    }
    mask2 |= (turnToKind & 0x03) << MOVE2_TURN_TO_KIND_SHIFT;
    if (hasTargetSpeed && m.targetSpeed === null) {
        mask2 |= MOVE2_TARGET_SPEED_NULL;
    }

    writer.writeU8(mask);
    writer.writeU8(mask2);

    if (hasPos) {
        if (qPos) {
            writer.writeI32(Math.round(m.position.x * 4));
            writer.writeI32(Math.round(m.position.y * 4));
        } else {
            writer.writeF64(m.position.x);
            writer.writeF64(m.position.y);
        }
    }
    if (hasVel) {
        if (qVel) {
            writer.writeI32(Math.round(m.velocity.x / 0.1));
            writer.writeI32(Math.round(m.velocity.y / 0.1));
        } else {
            writer.writeF64(m.velocity.x);
            writer.writeF64(m.velocity.y);
        }
    }
    if (hasRot) {
        if (qRot) {
            writer.writeI16(Math.round(m.rotation.angle / 0.001));
        } else {
            writer.writeF64(m.rotation.angle);
        }
    }
    if (compactControls) {
        if (hasTurning || hasAcc) {
            writer.writeU8(((turnCode! & 0x03) << 2) | (accCode! & 0x03));
        }
    } else {
        if (hasTurning) writer.writeF64(m.turning);
        if (hasAcc) writer.writeF64(m.accelerating);
    }
    if (hasTurnTo) {
        if (turnToKind === 1) {
            writer.writeF64(m.turnTo.angle);
        } else if (turnToKind === 2) {
            writer.writeStringRef(m.turnTo);
        }
    }
    if (hasTargetSpeed && m.targetSpeed !== null) {
        writer.writeF64(m.targetSpeed);
    }
}

function readMovementObject(reader: BinaryReader): Record<string, any> {
    const mask = reader.readU8();
    const mask2 = reader.readU8();
    const out: Record<string, any> = {};

    if (mask & MOVE_HAS_POSITION) {
        if (mask2 & MOVE2_QUANTIZED_POS) {
            out.position = {
                x: reader.readI32() * 0.25,
                y: reader.readI32() * 0.25,
            };
        } else {
            out.position = {
                x: reader.readF64(),
                y: reader.readF64(),
            };
        }
    }
    if (mask & MOVE_HAS_VELOCITY) {
        if (mask2 & MOVE2_QUANTIZED_VEL) {
            out.velocity = {
                x: reader.readI32() * 0.1,
                y: reader.readI32() * 0.1,
            };
        } else {
            out.velocity = {
                x: reader.readF64(),
                y: reader.readF64(),
            };
        }
    }
    if (mask & MOVE_HAS_ROTATION) {
        if (mask2 & MOVE2_QUANTIZED_ROT) {
            out.rotation = { angle: reader.readI16() * 0.001 };
        } else {
            out.rotation = { angle: reader.readF64() };
        }
    }
    const hasTurning = (mask & MOVE_HAS_TURNING) !== 0;
    const hasAcc = (mask & MOVE_HAS_ACCELERATING) !== 0;
    if (mask2 & MOVE2_COMPACT_CONTROLS) {
        const packed = (hasTurning || hasAcc) ? reader.readU8() : 0;
        if (hasTurning) out.turning = decodeSmallIntControl((packed >> 2) & 0x03);
        if (hasAcc) out.accelerating = decodeSmallIntControl(packed & 0x03);
    } else {
        if (hasTurning) out.turning = reader.readF64();
        if (hasAcc) out.accelerating = reader.readF64();
    }
    if (mask & MOVE_HAS_TURN_BACK) {
        out.turnBack = (mask2 & MOVE2_TURN_BACK_VALUE) !== 0;
    }
    if (mask & MOVE_HAS_TURN_TO) {
        const kind = (mask2 >> MOVE2_TURN_TO_KIND_SHIFT) & 0x03;
        if (kind === 0) out.turnTo = null;
        else if (kind === 1) out.turnTo = { angle: reader.readF64() };
        else out.turnTo = reader.readStringRef();
    }
    if (mask & MOVE_HAS_TARGET_SPEED) {
        if (mask2 & MOVE2_TARGET_SPEED_NULL) {
            out.targetSpeed = null;
        } else {
            out.targetSpeed = reader.readF64();
        }
    }
    return out;
}

interface ParsedFastEnvelope {
    commMsg: Record<string, any>;
    roomMsg: Record<string, any>;
    innerMsg: Record<string, any>;
    movementDeltas: ExtractedMovementEntry[];
}

function inspectFastEnvelope(socketMessage: SocketMessage): ParsedFastEnvelope | undefined {
    if (socketMessage.ping || socketMessage.pong || !socketMessage.message) {
        return undefined;
    }
    const commMsg = socketMessage.message as Record<string, any>;
    if (
        typeof commMsg !== 'object'
        || commMsg === null
        || commMsg.type !== MessageType.message
        || typeof commMsg.message !== 'object'
        || commMsg.message === null
    ) {
        return undefined;
    }
    for (const k of Object.keys(commMsg)) {
        if (k !== 'type' && k !== 'message' && k !== 'source' && k !== 'destination') {
            return undefined;
        }
    }
    if (commMsg.source !== undefined && typeof commMsg.source !== 'string') {
        return undefined;
    }
    if (
        commMsg.destination !== undefined
        && typeof commMsg.destination !== 'string'
        && !(Array.isArray(commMsg.destination) && commMsg.destination.every((d: unknown) => typeof d === 'string'))
    ) {
        return undefined;
    }

    const roomMsg = commMsg.message as Record<string, any>;
    if (typeof roomMsg.room !== 'string' || typeof roomMsg.message !== 'object' || roomMsg.message === null) {
        return undefined;
    }
    for (const k of Object.keys(roomMsg)) {
        if (k !== 'room' && k !== 'message' && roomMsg[k] !== undefined) {
            return undefined;
        }
    }

    const innerMsg = roomMsg.message as Record<string, any>;
    const innerKeys = Object.keys(innerMsg).filter(k => innerMsg[k] !== undefined);
    if (innerKeys.length === 0) {
        return undefined;
    }
    for (const k of innerKeys) {
        if (!ALLOWED_FAST_MESSAGE_KEYS.has(k)) {
            return undefined;
        }
    }

    let movementDeltas: ExtractedMovementEntry[] = [];
    if (innerMsg.delta !== undefined) {
        const extracted = extractMovementOnlyDeltas(innerMsg.delta);
        if (!extracted) {
            return undefined;
        }
        movementDeltas = extracted;
    }

    if (innerMsg.inputs !== undefined) {
        if (!Array.isArray(innerMsg.inputs)) return undefined;
        for (const entry of innerMsg.inputs) {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) {
                return undefined;
            }
            for (const cmd of entry[1]) {
                if (
                    typeof cmd !== 'object'
                    || cmd === null
                    || typeof cmd.seq !== 'number'
                    || typeof cmd.dtMs !== 'number'
                    || typeof cmd.accelerating !== 'number'
                    || typeof cmd.turning !== 'number'
                    || typeof cmd.turnBack !== 'boolean'
                ) {
                    return undefined;
                }
            }
        }
    }

    if (innerMsg.inputAcks !== undefined) {
        if (!Array.isArray(innerMsg.inputAcks)) return undefined;
        for (const entry of innerMsg.inputAcks) {
            if (
                !Array.isArray(entry)
                || entry.length !== 2
                || typeof entry[0] !== 'string'
                || typeof entry[1] !== 'object'
                || entry[1] === null
                || typeof entry[1].seq !== 'number'
                || !isPlainMovementObject(entry[1].state)
            ) {
                return undefined;
            }
        }
    }

    if (innerMsg.movementTimestamps !== undefined) {
        if (
            !Array.isArray(innerMsg.movementTimestamps)
            || !innerMsg.movementTimestamps.every(
                (e: unknown) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'number',
            )
        ) {
            return undefined;
        }
    }

    if (innerMsg.movementSequences !== undefined) {
        if (
            !Array.isArray(innerMsg.movementSequences)
            || !innerMsg.movementSequences.every(
                (e: unknown) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'number',
            )
        ) {
            return undefined;
        }
    }

    return { commMsg, roomMsg, innerMsg, movementDeltas };
}

/**
 * Classifies whether a `SocketMessage` is a pure ephemeral high-frequency
 * gameplay packet (movement snapshots, input commands, input acks, clock probes)
 * that can safely travel over an unordered, unreliable datagram channel without
 * risking desynchronization of reliable entity/component state.
 */
export function isUnreliableDatagramCandidate(socketMessage: SocketMessage): boolean {
    return inspectFastEnvelope(socketMessage) !== undefined;
}

/**
 * Encodes a high-frequency gameplay `SocketMessage` into a compact binary
 * `Uint8Array` frame with packet-local string interning and lossless fixed-point
 * movement quantization. Returns `undefined` for control/reliable packets that
 * should use the standard JSON frame path.
 */
export function tryEncodeFastBinaryPacket(socketMessage: SocketMessage): Uint8Array | undefined {
    const inspected = inspectFastEnvelope(socketMessage);
    if (!inspected) {
        return undefined;
    }
    const { commMsg, roomMsg, innerMsg, movementDeltas } = inspected;
    const body = new BinaryWriter(512);

    // Pre-intern all strings in deterministic order
    body.internString(roomMsg.room);
    if (typeof commMsg.source === 'string') {
        body.internString(commMsg.source);
    }
    if (typeof commMsg.destination === 'string') {
        body.internString(commMsg.destination);
    } else if (Array.isArray(commMsg.destination)) {
        for (const dest of commMsg.destination) {
            body.internString(dest);
        }
    }
    if (Array.isArray(innerMsg.inputs)) {
        for (const [uuid, cmds] of innerMsg.inputs) {
            body.internString(uuid);
            for (const cmd of cmds) {
                if (typeof cmd.turnTo === 'string') {
                    body.internString(cmd.turnTo);
                }
            }
        }
    }
    if (Array.isArray(innerMsg.inputAcks)) {
        for (const [uuid, ack] of innerMsg.inputAcks) {
            body.internString(uuid);
            collectMovementStrings(body, ack.state);
        }
    }
    for (const entry of movementDeltas) {
        body.internString(entry.uuid);
        collectMovementStrings(body, entry.movement);
    }
    if (Array.isArray(innerMsg.movementTimestamps)) {
        for (const [uuid] of innerMsg.movementTimestamps) {
            body.internString(uuid);
        }
    }
    if (Array.isArray(innerMsg.movementSequences)) {
        for (const [uuid] of innerMsg.movementSequences) {
            body.internString(uuid);
        }
    }

    let flags1 = 0;
    let flags2 = 0;
    if (typeof commMsg.source === 'string') flags1 |= FLAG_HAS_SOURCE;
    if (typeof commMsg.destination === 'string') flags1 |= FLAG_HAS_DEST_STRING;
    else if (Array.isArray(commMsg.destination)) flags1 |= FLAG_HAS_DEST_ARRAY;
    if (typeof innerMsg.sentAt === 'number') flags1 |= FLAG_HAS_SENT_AT;
    if (innerMsg.clockProbe !== undefined) flags1 |= FLAG_HAS_CLOCK_PROBE;
    if (innerMsg.clockReply !== undefined) flags1 |= FLAG_HAS_CLOCK_REPLY;
    if (Array.isArray(innerMsg.inputs)) flags1 |= FLAG_HAS_INPUTS;

    if (Array.isArray(innerMsg.inputAcks)) flags2 |= FLAG2_HAS_INPUT_ACKS;
    if (innerMsg.delta !== undefined) flags2 |= FLAG2_HAS_MOVEMENT_DELTAS;
    if (Array.isArray(innerMsg.movementTimestamps)) flags2 |= FLAG2_HAS_MOVEMENT_TIMESTAMPS;
    if (Array.isArray(innerMsg.movementSequences)) flags2 |= FLAG2_HAS_MOVEMENT_SEQUENCES;
    if (flags2 !== 0) flags1 |= FLAG_HAS_SECTION_2;

    body.writeU8(flags1);
    if (flags2 !== 0) {
        body.writeU8(flags2);
    }

    body.writeStringRef(roomMsg.room);
    if (flags1 & FLAG_HAS_SOURCE) {
        body.writeStringRef(commMsg.source);
    }
    if (flags1 & FLAG_HAS_DEST_STRING) {
        body.writeStringRef(commMsg.destination);
    } else if (flags1 & FLAG_HAS_DEST_ARRAY) {
        body.writeU16(commMsg.destination.length);
        for (const dest of commMsg.destination) {
            body.writeStringRef(dest);
        }
    }

    if (flags1 & FLAG_HAS_SENT_AT) {
        body.writeF64(innerMsg.sentAt);
    }
    if (flags1 & FLAG_HAS_CLOCK_PROBE) {
        body.writeF64(innerMsg.clockProbe.id);
    }
    if (flags1 & FLAG_HAS_CLOCK_REPLY) {
        body.writeF64(innerMsg.clockReply.id);
        body.writeF64(innerMsg.clockReply.receivedAt);
        body.writeF64(innerMsg.clockReply.sentAt);
    }

    if (flags1 & FLAG_HAS_INPUTS) {
        const inputs = innerMsg.inputs as Array<[string, Array<Record<string, any>>]>;
        body.writeU16(inputs.length);
        for (const [uuid, cmds] of inputs) {
            body.writeStringRef(uuid);
            body.writeU16(cmds.length);
            for (const cmd of cmds) {
                body.writeF64(cmd.seq);
                body.writeF64(cmd.dtMs);
                const accCode = encodeSmallIntControl(cmd.accelerating);
                const turnCode = encodeSmallIntControl(cmd.turning);
                const compact = accCode !== undefined && turnCode !== undefined;
                let turnToKind = 0;
                if (cmd.turnTo !== null && cmd.turnTo !== undefined) {
                    turnToKind = typeof cmd.turnTo === 'string' ? 2 : 1;
                }
                let cmdFlags = 0;
                if (cmd.turnBack) cmdFlags |= 1 << 0;
                cmdFlags |= (turnToKind & 0x03) << 1;
                if (compact) {
                    cmdFlags |= 1 << 3;
                    cmdFlags |= (accCode! & 0x03) << 4;
                    cmdFlags |= (turnCode! & 0x03) << 6;
                }
                body.writeU8(cmdFlags);
                if (!compact) {
                    body.writeF64(cmd.accelerating);
                    body.writeF64(cmd.turning);
                }
                if (turnToKind === 1) {
                    body.writeF64(cmd.turnTo.angle);
                } else if (turnToKind === 2) {
                    body.writeStringRef(cmd.turnTo);
                }
            }
        }
    }

    if (flags2 & FLAG2_HAS_INPUT_ACKS) {
        const acks = innerMsg.inputAcks as Array<[string, { seq: number; state: Record<string, any> }]>;
        body.writeU16(acks.length);
        for (const [uuid, ack] of acks) {
            body.writeStringRef(uuid);
            body.writeF64(ack.seq);
            writeMovementObject(body, ack.state);
        }
    }

    if (flags2 & FLAG2_HAS_MOVEMENT_DELTAS) {
        body.writeU16(movementDeltas.length);
        for (const entry of movementDeltas) {
            body.writeStringRef(entry.uuid);
            body.writeU8(entry.section === 'componentStates' ? 0 : 1);
            writeMovementObject(body, entry.movement);
        }
    }

    if (flags2 & FLAG2_HAS_MOVEMENT_TIMESTAMPS) {
        const ts = innerMsg.movementTimestamps as Array<[string, number]>;
        body.writeU16(ts.length);
        for (const [uuid, at] of ts) {
            body.writeStringRef(uuid);
            body.writeF64(at);
        }
    }

    if (flags2 & FLAG2_HAS_MOVEMENT_SEQUENCES) {
        const seqs = innerMsg.movementSequences as Array<[string, number]>;
        body.writeU16(seqs.length);
        for (const [uuid, seq] of seqs) {
            body.writeStringRef(uuid);
            body.writeF64(seq);
        }
    }

    const bodyBytes = body.finish();
    const out = new BinaryWriter(64 + bodyBytes.byteLength);
    out.writeU8(BINARY_PACKET_MAGIC);
    out.writeU8(BINARY_PACKET_VERSION);
    out.writeU16(body.strings.length);
    for (const s of body.strings) {
        const encoded = textEncoder.encode(s);
        out.writeU16(encoded.byteLength);
        out.writeRawBytes(encoded);
    }
    out.writeRawBytes(bodyBytes);
    return out.finish();
}

export function isBinaryPacket(data: unknown): data is ArrayBuffer | ArrayBufferView {
    if (data instanceof ArrayBuffer) {
        if (data.byteLength < 2) return false;
        const view = new Uint8Array(data, 0, 2);
        return view[0] === BINARY_PACKET_MAGIC && view[1] === BINARY_PACKET_VERSION;
    }
    if (ArrayBuffer.isView(data)) {
        if (data.byteLength < 2) return false;
        const view = new Uint8Array(data.buffer, data.byteOffset, 2);
        return view[0] === BINARY_PACKET_MAGIC && view[1] === BINARY_PACKET_VERSION;
    }
    return false;
}

export function decodeFastBinaryPacket(data: ArrayBuffer | ArrayBufferView): SocketMessage | undefined {
    try {
        const reader = new BinaryReader(data);
        const magic = reader.readU8();
        const version = reader.readU8();
        if (magic !== BINARY_PACKET_MAGIC || version !== BINARY_PACKET_VERSION) {
            return undefined;
        }
        const stringCount = reader.readU16();
        const strings: string[] = new Array(stringCount);
        for (let i = 0; i < stringCount; i++) {
            strings[i] = reader.readRawString();
        }
        reader.strings = strings;

        const flags1 = reader.readU8();
        const flags2 = (flags1 & FLAG_HAS_SECTION_2) ? reader.readU8() : 0;

        const room = reader.readStringRef();
        const commMsg: Record<string, any> = {
            type: MessageType.message,
        };
        if (flags1 & FLAG_HAS_SOURCE) {
            commMsg.source = reader.readStringRef();
        }
        if (flags1 & FLAG_HAS_DEST_STRING) {
            commMsg.destination = reader.readStringRef();
        } else if (flags1 & FLAG_HAS_DEST_ARRAY) {
            const count = reader.readU16();
            const dests: string[] = new Array(count);
            for (let i = 0; i < count; i++) {
                dests[i] = reader.readStringRef();
            }
            commMsg.destination = dests;
        }

        const innerMsg: Record<string, any> = {};
        if (flags1 & FLAG_HAS_SENT_AT) {
            innerMsg.sentAt = reader.readF64();
        }
        if (flags1 & FLAG_HAS_CLOCK_PROBE) {
            innerMsg.clockProbe = { id: reader.readF64() };
        }
        if (flags1 & FLAG_HAS_CLOCK_REPLY) {
            innerMsg.clockReply = {
                id: reader.readF64(),
                receivedAt: reader.readF64(),
                sentAt: reader.readF64(),
            };
        }
        if (flags1 & FLAG_HAS_INPUTS) {
            const entityCount = reader.readU16();
            const inputs: Array<[string, Array<Record<string, any>>]> = new Array(entityCount);
            for (let i = 0; i < entityCount; i++) {
                const uuid = reader.readStringRef();
                const cmdCount = reader.readU16();
                const cmds: Array<Record<string, any>> = new Array(cmdCount);
                for (let j = 0; j < cmdCount; j++) {
                    const seq = reader.readF64();
                    const dtMs = reader.readF64();
                    const cmdFlags = reader.readU8();
                    const turnBack = (cmdFlags & (1 << 0)) !== 0;
                    const turnToKind = (cmdFlags >> 1) & 0x03;
                    const compact = (cmdFlags & (1 << 3)) !== 0;
                    let accelerating: number;
                    let turning: number;
                    if (compact) {
                        accelerating = decodeSmallIntControl((cmdFlags >> 4) & 0x03);
                        turning = decodeSmallIntControl((cmdFlags >> 6) & 0x03);
                    } else {
                        accelerating = reader.readF64();
                        turning = reader.readF64();
                    }
                    let turnTo: { angle: number } | string | null = null;
                    if (turnToKind === 1) {
                        turnTo = { angle: reader.readF64() };
                    } else if (turnToKind === 2) {
                        turnTo = reader.readStringRef();
                    }
                    cmds[j] = {
                        seq,
                        dtMs,
                        accelerating,
                        turning,
                        turnBack,
                        turnTo,
                    };
                }
                inputs[i] = [uuid, cmds];
            }
            innerMsg.inputs = inputs;
        }
        if (flags2 & FLAG2_HAS_INPUT_ACKS) {
            const count = reader.readU16();
            const acks: Array<[string, { seq: number; state: Record<string, any> }]> = new Array(count);
            for (let i = 0; i < count; i++) {
                const uuid = reader.readStringRef();
                const seq = reader.readF64();
                const state = readMovementObject(reader);
                acks[i] = [uuid, { seq, state }];
            }
            innerMsg.inputAcks = acks;
        }
        if (flags2 & FLAG2_HAS_MOVEMENT_DELTAS) {
            const count = reader.readU16();
            const delta: Array<[string, Record<string, any>]> = new Array(count);
            for (let i = 0; i < count; i++) {
                const uuid = reader.readStringRef();
                const sectionKind = reader.readU8();
                const movement = readMovementObject(reader);
                const entry: [string, Record<string, any>] = ['MovementState', movement];
                delta[i] = [
                    uuid,
                    sectionKind === 0
                        ? { componentStates: [entry] }
                        : { componentDeltas: [entry] },
                ];
            }
            innerMsg.delta = delta;
        }
        if (flags2 & FLAG2_HAS_MOVEMENT_TIMESTAMPS) {
            const count = reader.readU16();
            const ts: Array<[string, number]> = new Array(count);
            for (let i = 0; i < count; i++) {
                ts[i] = [reader.readStringRef(), reader.readF64()];
            }
            innerMsg.movementTimestamps = ts;
        }
        if (flags2 & FLAG2_HAS_MOVEMENT_SEQUENCES) {
            const count = reader.readU16();
            const seqs: Array<[string, number]> = new Array(count);
            for (let i = 0; i < count; i++) {
                seqs[i] = [reader.readStringRef(), reader.readF64()];
            }
            innerMsg.movementSequences = seqs;
        }

        commMsg.message = {
            room,
            message: innerMsg,
        };
        return { message: commMsg };
    } catch {
        return undefined;
    }
}
