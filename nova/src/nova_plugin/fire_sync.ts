import * as t from 'io-ts';
import { Component } from 'nova_ecs/component';
import { Angle, AngleType } from 'nova_ecs/datatypes/angle';
import { Position, PositionType } from 'nova_ecs/datatypes/position';
import { Entity } from 'nova_ecs/entity';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { replicationPolicies } from 'nova_ecs/plugins/multiplayer_plugin';

export const FIRE_BUFFER_SIZE = 16;

export const FireIntentShot = t.type({
    seq: t.number,
    weaponId: t.string,
    seed: t.number,
    exitIndex: t.number,
});
export type FireIntentShot = t.TypeOf<typeof FireIntentShot>;

export const FireIntent = t.type({
    shots: t.array(FireIntentShot),
});
export type FireIntent = t.TypeOf<typeof FireIntent>;
export const FireIntentComponent =
    new Component<FireIntent>('FireIntentComponent');

export const FireLogShot = t.type({
    seq: t.number,
    weaponId: t.string,
    seed: t.number,
    exitIndex: t.number,
    at: t.number,
    position: PositionType,
    rotation: AngleType,
});
export type FireLogShot = t.TypeOf<typeof FireLogShot>;

export const FireLog = t.type({
    shots: t.array(FireLogShot),
});
export type FireLog = t.TypeOf<typeof FireLog>;
export const FireLogComponent = new Component<FireLog>('FireLogComponent');

replicationPolicies.register(FireIntentComponent, {
    codec: FireIntent,
    authority: 'owning-client',
});
replicationPolicies.register(FireLogComponent, {
    codec: FireLog,
    authority: 'server',
});

export interface FireSyncLocalState {
    nextSeq: number;
    highestIntentSeq: number;
    highestLogSeq: number;
    spawnedSeqs: Set<number>;
    acceptedAt: Map<string, number[]>;
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

function highestSequence(
    intent: FireIntent | undefined,
    log: FireLog | undefined,
): number {
    return Math.max(0,
        ...(intent?.shots.map(shot => shot.seq) ?? []),
        ...(log?.shots.map(shot => shot.seq) ?? []));
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
    // Whatever is already buffered happened before this world was watching, so
    // it counts as handled. Starting from zero instead replays the entire
    // buffer: a pilot arriving from a hyperjump, which rebuilds the world, was
    // met by a volley of their own shots from the system they had left, and a
    // ship entering interest range brought its recent history with it.
    const seen = highestSequence(intent, log);
    const state: FireSyncLocalState = {
        nextSeq: seen + 1,
        highestIntentSeq: seen,
        highestLogSeq: seen,
        spawnedSeqs: new Set(),
        acceptedAt: new Map(),
    };
    entity.components.set(FireSyncLocalStateComponent, state);
    return state;
}

export function makeFireLogShot(
    shot: FireIntentShot,
    at: number,
    position: Position,
    rotation: Angle,
): FireLogShot {
    return {
        ...shot,
        at,
        position: Position.fromVectorLike(position),
        rotation: Angle.fromAngleLike(rotation),
    };
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
        deltaMaker.addComponent(FireIntentComponent, {
            componentType: FireIntent,
        });
        deltaMaker.addComponent(FireLogComponent, {
            componentType: FireLog,
        });
    },
};
