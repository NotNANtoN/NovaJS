import * as t from 'io-ts';
import { Component } from 'nova_ecs/component';
import { Angle, AngleType } from 'nova_ecs/datatypes/angle';
import { Position, PositionType } from 'nova_ecs/datatypes/position';
import { Vector, VectorType } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { replicationPolicies } from 'nova_ecs/plugins/multiplayer_plugin';

export const FIRE_BUFFER_SIZE = 16;

export const FireIntentShot = t.intersection([
    t.type({
        seq: t.number,
        weaponId: t.string,
        seed: t.number,
        exitIndex: t.number,
    }),
    t.partial({
        target: t.string,
        /**
         * The owner's predicted muzzle pose, in the server clock domain.
         * The server fires from this pose (after a plausibility check) and
         * fast-forwards by the shot's age, so its projectile follows the
         * path the shooter already sees instead of snapping to a new one.
         */
        at: t.number,
        position: PositionType,
        rotation: AngleType,
        sourceVelocity: VectorType,
        inaccuracy: t.number,
        /**
         * How far in the past the shooter was presenting remote entities
         * when it fired. The server rewinds targets by this much when it
         * resolves the shot's hits (lag compensation).
         */
        viewDelayMs: t.number,
    }),
]);
export type FireIntentShot = t.TypeOf<typeof FireIntentShot>;

export const FireIntent = t.type({
    shots: t.array(FireIntentShot),
});
export type FireIntent = t.TypeOf<typeof FireIntent>;
export const FireIntentComponent =
    new Component<FireIntent>('FireIntentComponent');

export const FireLogShot = t.intersection([
    t.type({
        seq: t.number,
        weaponId: t.string,
        seed: t.number,
        exitIndex: t.number,
        at: t.number,
        position: PositionType,
        rotation: AngleType,
    }),
    t.partial({
        // Server emission order can differ from client intent order across weapons.
        logSeq: t.number,
        sourceVelocity: VectorType,
        target: t.string,
        inaccuracy: t.number,
    }),
]);
export type FireLogShot = t.TypeOf<typeof FireLogShot>;

export const FireLog = t.type({
    shots: t.array(FireLogShot),
});
export type FireLog = t.TypeOf<typeof FireLog>;
export const FireLogComponent = new Component<FireLog>('FireLogComponent');

export const FireIntentDelta = t.type({
    shots: t.array(FireIntentShot),
});
export type FireIntentDelta = t.TypeOf<typeof FireIntentDelta>;

export function getFireIntentDelta(
    previous: FireIntent | undefined,
    current: FireIntent,
): FireIntentDelta | undefined {
    if (!previous || !previous.shots || previous.shots.length === 0) {
        return current.shots && current.shots.length > 0 ? { shots: [...current.shots] } : undefined;
    }
    const highestPrevSeq = Math.max(0, ...previous.shots.map(s => s.seq));
    const newShots = current.shots.filter(s => s.seq > highestPrevSeq);
    return newShots.length > 0 ? { shots: newShots } : undefined;
}

export function applyFireIntentDelta(
    currentData: FireIntent,
    delta: FireIntentDelta,
): FireIntent {
    if (!currentData.shots) {
        currentData.shots = [];
    }
    for (const shot of delta.shots) {
        pushShot(currentData.shots, shot);
    }
    return currentData;
}

export const FireLogDelta = t.type({
    shots: t.array(FireLogShot),
});
export type FireLogDelta = t.TypeOf<typeof FireLogDelta>;

export function getFireLogDelta(
    previous: FireLog | undefined,
    current: FireLog,
): FireLogDelta | undefined {
    if (!previous || !previous.shots || previous.shots.length === 0) {
        return current.shots && current.shots.length > 0 ? { shots: [...current.shots] } : undefined;
    }
    const highestPrevSeq = Math.max(0, ...previous.shots.map(fireLogSequence));
    const newShots = current.shots.filter(s => fireLogSequence(s) > highestPrevSeq);
    return newShots.length > 0 ? { shots: newShots } : undefined;
}

export function applyFireLogDelta(
    currentData: FireLog,
    delta: FireLogDelta,
): FireLog {
    if (!currentData.shots) {
        currentData.shots = [];
    }
    for (const shot of delta.shots) {
        pushShot(currentData.shots, shot);
    }
    return currentData;
}

replicationPolicies.register(FireIntentComponent, {
    codec: FireIntent,
    authority: 'owning-client',
    relay: false,
});
replicationPolicies.register(FireLogComponent, {
    codec: FireLog,
    authority: 'server',
});

/**
 * Where the server resolved a synchronized shot's hit. Recorded on the
 * firing ship so it shares that ship's interest set and replication.
 */
export const ShotImpact = t.intersection([
    t.type({
        /** Monotonic per firing ship; impacts need not follow shot order. */
        impactSeq: t.number,
        /** The fire event sequence (`loggedShotEntityId(ship, seq)`). */
        seq: t.number,
        /** Server simulation time of the hit. */
        at: t.number,
        position: PositionType,
    }),
    t.partial({
        target: t.string,
    }),
]);
export type ShotImpact = t.TypeOf<typeof ShotImpact>;

export const ShotImpactLog = t.type({
    impacts: t.array(ShotImpact),
});
export type ShotImpactLog = t.TypeOf<typeof ShotImpactLog>;
export const ShotImpactLogComponent =
    new Component<ShotImpactLog>('ShotImpactLogComponent');
replicationPolicies.register(ShotImpactLogComponent, {
    codec: ShotImpactLog,
    authority: 'server',
});

export function getShotImpactDelta(
    previous: ShotImpactLog | undefined,
    current: ShotImpactLog,
): ShotImpactLog | undefined {
    const highest = Math.max(0,
        ...(previous?.impacts ?? []).map(impact => impact.impactSeq));
    const impacts = current.impacts.filter(
        impact => impact.impactSeq > highest);
    return impacts.length > 0 ? { impacts } : undefined;
}

export function applyShotImpactDelta(
    currentData: ShotImpactLog,
    delta: ShotImpactLog,
): ShotImpactLog {
    currentData.impacts ??= [];
    for (const impact of delta.impacts) {
        if (!currentData.impacts.some(
            existing => existing.impactSeq === impact.impactSeq)) {
            currentData.impacts.push(impact);
        }
    }
    while (currentData.impacts.length > FIRE_BUFFER_SIZE) {
        currentData.impacts.shift();
    }
    return currentData;
}

/** Inverse of `loggedShotEntityId`. */
export function parseLoggedShotEntityId(
    uuid: string,
): { source: string, seq: number } | undefined {
    if (!uuid.startsWith('shot:')) {
        return undefined;
    }
    const separator = uuid.lastIndexOf(':');
    const seq = Number(uuid.slice(separator + 1));
    if (separator <= 5 || !Number.isSafeInteger(seq)) {
        return undefined;
    }
    return { source: uuid.slice(5, separator), seq };
}

export interface FireSyncLocalState {
    nextSeq: number;
    highestIntentSeq: number;
    highestLogSeq: number;
    spawnedSeqs: Set<number>;
    /** Contiguous local prediction range; never suppress unseen logs below its start. */
    lowestPredictedSeq: number;
    highestPredictedSeq: number;
    nextLogSeq: number;
    /** Server: last ShotImpact sequence authored for this ship. */
    nextImpactSeq?: number;
    /** Client: last ShotImpact sequence applied for this ship. */
    highestImpactSeq?: number;
}

export const FireSyncLocalStateComponent =
    new Component<FireSyncLocalState>('FireSyncLocalStateComponent');

export function appendShot<T extends { seq: number }>(
    shots: readonly T[],
    shot: T,
    bound = FIRE_BUFFER_SIZE,
): T[] {
    if (bound <= 0) {
        return [];
    }
    const bySequence = new Map(shots.map(entry => [entry.seq, entry]));
    bySequence.set(shot.seq, shot);
    return [...bySequence.values()]
        .sort((left, right) => left.seq - right.seq)
        .slice(-bound);
}

/**
 * Append in place, so the replication layer sees one added and one removed
 * entry rather than a replaced component. Handing it a fresh array would put
 * the whole buffer on the wire for every shot, which at a realistic rate of
 * fire costs more than everything else in a fight put together.
 */
export function pushShot<T extends { seq: number }>(
    shots: T[],
    shot: T,
    bound = FIRE_BUFFER_SIZE,
): T[] {
    if (bound <= 0) {
        shots.length = 0;
        return shots;
    }
    const existing = shots.findIndex(entry => entry.seq === shot.seq);
    if (existing >= 0) {
        shots[existing] = shot;
    } else {
        shots.push(shot);
    }
    while (shots.length > bound) {
        shots.shift();
    }
    return shots;
}

export function newShotsAfter<T extends { seq: number }>(
    shots: readonly T[],
    highestSeq: number,
): T[] {
    const bySequence = new Map<number, T>();
    for (const shot of shots) {
        if (shot.seq > highestSeq) {
            bySequence.set(shot.seq, shot);
        }
    }
    return [...bySequence.values()]
        .sort((left, right) => left.seq - right.seq);
}

/** Legacy logs without logSeq retain their original ordering. */
export function fireLogSequence(shot: FireLogShot): number {
    return shot.logSeq ?? shot.seq;
}

export function newFireLogsAfter(shots: readonly FireLogShot[], highest: number): FireLogShot[] {
    return shots.filter(shot => fireLogSequence(shot) > highest)
        .sort((a, b) => fireLogSequence(a) - fireLogSequence(b));
}

export function rememberSpawnedShot(sync: FireSyncLocalState, seq: number,
    predicted = false): void {
    if (predicted && seq > sync.highestPredictedSeq) {
        // Observing another owner's shots can advance nextSeq across a gap.
        // Such gaps were not predicted here and must remain replayable.
        if (sync.highestPredictedSeq === 0 || seq !== sync.highestPredictedSeq + 1) {
            sync.lowestPredictedSeq = seq;
        }
        sync.highestPredictedSeq = seq;
    }
    sync.spawnedSeqs.add(seq);
    // Rejected/expired predictions might never appear in FireLog. Never wait for
    // acknowledgement to bound this set; the prediction watermark covers echoes.
    while (sync.spawnedSeqs.size > FIRE_BUFFER_SIZE) {
        sync.spawnedSeqs.delete(sync.spawnedSeqs.values().next().value!);
    }
}

function highestSequence(
    intent: FireIntent | undefined,
    log: FireLog | undefined,
): number {
    return Math.max(0,
        ...[...(intent?.shots ?? []), ...(log?.shots ?? [])]
            .map(shot => shot.seq)
            .filter(seq => Number.isSafeInteger(seq) && seq > 0));
}

export function getFireSyncLocalState(
    entity: Entity,
    intent?: FireIntent,
    log?: FireLog,
): FireSyncLocalState {
    const existing = entity.components.get(FireSyncLocalStateComponent);
    if (existing) {
        return existing;
    }
    // Sequence numbers must not rewind, but the log of *other* ships is the
    // only way observers ever see their shots: projectiles are not replicated.
    // Marking the buffer as already handled hid the first volley (and any
    // in-flight rounds when a ship entered interest). fireFromLog already
    // skips shots whose lifetime has elapsed, so replaying the live tail is
    // safe. The server intent watermark is advanced by the intent scheduler;
    // this local component must survive removal/readdition of the wire buffer.
    const seen = highestSequence(intent, log);
    const state: FireSyncLocalState = {
        nextSeq: seen + 1,
        highestIntentSeq: 0,
        highestLogSeq: 0,
        spawnedSeqs: new Set(),
        lowestPredictedSeq: Infinity,
        highestPredictedSeq: 0,
        nextLogSeq: Math.max(0, ...(log?.shots.map(fireLogSequence) ?? [])) + 1,
    };
    entity.components.set(FireSyncLocalStateComponent, state);
    return state;
}

export function loggedShotEntityId(source: string, seq: number): string {
    return `shot:${source}:${seq}`;
}

export interface FireLogReplayTiming {
    expired: boolean;
    createdAt: number;
    fastForwardMs: number;
}

/**
 * Map a logged muzzle time onto the local clock. `createdAt` stays the
 * authoritative fire stamp so lifespan ends together; `fastForwardMs` is how
 * far the shot has already flown when this world first sees it.
 */
export function fireLogReplayTiming(
    shotAt: number,
    now: number,
    durationMs: number,
): FireLogReplayTiming {
    if (!Number.isFinite(shotAt) || !Number.isFinite(now)
        || !Number.isFinite(durationMs) || durationMs <= 0) {
        return { expired: true, createdAt: shotAt, fastForwardMs: 0 };
    }
    const age = now - shotAt;
    if (age >= durationMs) {
        return { expired: true, createdAt: shotAt, fastForwardMs: durationMs };
    }
    return {
        expired: false,
        createdAt: shotAt,
        fastForwardMs: Math.max(0, age),
    };
}

export function makeFireLogShot(
    shot: FireIntentShot,
    at: number,
    position: Position,
    rotation: Angle,
    extras: {
        logSeq?: number,
        sourceVelocity?: Vector,
        target?: string,
        inaccuracy?: number,
    } = {},
): FireLogShot {
    const logged: FireLogShot = {
        seq: shot.seq,
        weaponId: shot.weaponId,
        seed: shot.seed,
        exitIndex: shot.exitIndex,
        at,
        position: Position.fromVectorLike(position),
        rotation: Angle.fromAngleLike(rotation),
    };
    if (shot.target !== undefined) {
        logged.target = shot.target;
    }
    if (extras.logSeq !== undefined) {
        logged.logSeq = extras.logSeq;
    }
    if (extras.sourceVelocity) {
        logged.sourceVelocity = new Vector(
            extras.sourceVelocity.x, extras.sourceVelocity.y);
    }
    if (extras.target) {
        logged.target = extras.target;
    }
    if (extras.inaccuracy !== undefined) {
        logged.inaccuracy = extras.inaccuracy;
    }
    return logged;
}

export const FireSyncPlugin: Plugin = {
    name: 'FireSyncPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        world.addComponent(FireIntentComponent);
        world.addComponent(FireLogComponent);
        world.addComponent(FireSyncLocalStateComponent);
        world.addComponent(ShotImpactLogComponent);
        deltaMaker.addComponent(ShotImpactLogComponent, {
            componentType: ShotImpactLog,
            deltaType: ShotImpactLog,
            getDelta: getShotImpactDelta,
            applyDelta: applyShotImpactDelta,
        });
        deltaMaker.addComponent(FireIntentComponent, {
            componentType: FireIntent,
            deltaType: FireIntentDelta,
            getDelta: getFireIntentDelta,
            applyDelta: applyFireIntentDelta,
        });
        deltaMaker.addComponent(FireLogComponent, {
            componentType: FireLog,
            deltaType: FireLogDelta,
            getDelta: getFireLogDelta,
            applyDelta: applyFireLogDelta,
        });
    },
};
