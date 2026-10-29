import { Component } from 'nova_ecs/component';
import { BOUNDARY } from 'nova_ecs/datatypes/position';
import { Entity } from 'nova_ecs/entity';
import { EntityMap } from 'nova_ecs/entity_map';
import { MovementState, sampleGuidanceTarget } from 'nova_ecs/plugins/movement_plugin';

/**
 * Upper bound on how far the server rewinds targets for a player's shot, and
 * on how old a client-reported muzzle pose may be. Matches the largest
 * presentation buffer plus one snapshot interval.
 */
export const MAX_LAG_COMPENSATION_MS = 250;

/**
 * Broadphase margin for rewound targets. A fast ship covers well under this
 * distance within MAX_LAG_COMPENSATION_MS.
 */
export const LAG_COMPENSATION_SEARCH_MARGIN = 600;

/**
 * Server-only marker on a player's projectile: resolve its hits against
 * targets as that player saw them, `viewDelayMs` in the past.
 */
export const LagCompensationComponent =
    new Component<{ viewDelayMs: number }>('LagCompensation');


export function clampLagMs(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.min(MAX_LAG_COMPENSATION_MS, value));
}

function wrapped(delta: number): number {
    const period = BOUNDARY * 2;
    if (delta > BOUNDARY) return delta - period;
    if (delta < -BOUNDARY) return delta + period;
    return delta;
}

export interface RewoundTargetPose {
    x: number;
    y: number;
    angle: number;
    velocity: { x: number; y: number };
    movement: MovementState;
}

/**
 * Offset and pose from where `target` is now to where it was at `atTime`, or
 * undefined when there is no usable history (the caller then tests against
 * the present position and orientation).
 */
export function rewindOffset(
    target: Entity,
    current: { x: number, y: number },
    atTime: number,
    entities: EntityMap,
): RewoundTargetPose | undefined {
    const sampled = sampleGuidanceTarget(target, atTime, entities);
    if (!sampled) {
        return undefined;
    }
    const x = wrapped(sampled.position.x - current.x);
    const y = wrapped(sampled.position.y - current.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)
        || Math.abs(x) > LAG_COMPENSATION_SEARCH_MARGIN
        || Math.abs(y) > LAG_COMPENSATION_SEARCH_MARGIN) {
        // A teleport or jump inside the rewind window; do not rewind across it.
        return undefined;
    }
    return {
        x,
        y,
        angle: sampled.rotation.angle,
        velocity: {
            x: Number.isFinite(sampled.velocity.x) ? sampled.velocity.x : 0,
            y: Number.isFinite(sampled.velocity.y) ? sampled.velocity.y : 0,
        },
        movement: sampled,
    };
}

export const rewindTargetPose = rewindOffset;
