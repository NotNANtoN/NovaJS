import * as t from 'io-ts';
import { AngleType } from '../datatypes/angle';
import { BOUNDARY } from '../datatypes/position';
import { Vector } from '../datatypes/vector';
import { Entity } from '../entity';
import { EntityMap } from '../entity_map';
import {
    advanceMovementState, copyMovementState, MovementPhysics, MovementState,
} from './movement_plugin';

/**
 * Own-ship input prediction (Quake/Source style).
 *
 * The owning client turns each frame's controls into a command, applies it
 * immediately, and sends it to the server. The server applies the same
 * commands to its authoritative copy and acknowledges the last one applied
 * together with the resulting state. The client resets to that state, replays
 * the commands the server has not seen yet, and blends away any difference.
 *
 * Server-side effects (knockback, death, respawn, disabling) are plain writes
 * to the server's state and reach the owner through that acknowledgement.
 */

export const MovementCommand = t.type({
    seq: t.number,
    dtMs: t.number,
    accelerating: t.number,
    turning: t.number,
    turnBack: t.boolean,
    turnTo: t.union([AngleType, t.string, t.null]),
});
export type MovementCommand = t.TypeOf<typeof MovementCommand>;

export const InputAck = t.type({
    seq: t.number,
    state: MovementState,
});
export type InputAck = t.TypeOf<typeof InputAck>;

/** Browser frames longer than this are split across real time, not replayed. */
export const MAX_COMMAND_DT_MS = 100;
/** Corrections above this distance snap (respawn, teleport, jump arrival). */
export const SNAP_DISTANCE = 256;
/** Fraction of a correction applied per acknowledgement (about 30 Hz). */
export const CORRECTION_BLEND = 0.35;
/** Below this, a correction is adopted outright. */
const ADOPT_DISTANCE = 0.5;
const ADOPT_ANGLE = 0.002;
/** Unacknowledged commands after which the client stops predicting. */
export const MAX_PENDING_COMMANDS = 180;

/** How far the server may run behind real time before extrapolating. */
export const SERVER_STARVATION_MS = 100;
/** Continuous extrapolation after which the ship coasts without thrust. */
export const MAX_SERVER_EXTRAPOLATION_MS = 250;
/** Queued commands beyond which the server processes regardless of budget. */
export const MAX_SERVER_QUEUE = 30;
const MIN_SERVER_BUDGET_MS = -100;

export function clampCommandDt(dtMs: number): number {
    if (!Number.isFinite(dtMs) || dtMs <= 0) {
        return 0;
    }
    return Math.min(MAX_COMMAND_DT_MS, dtMs);
}

function clampUnit(value: number): number {
    return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

/** Validate a command received from a client; undefined if unusable. */
export function sanitizeCommand(command: MovementCommand): MovementCommand | undefined {
    if (!Number.isSafeInteger(command.seq) || command.seq <= 0) {
        return undefined;
    }
    const dtMs = clampCommandDt(command.dtMs);
    if (dtMs <= 0) {
        return undefined;
    }
    return {
        seq: command.seq,
        dtMs,
        accelerating: clampUnit(command.accelerating),
        turning: clampUnit(command.turning),
        turnBack: command.turnBack === true,
        turnTo: command.turnTo ?? null,
    };
}

function applyControls(state: MovementState, command: Omit<MovementCommand, 'seq' | 'dtMs'>) {
    state.accelerating = command.accelerating;
    state.turning = command.turning;
    state.turnBack = command.turnBack;
    state.turnTo = command.turnTo;
}

/** Apply one command's controls and integrate its duration. */
export function applyCommand(
    state: MovementState,
    physics: MovementPhysics,
    command: MovementCommand,
    entities: EntityMap,
    dtMs = command.dtMs,
): MovementState {
    const controlled = copyMovementState(state);
    applyControls(controlled, command);
    if (dtMs <= 0) {
        return controlled;
    }
    return advanceMovementState(controlled, physics, dtMs / 1000, entities);
}

export function commandFromState(state: MovementState, seq: number, dtMs: number): MovementCommand {
    return {
        seq,
        dtMs,
        accelerating: state.accelerating,
        turning: state.turning,
        turnBack: state.turnBack,
        turnTo: state.turnTo ?? null,
    };
}

/** Copy the integrated (non-control) fields of `from` into `into`. */
export function assignMovement(into: MovementState, from: MovementState) {
    into.position = from.position;
    into.velocity = from.velocity;
    into.rotation = from.rotation;
    into.accelerating = from.accelerating;
    into.turning = from.turning;
    into.turnBack = from.turnBack;
    into.turnTo = from.turnTo;
    if (from.targetSpeed === undefined) {
        delete into.targetSpeed;
    } else {
        into.targetSpeed = from.targetSpeed;
    }
}

function wrappedDelta(from: number, to: number): number {
    let delta = to - from;
    if (delta > BOUNDARY) delta -= BOUNDARY * 2;
    else if (delta < -BOUNDARY) delta += BOUNDARY * 2;
    return delta;
}

export type ReconcileResult = 'adopted' | 'blended' | 'snapped' | 'stale';

/** Client side of one predicted entity. */
export class ClientPrediction {
    readonly pending: MovementCommand[] = [];
    outbox: MovementCommand[] = [];
    lastAckSeq = 0;
    /** First command of this prediction session; older acks are stale. */
    firstSeq?: number;
    /** Last correction distance, for diagnostics and tests. */
    lastError = 0;

    constructor(private nextSeq: () => number) { }

    /** Record this frame's controls and integrate them. */
    predict(state: MovementState, physics: MovementPhysics, dtMs: number,
        entities: EntityMap): void {
        const dt = clampCommandDt(dtMs);
        if (dt <= 0) {
            return;
        }
        const command = commandFromState(state, this.nextSeq(), dt);
        this.firstSeq ??= command.seq;
        assignMovement(state, applyCommand(state, physics, command, entities));
        this.pending.push(command);
        this.outbox.push(command);
    }

    takeOutbox(): MovementCommand[] {
        const outbox = this.outbox;
        this.outbox = [];
        return outbox;
    }

    get starved(): boolean {
        return this.pending.length > MAX_PENDING_COMMANDS;
    }

    /**
     * Rebase on an authoritative state. Mutates `current` (the entity's
     * movement) toward the server state plus replayed unacknowledged input.
     */
    reconcile(ack: InputAck, current: MovementState, physics: MovementPhysics,
        entities: EntityMap): ReconcileResult {
        if (this.firstSeq === undefined || ack.seq < this.firstSeq
            || ack.seq < this.lastAckSeq) {
            return 'stale';
        }
        this.lastAckSeq = ack.seq;
        while (this.pending.length > 0 && this.pending[0].seq <= ack.seq) {
            this.pending.shift();
        }
        let corrected = copyMovementState(ack.state);
        for (const command of this.pending) {
            corrected = applyCommand(corrected, physics, command, entities);
        }
        const dx = wrappedDelta(current.position.x, corrected.position.x);
        const dy = wrappedDelta(current.position.y, corrected.position.y);
        const distance = Math.hypot(dx, dy);
        const angle = current.rotation.distanceTo(corrected.rotation).angle;
        this.lastError = distance;
        // Controls stay local: they are this frame's input, and the replay
        // ended with the same controls anyway.
        const controls = {
            accelerating: current.accelerating,
            turning: current.turning,
            turnBack: current.turnBack,
            turnTo: current.turnTo,
        };
        if (distance > SNAP_DISTANCE) {
            assignMovement(current, corrected);
            Object.assign(current, controls);
            return 'snapped';
        }
        if (distance <= ADOPT_DISTANCE && Math.abs(angle) <= ADOPT_ANGLE) {
            assignMovement(current, corrected);
            Object.assign(current, controls);
            return 'adopted';
        }
        // The next acknowledgement recomputes `corrected` from the server,
        // so a partial step converges geometrically without drifting.
        current.position = current.position.add(
            new Vector(dx * CORRECTION_BLEND, dy * CORRECTION_BLEND)) as typeof current.position;
        current.rotation = current.rotation.add(angle * CORRECTION_BLEND);
        current.velocity = corrected.velocity;
        if (corrected.targetSpeed === undefined) {
            delete current.targetSpeed;
        } else {
            current.targetSpeed = corrected.targetSpeed;
        }
        return 'blended';
    }
}

/**
 * Server side of one input-driven entity.
 *
 * Commands are applied in sequence order at most as fast as real time. When
 * input stops arriving, the ship keeps flying on its last controls so
 * observers never see it freeze. That extrapolated motion becomes part of
 * the authoritative state (it is never "paid back"), so every acknowledged
 * state is exactly the result of the acknowledged command plus whatever the
 * server added on top, and the owner reconciles to it once.
 */
export class ServerCommandQueue {
    readonly queue: MovementCommand[] = [];
    lastProcessedSeq: number;
    /** Whether any command of this session has been applied (ackable). */
    processedAny = false;
    /** Real time the authoritative copy still has to catch up on. */
    budgetMs = 0;
    /** Current run of extrapolation without input. */
    extrapolatedMs = 0;
    private lastControls?: Omit<MovementCommand, 'seq' | 'dtMs'>;

    constructor(firstSeq: number) {
        this.lastProcessedSeq = firstSeq - 1;
    }

    push(commands: readonly MovementCommand[]): void {
        for (const raw of commands) {
            const command = sanitizeCommand(raw);
            if (!command || command.seq <= this.lastProcessedSeq) {
                continue;
            }
            // Insert in sequence order; drop duplicates.
            let index = this.queue.length;
            while (index > 0 && this.queue[index - 1].seq > command.seq) {
                index--;
            }
            if (this.queue[index - 1]?.seq === command.seq) {
                continue;
            }
            this.queue.splice(index, 0, command);
        }
    }

    /** Server time the current state corresponds to. */
    stateTime(now: number): number {
        return now - Math.max(0, this.budgetMs);
    }

    /** Advance the authoritative state by one server tick. */
    step(state: MovementState, physics: MovementPhysics, tickMs: number,
        entities: EntityMap): void {
        this.budgetMs += tickMs;
        let current: MovementState | undefined;
        while (this.queue.length > 0
            && (this.budgetMs > 0 || this.queue.length > MAX_SERVER_QUEUE)) {
            // Wait for a missing command while there is time to spare; a
            // reordered packet usually fills the gap within a tick or two.
            const gap = this.queue[0].seq !== this.lastProcessedSeq + 1;
            if (gap && this.budgetMs <= SERVER_STARVATION_MS
                && this.queue.length <= MAX_SERVER_QUEUE) {
                break;
            }
            const command = this.queue.shift()!;
            current = applyCommand(current ?? state, physics, command, entities);
            this.budgetMs -= command.dtMs;
            this.lastProcessedSeq = command.seq;
            this.processedAny = true;
            this.lastControls = command;
            this.extrapolatedMs = 0;
        }
        this.budgetMs = Math.max(MIN_SERVER_BUDGET_MS, this.budgetMs);
        if (this.budgetMs > SERVER_STARVATION_MS && this.lastControls) {
            const extrapolateMs = this.budgetMs - SERVER_STARVATION_MS;
            const controls = this.extrapolatedMs >= MAX_SERVER_EXTRAPOLATION_MS
                ? { accelerating: 0, turning: 0, turnBack: false, turnTo: null }
                : this.lastControls;
            current = applyCommand(current ?? state, physics,
                { ...controls, seq: 0, dtMs: extrapolateMs }, entities);
            this.budgetMs = SERVER_STARVATION_MS;
            this.extrapolatedMs += extrapolateMs;
        }
        if (current) {
            assignMovement(state, current);
        }
    }
}

/**
 * Predicates (registered by game code) under which an owned entity must use
 * the client-authored pose path instead, e.g. scripted jump flight.
 */
const suspensions: Array<(entity: Entity) => boolean> = [];

export function suspendInputPredictionWhen(predicate: (entity: Entity) => boolean) {
    suspensions.push(predicate);
}

export function inputPredictionSuspended(entity: Entity): boolean {
    return suspensions.some(predicate => predicate(entity));
}

/** Whether the movement fields that input drives differ. */
export function controlsDiffer(a: MovementState, b: MovementState): boolean {
    const turnToA = a.turnTo instanceof Object ? a.turnTo.angle : a.turnTo ?? null;
    const turnToB = b.turnTo instanceof Object ? b.turnTo.angle : b.turnTo ?? null;
    return a.accelerating !== b.accelerating || a.turning !== b.turning
        || a.turnBack !== b.turnBack || turnToA !== turnToB;
}
