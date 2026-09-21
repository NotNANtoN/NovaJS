import { Component } from './component';
import { Entity } from './entity';

export type ComponentTuple = readonly Component<any>[];

/**
 * Validates that an entity contains all components required for its archetype role.
 * Throws an explicit error if any component is missing, preventing downstream ECS
 * systems from failing silently or skipping entities unexpectedly.
 */
export function assertArchetype<T extends ComponentTuple>(
    entity: Entity,
    required: T,
    archetypeName: string,
): void {
    const missing: string[] = [];
    for (const comp of required) {
        if (!entity.components.has(comp)) {
            missing.push(comp.name);
        }
    }
    if (missing.length > 0) {
        throw new Error(
            `[ARCHETYPE VIOLATION] ${archetypeName} '${entity.name || 'unnamed'}' is missing required components: [${missing.join(', ')}]`,
        );
    }
}
