import { Component } from 'nova_ecs/component';
import { Entity } from 'nova_ecs/entity';

/**
 * What a synchronized beam is currently hitting.
 *
 * Server: `current` is filled by this tick's beam collisions and compared
 * with `reported` next tick; a change becomes a `beam` ShotImpact.
 * Client: set from those impacts (or from local prediction for the player's
 * own beam) and drives beam clipping and hit effects.
 */
export interface BeamContact {
    target?: string;
    position?: { x: number, y: number };
    /** Server only. */
    current?: string;
    currentPosition?: { x: number, y: number };
    reported?: string;
    /** Client only: time the last hit effect was shown. */
    lastFeedbackAt?: number;
    /** Client only: tick time of a locally predicted (own beam) contact. */
    predictedAt?: number;
}

export const BeamContactComponent = new Component<BeamContact>('BeamContact');

export function setBeamContact(beam: Entity, target: string | undefined,
    position: { x: number, y: number } | undefined): void {
    const contact = beam.components.get(BeamContactComponent) ?? {};
    contact.target = target;
    contact.position = position ? { x: position.x, y: position.y } : undefined;
    // A server-reported contact persists until the server reports a change.
    contact.predictedAt = undefined;
    beam.components.set(BeamContactComponent, contact);
}
