import { isLeft } from 'fp-ts/lib/Either.js';
import { Component, UnknownComponent } from '../component.js';
import { Entity } from '../entity.js';
import { Resource } from '../resource.js';
import { World } from '../world.js';
import { SerializerResource } from './serializer_plugin.js';

/**
 * How a component's data is captured in a snapshot:
 * - codec: io-ts roundtrip through the serializer (correct for class
 *   data like Position; the default for serializer-registered
 *   components).
 * - share: store the reference itself. Only for immutable data (static
 *   game data, derived immutable structures).
 * - clone: custom deep copy, for mutable unregistered data.
 * - skip: not simulation state, or re-derived after restore.
 */
export type ComponentSnapshotPolicy<Data = unknown> =
    | { policy: 'codec' }
    | { policy: 'share' }
    | { policy: 'clone', clone: (data: Data) => Data }
    | { policy: 'skip' };

export interface ResourceSnapshotPolicy {
    name: string;
    save: () => unknown;
    restore: (saved: unknown) => void;
}

export class SnapshotPolicies {
    readonly components = new Map<UnknownComponent, ComponentSnapshotPolicy>();
    readonly resources: ResourceSnapshotPolicy[] = [];
    /** Component names that were skipped without an explicit policy. */
    readonly unhandled = new Set<string>();

    set<Data>(component: Component<Data>, policy: ComponentSnapshotPolicy<Data>) {
        this.components.set(component as UnknownComponent,
            policy as ComponentSnapshotPolicy);
    }

    addResource(policy: ResourceSnapshotPolicy) {
        this.resources.push(policy);
    }
}

export const SnapshotPoliciesResource =
    new Resource<SnapshotPolicies>('SnapshotPolicies');

type StoredComponent = [UnknownComponent, unknown, 'value' | 'encoded'];

interface SnapshotEntity {
    uuid: string;
    name?: string;
    components: StoredComponent[];
}

export interface WorldSnapshot {
    entities: SnapshotEntity[];
    singleton: StoredComponent[];
    resources: unknown[];
}

function snapshotComponents(world: World, entity: Entity,
    policies: SnapshotPolicies): StoredComponent[] {
    const serializer = world.resources.get(SerializerResource);
    const stored: StoredComponent[] = [];
    for (const [component, data] of entity.components) {
        let policy = policies.components.get(component);
        if (!policy) {
            policy = serializer?.hasComponent(component)
                ? { policy: 'codec' } : { policy: 'skip' };
        }
        switch (policy.policy) {
            case 'share':
                stored.push([component, data, 'value']);
                break;
            case 'clone':
                stored.push([component, policy.clone(data), 'value']);
                break;
            case 'codec':
                // io-ts optimizes all-identity codecs (e.g. VectorLike,
                // passthrough types) to return the live object, and even
                // non-identity codecs can share mutable inner objects.
                // Structurally clone so the snapshot cannot be mutated
                // by continued simulation; decode reconstructs class
                // instances from the plain data.
                stored.push([component, structuredClone(
                    serializer!.encodeComponent(component, data)), 'encoded']);
                break;
            case 'skip':
                if (!policies.components.has(component)) {
                    policies.unhandled.add(component.name);
                }
                break;
        }
    }
    return stored;
}

function restoreComponents(world: World, entity: Entity,
    stored: StoredComponent[], policies: SnapshotPolicies) {
    const serializer = world.resources.get(SerializerResource);
    for (const [component, data, kind] of stored) {
        if (kind === 'encoded') {
            const decoded = serializer!.decodeComponent(component.name, data);
            if (!decoded || isLeft(decoded)) {
                throw new Error(`Failed to restore component ${component.name}`);
            }
            entity.components.set(component, decoded.right[1]);
            continue;
        }
        const policy = policies.components.get(component);
        if (policy?.policy === 'clone') {
            // Clone again on restore so the snapshot's copy stays
            // pristine for later restores.
            entity.components.set(component, policy.clone(data));
        } else {
            entity.components.set(component, data);
        }
    }
}

/**
 * Captures the simulation state of a world: every entity's components
 * (per the registered policies), the singleton's components, and the
 * registered resources. Entities are recorded in insertion order,
 * which iteration order (and therefore determinism) depends on.
 */
export function snapshotWorld(world: World): WorldSnapshot {
    const policies = world.resources.get(SnapshotPoliciesResource);
    if (!policies) {
        throw new Error('Expected SnapshotPoliciesResource to exist');
    }

    const entities: SnapshotEntity[] = [];
    let singleton: StoredComponent[] = [];
    for (const [uuid, entity] of world.entities) {
        if (uuid === 'singleton') {
            singleton = snapshotComponents(world, entity, policies);
            continue;
        }
        entities.push({
            uuid,
            name: entity.name,
            components: snapshotComponents(world, entity, policies),
        });
    }

    return {
        entities,
        singleton,
        resources: policies.resources.map(resource => resource.save()),
    };
}

/**
 * Restores a world to a snapshot's state. `complete` runs on each
 * restored entity before it is inserted, so derived components can be
 * reattached synchronously (no first-step gap during resimulation).
 */
export function restoreWorld(world: World, snapshot: WorldSnapshot,
    complete?: (world: World, entity: Entity) => void) {
    const policies = world.resources.get(SnapshotPoliciesResource);
    if (!policies) {
        throw new Error('Expected SnapshotPoliciesResource to exist');
    }

    for (const uuid of [...world.entities.keys()]) {
        if (uuid !== 'singleton') {
            world.entities.delete(uuid);
        }
    }

    for (const snap of snapshot.entities) {
        const entity = new Entity(snap.name);
        restoreComponents(world, entity, snap.components, policies);
        complete?.(world, entity);
        world.entities.set(snap.uuid, entity);
    }

    const singleton = world.entities.get('singleton');
    if (singleton) {
        restoreComponents(world, singleton, snapshot.singleton, policies);
    }

    policies.resources.forEach((resource, i) => {
        resource.restore(snapshot.resources[i]);
    });

    // Entity removal/re-insertion above queued Add/Delete events that
    // did not happen in the restored timeline. Snapshots are taken
    // between steps (empty queue), so restore that invariant.
    world.clearEventQueue();
}
