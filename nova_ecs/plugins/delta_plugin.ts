import { applyPatches, createDraft, current, enablePatches, finishDraft, isDraft, isDraftable, original, setAutoFreeze } from 'immer';
import { Objectish, Patch } from 'immer/dist/internal';
import * as t from 'io-ts';
import { set } from '../datatypes/set';
import { Component, UnknownComponent } from '../component';
import { map } from '../datatypes/map';
import { Entity } from '../entity';
import { Plugin } from '../plugin';
import { Resource } from '../resource';
import { isLeft } from 'nova_ecs/either';
import { Serializer, SerializerPlugin, SerializerResource } from './serializer_plugin';
import { setDifference } from '../utils';
import { EventMap } from '../event_map';


export interface OptionalComponentDelta<Data, Delta> {
    componentType: t.Type<Data, unknown, unknown>;
    deltaType?: t.Type<Delta, unknown, unknown>;
    getDelta?: (a: Data, b: Data, patches: Patch[]) => Delta | undefined;
    applyDelta?: (componentData: Data, delta: Delta) => Data | void;
}

export type ComponentDelta<Data, Delta> = {
    [K in keyof OptionalComponentDelta<Data, Delta>]-?:
    OptionalComponentDelta<Data, Delta>[K];
}

interface ComponentDeltaMap<K extends Component<any>>
    extends Map<K, ComponentDelta<unknown, unknown>> {
    get<Data>(key: Component<Data>): ComponentDelta<Data, unknown> | undefined;
    set<Data>(key: Component<Data>, val: ComponentDelta<Data, any>): this;
}

export const EntityDelta = t.partial({
    componentStates: map(t.string /* Component Name */, t.unknown /* State */),
    componentDeltas: map(t.string /* Component Name */, t.unknown /* Delta */),
    removeComponents: set(t.string /* Component Name */),
});

export type EntityDelta = t.TypeOf<typeof EntityDelta>;

enablePatches();
setAutoFreeze(false);

const DeltaComponent = new Component<{
    components: Map<UnknownComponent, unknown>,
}>('DeltaComponent');

export class DeltaMaker {
    readonly componentDeltas: ComponentDeltaMap<UnknownComponent> = new Map();
    private readonly trackedEntities = new Map<Entity, {
        dirty: boolean,
        subscriptions: Array<{ unsubscribe: () => void }>,
    }>();
    private readonly internalUpdates = new Set<Entity>();

    constructor(private serializer: Serializer) { }

    addComponent<Data, Delta>(component: Component<Data>,
        componentDelta: OptionalComponentDelta<Data, Delta>) {
        this.serializer.addComponent(component, componentDelta.componentType);
        this.componentDeltas.set(component, {
            componentType: componentDelta.componentType,
            deltaType: componentDelta.deltaType ?? immerDeltaType,
            getDelta: componentDelta.getDelta ?? immerGetDelta,
            applyDelta: componentDelta.applyDelta ?? immerApplyDelta,
        });
        for (const tracking of this.trackedEntities.values()) {
            tracking.dirty = true;
        }
    }

    /**
     * Starts tracking an entity's component changes. Draft mutations do not
     * reach EventMap, so isDirty also checks Immer's current draft snapshot.
     * This is still cheaper than finalizing every component every step.
     */
    track(entity: Entity) {
        if (this.trackedEntities.has(entity)) {
            return;
        }

        const tracking = {
            dirty: true,
            subscriptions: [] as Array<{ unsubscribe: () => void }>,
        };
        const markDirty = (component?: UnknownComponent) => {
            if (component !== DeltaComponent && !this.internalUpdates.has(entity)) {
                tracking.dirty = true;
            }
        };

        tracking.subscriptions.push(
            entity.components.events.setAlways.subscribe(([component]) =>
                markDirty(component)),
            entity.components.events.delete.subscribe((components) => {
                if ([...components].some(([component]) => component !== DeltaComponent)) {
                    markDirty();
                }
            }),
        );
        this.trackedEntities.set(entity, tracking);
    }

    isDirty(entity: Entity) {
        this.track(entity);
        const tracking = this.trackedEntities.get(entity)!;
        if (tracking.dirty) {
            return true;
        }

        // Immer draft property mutations do not emit component-map events.
        // current() returns the original object for an unmodified draft.
        for (const [component, data] of entity.components) {
            if (this.componentDeltas.has(component) && isDraft(data)
                && current(data) !== original(data)) {
                tracking.dirty = true;
                return true;
            }
        }
        return false;
    }

    /**
     * Checks one registered component without consuming the entity's delta.
     * This lets systems that have side effects for a specific component share
     * the dirty tracking used by replication without stealing that component's
     * outbound delta.
     */
    isComponentDirty(entity: Entity, component: UnknownComponent): boolean {
        if (!this.componentDeltas.has(component)) {
            return false;
        }
        this.track(entity);
        const data = entity.components.get(component);
        const deltaComponent = entity.components.get(DeltaComponent);
        if (!deltaComponent
            || !deltaComponent.components.has(component)
            || !Object.is(deltaComponent.components.get(component), data)) {
            return true;
        }
        return isDraft(data)
            && current(data) !== original(data);
    }

    /**
     * Installs the representation used as the next tracking baseline.
     *
     * Immer can only draft objects and arrays. Primitive component values are
     * immutable, so their value itself is the baseline and replacement is
     * detected through EventMap.set plus Object.is. The finally block matters:
     * if createDraft throws for a custom immerable object, the entity still
     * receives the usable plain value instead of retaining a revoked draft.
     */
    private installTrackingValue(
        entity: Entity,
        component: UnknownComponent,
        value: unknown,
    ): unknown {
        let trackedValue = value;
        try {
            if (isDraftable(value)) {
                trackedValue = createDraft(value as Objectish);
            }
        } finally {
            (entity.components as EventMap<UnknownComponent, unknown>)
                .set(component, trackedValue, true /* Silent */);
        }
        return trackedValue;
    }

    /**
     * Finishes a draft and immediately replaces its revoked proxy with a valid
     * tracking value. Callers may subsequently run codecs or custom delta
     * functions which throw without corrupting the entity.
     */
    private finishAndInstall(
        entity: Entity,
        component: UnknownComponent,
        data: Objectish,
        patchListener?: (patches: Patch[]) => void,
    ): unknown {
        let currentData: unknown;
        let finished = false;
        try {
            currentData = finishDraft(data, patchListener);
            finished = true;
            return currentData;
        } finally {
            if (finished) {
                this.installTrackingValue(entity, component, currentData);
            }
        }
    }

    clearDirty(entity: Entity) {
        const tracking = this.trackedEntities.get(entity);
        if (tracking) {
            tracking.dirty = false;
        }
    }

    /**
     * Removes the immer draftedness of an entity's components.
     */
    untrack(entity: Entity) {
        const tracking = this.trackedEntities.get(entity);
        if (!tracking && !entity.components.has(DeltaComponent)) {
            return;
        }
        for (const subscription of tracking?.subscriptions ?? []) {
            subscription.unsubscribe();
        }
        this.trackedEntities.delete(entity);

        for (const [component, data] of entity.components) {
            if (isDraft(data)) {
                // Finishing a draft replaces the value's representation, not
                // its meaning. A non-silent set here reports every registered
                // component as changed, which re-runs every Provide that
                // watches one of them. On the inbound replication path that
                // happens for each remote update and rebuilds derived state
                // (weapon counts, reload accumulators, physics) continuously,
                // discarding live local input.
                (entity.components as EventMap<UnknownComponent, unknown>)
                    .set(component, finishDraft(data), true /* Silent */);
            }
        }
        entity.components.delete(DeltaComponent);
    }

    untrackExcept(entities: ReadonlySet<Entity>) {
        for (const entity of this.trackedEntities.keys()) {
            if (!entities.has(entity)) {
                this.untrack(entity);
            }
        }
    }

    /**
     * Gets the changes that have been made to an entity since the last
     * call to `getDelta`. Uses Immer to track changes on components.
     */
    getDelta(entity: Entity): EntityDelta | undefined {
        this.track(entity);
        if (!this.isDirty(entity)) {
            return;
        }

        this.internalUpdates.add(entity);
        try {
        const componentStates = new Map<string, unknown>();
        const componentDeltas = new Map<string, unknown>();

        if (!entity.components.has(DeltaComponent)) {
            entity.components.set(DeltaComponent, { components: new Map() });
        }
        const deltaComponent = entity.components.get(DeltaComponent)!;

        for (const [component, data] of entity.components) {
            // Ignore unsupported components
            const componentDeltaFuncs = this.componentDeltas.get(component);
            if (!componentDeltaFuncs) {
                continue;
            }

            const hasBaseline = deltaComponent.components.has(component);
            const matchesBaseline = hasBaseline
                && Object.is(deltaComponent.components.get(component), data);
            if (matchesBaseline) {
                // Use deltas for components we've already seen.
                const { getDelta, deltaType } = componentDeltaFuncs;

                if (isDraft(data)) {
                    const originalData = original(data);

                    let patches: Patch[] | undefined;
                    const currentData = this.finishAndInstall(
                        entity,
                        component,
                        data as Objectish,
                        forwardPatches => {
                            patches = forwardPatches;
                        },
                    );
                    if (!patches) {
                        throw new Error('Got no patches when calling delta');
                    }

                    const delta = getDelta(originalData, currentData, patches);
                    if (delta !== undefined) {
                        componentDeltas.set(component.name,
                            deltaType.encode(delta));
                    }
                } else if (isDraftable(data)) {
                    // A draftable value can be plain after an inbound state
                    // replacement. Re-establish its object tracking baseline.
                    this.installTrackingValue(entity, component, data);
                }
            } else {
                // Use the full state for components we haven't seen before or which
                // have been replaced.
                const componentType = this.serializer.componentTypes.get(component);
                if (!componentType) {
                    throw new Error(`Expected to have component type for ${component.name}`);
                }
                const currentData = isDraft(data) ? current(data) : data;
                componentStates.set(
                    component.name,
                    componentType.encode(currentData),
                );
                if (isDraft(data)) {
                    this.finishAndInstall(
                        entity,
                        component,
                        data as Objectish,
                    );
                } else {
                    this.installTrackingValue(entity, component, data);
                }
            }
        }

        const entityComponents = new Set([...entity.components.keys()]
            .filter(component => this.componentDeltas.has(component)));

        // Only replicated components belong in the baseline. A server-only
        // marker such as NpcTrafficComponent would otherwise appear in
        // removeComponents, and clients warn "Missing component".
        const deltaComponentSet = new Set([...deltaComponent.components.keys()])
        const removedComponents = new Set(
            [...setDifference(deltaComponentSet, entityComponents)]
                .map(component => component.name));
        deltaComponent.components = new Map([...entity.components]
            .filter(([component]) => this.componentDeltas.has(component)));

        const entityDelta: EntityDelta = {};
        if (componentStates.size > 0) {
            entityDelta.componentStates = componentStates;
        }
        if (componentDeltas.size > 0) {
            entityDelta.componentDeltas = componentDeltas;
        }
        if (removedComponents.size > 0) {
            entityDelta.removeComponents = removedComponents;
        }

        if (Object.keys(entityDelta).length > 0) {
            // TODO: Encode this here???
            this.clearDirty(entity);
            return entityDelta;
        }
        this.clearDirty(entity);
        return;
        } finally {
            this.internalUpdates.delete(entity);
        }
    }

    /**
     * Apply a delta to an entity. Returns the set of components that
     * the delta had but the entity was missing.
     */
    applyDelta(entity: Entity, delta: EntityDelta): Set<UnknownComponent> {
        const missingComponents: Set<UnknownComponent> = new Set();

        // Create new components from states
        for (const [componentName, componentState] of delta.componentStates ?? []) {
            const component = this.serializer.componentsByName.get(componentName);
            if (!component) {
                console.warn(`Missing component ${componentName}`);
                continue;
            }
            const componentType = this.serializer.componentTypes.get(component);
            if (!componentType) {
                console.warn(`Missing component type for ${componentName}`);
                continue;
            }
            const decoded = componentType.decode(componentState);
            if (isLeft(decoded)) {
                console.warn(`Failed to decode component ${componentName}`, decoded.left);
                continue;
            }
            // Use set instead of setSilent because this is a new component.
            entity.components.set(component, decoded.right);
        }

        // Apply component deltas
        for (const [componentName, encodedDelta] of delta.componentDeltas ?? []) {
            const component = this.serializer.componentsByName.get(componentName);
            if (!component) {
                console.warn(`Missing component ${componentName}`);
                continue;
            }
            const componentDeltaFuncs = this.componentDeltas.get(component);
            if (!componentDeltaFuncs) {
                console.warn(`Missing component delta type for ${componentName}`);
                continue;
            }

            const { deltaType, applyDelta } = componentDeltaFuncs;

            if (!entity.components.has(component)) {
                // Cannot apply delta if the entity is missing the component.
                // Signal that the full state should be requested.
                missingComponents.add(component);
                continue;
            }
            const currentData = entity.components.get(component);

            const componentDelta = deltaType.decode(encodedDelta);
            if (isLeft(componentDelta)) {
                console.warn(`Failed to decode delta for component ${componentName}`);
                continue;
            }
            const newData = applyDelta(currentData, componentDelta.right);
            if (newData !== undefined) {
                // Use setSilent because this is an existing component.
                (entity.components as EventMap<UnknownComponent, unknown>)
                    .set(component, newData, true /* Silent */);
            }
        }

        // Remove components
        for (const componentName of delta.removeComponents ?? []) {
            const component = this.serializer.componentsByName.get(componentName);
            if (!component) {
                console.warn(`Missing component ${componentName}`);
                continue;
            }
            entity.components.delete(component);
        }

        return missingComponents;
    }

    /**
     * Applies replicated state without treating it as a new local edit.
     *
     * Tracked entities can have unsent local input when a remote update
     * arrives. Capture that input, establish the remote result as the new
     * tracking baseline, then reapply the local delta so it remains outbound.
     * This prevents client/server echo storms without dropping input.
     */
    applyRemoteUpdate(entity: Entity, update: () => void): void {
        const wasTracked = this.trackedEntities.has(entity);
        const pending = wasTracked && this.isDirty(entity)
            ? this.getDelta(entity)
            : undefined;

        if (wasTracked) {
            this.untrack(entity);
        }
        update();
        if (!wasTracked) {
            return;
        }

        this.track(entity);
        // A newly tracked entity initially reports its complete state. Consume
        // that snapshot so the remote update becomes the baseline.
        this.getDelta(entity);
        this.clearDirty(entity);
        if (pending) {
            this.applyDelta(entity, pending);
            // applyDelta writes silently, and a component-state replay can
            // produce a plain value rather than an Immer draft. Mark the
            // entity explicitly so the preserved local edit is still sent.
            this.trackedEntities.get(entity)!.dirty = true;
        }
    }

    applyRemoteDelta(
        entity: Entity,
        delta: EntityDelta,
        mergeComponent?: (
            component: UnknownComponent,
            local: unknown,
            remote: unknown,
        ) => unknown,
    ): void {
        const localComponents = new Map<UnknownComponent, unknown>();
        if (mergeComponent) {
            const updatedNames = new Set([
                ...delta.componentStates?.keys() ?? [],
                ...delta.componentDeltas?.keys() ?? [],
            ]);
            for (const componentName of updatedNames) {
                const component = this.serializer.componentsByName
                    .get(componentName);
                if (!component || !entity.components.has(component)) {
                    continue;
                }
                const data = entity.components.get(component);
                localComponents.set(
                    component,
                    isDraft(data) ? current(data) : data,
                );
            }
        }

        this.applyRemoteUpdate(entity, () => {
            this.applyDelta(entity, delta);
            for (const [component, local] of localComponents) {
                if (!entity.components.has(component)) {
                    continue;
                }
                const remote = entity.components.get(component);
                const merged = mergeComponent!(component, local, remote);
                (entity.components as EventMap<UnknownComponent, unknown>)
                    .set(component, merged, true /* Silent */);
            }
        });
    }
}

export const DeltaResource =
    new Resource<DeltaMaker>('DeltaResource');

export const DeltaPlugin: Plugin = {
    name: 'Delta',
    build(world) {
        world.addPlugin(SerializerPlugin);
        const serializer = world.resources.get(SerializerResource);
        if (!serializer) {
            throw new Error('Expected serializer resource to be present');
        }
        if (!world.resources.has(DeltaResource)) {
            world.resources.set(DeltaResource, new DeltaMaker(serializer));
        }
    }
}

const Patch = t.intersection([t.type({
    op: t.union([t.literal('replace'), t.literal('remove'), t.literal('add')]),
    path: t.array(t.union([t.string, t.number]))
}), t.partial({
    value: t.unknown,
})]);

export const immerDeltaType = t.array(Patch);

export function immerGetDelta<T>(_a: T, _b: T, patches: Patch[]) {
    if (patches.length > 0) {
        return patches;
    }
    return;
}

export function immerApplyDelta<T>(componentData: T, delta: Patch[]) {
    // TODO: Fix this type
    return applyPatches(componentData as Objectish, delta) as T;
}
