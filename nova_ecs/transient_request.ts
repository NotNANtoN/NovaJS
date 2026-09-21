import { Component } from './component';
import { Entity } from './entity';

/**
 * Consumes a one-shot request or intent component from an entity.
 * Immediately deletes the component from the entity so it cannot be
 * re-executed on subsequent frames or leak across room transitions.
 */
export function consumeRequest<T>(entity: Entity, component: Component<T>): T | undefined {
    const request = entity.components.get(component);
    if (request !== undefined) {
        entity.components.delete(component);
    }
    return request;
}
