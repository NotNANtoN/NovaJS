import { isLeft } from 'fp-ts/Either';
import produce, { current, isDraft } from 'immer';
import * as t from 'io-ts';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { Emit, Entities, GetEntity, UUID } from '../arg_types';
import { Component } from '../component';
import { map } from '../datatypes/map';
import { BOUNDARY } from '../datatypes/position';
import { set } from '../datatypes/set';
import { Entity } from '../entity';
import { EcsEvent } from '../events';
import { Plugin } from '../plugin';
import { Query } from '../query';
import { Resource } from '../resource';
import { Phase, System } from '../system';
import { DefaultMap, setDifference } from '../utils';
import { World } from '../world';
import { DeltaPlugin, DeltaResource, EntityDelta } from './delta_plugin';
import {
    EncodedEntity,
    Serializer,
    SerializerResource,
} from './serializer_plugin';
import {
    applyMovementStateDelta,
    copyMovementState,
    MovementState,
    MovementStateComponent,
    MovementStateDelta,
    quantizedMovementDelta,
    quantizeMovementState,
    GuidanceTargetTrackComponent,
    queueGuidanceTargetSnapshot,
    queueRemoteMovementSnapshot,
    RemoteMovementPresentationComponent,
} from './movement_plugin';
import { TimeResource, wallClockNow } from './time_plugin';

export class Peers {
    readonly current: BehaviorSubject<Set<string>>;
    readonly join: Subject<string>;
    readonly leave: Subject<string>;

    constructor(p: BehaviorSubject<Set<string>> | {
        join: Subject<string>;
        leave: Subject<string>;
        initial?: Set<string>;
    }) {
        if (p instanceof BehaviorSubject) {
            this.current = p;
            const join = new Subject<string>();
            this.join = join;
            const leave = new Subject<string>();
            this.leave = leave;
            let lastPeers = new Set([...p.value]);
            p.subscribe(peers => {
                const joined = setDifference(peers, lastPeers);
                const left = setDifference(lastPeers, peers);
                for (const peer of joined) {
                    join.next(peer);
                }
                for (const peer of left) {
                    leave.next(peer);
                }
                lastPeers = new Set([...peers]);
            });
        } else {
            const { join, leave, initial } = p;
            this.current = new BehaviorSubject(initial ?? new Set());
            join.subscribe(peer => {
                this.current.next(produce(this.current.value, peers => {
                    peers.add(peer)
                }));
            });
            leave.subscribe(peer => {
                this.current.next(produce(this.current.value, peers => {
                    peers.delete(peer)
                }));
            });
            this.join = join;
            this.leave = leave;
        }
    }
}

export interface Communicator {
    uuid: string | undefined;
    peers: Peers,
    servers: BehaviorSubject<Set<string>>,
    messages: Observable<{ source: string, message: unknown }>,
    connected: BehaviorSubject<boolean>,
    sendMessage(message: unknown, destination?: string | Set<string>): void;
}

export const ChatMessageEntry = t.type({
    id: t.string,
    from: t.string,
    fromName: t.string,
    to: t.string,
    text: t.string,
    time: t.number,
});
export type ChatMessageEntry = t.TypeOf<typeof ChatMessageEntry>;

export const ChatMessageEvent = new EcsEvent<ChatMessageEntry>('ChatMessageEvent');

export const Message = t.partial({
    delta: map(t.string /* Entity UUID */, EntityDelta),
    state: map(t.string /* Entity UUID */, EncodedEntity),
    sentAt: t.number,
    movementTimestamps: map(t.string /* Entity UUID */, t.number),
    movementSequences: map(t.string /* Entity UUID */, t.number),
    requestState: t.type({
        uuids: set(t.string),
        invert: t.boolean,
    }),
    remove: t.array(t.string),
    ownedUuids: t.array(t.string),
    admins: set(t.string),
    peers: set(t.string),
    chat: t.array(ChatMessageEntry),
});
export type Message = t.TypeOf<typeof Message>;

export const MultiplayerData = new Component<{ owner: string }>('MultiplayerData');
export const MULTIPLAYER_INTEREST_RADIUS = 6_000;

function wrappedAxisDistance(a: number, b: number): number {
    const direct = Math.abs(a - b);
    return Math.min(direct, BOUNDARY * 2 - direct);
}

function positionsWithinInterest(
    a: MovementState,
    b: MovementState,
): boolean {
    const x = wrappedAxisDistance(a.position.x, b.position.x);
    const y = wrappedAxisDistance(a.position.y, b.position.y);
    return x * x + y * y
        <= MULTIPLAYER_INTEREST_RADIUS * MULTIPLAYER_INTEREST_RADIUS;
}

export interface MessageWithSource<M> {
    message: M,
    source: string,
}

export const Comms = new Component<{
    ownedUuids: Set<string>,
    admins: Set<string>,
    uuid: string | undefined,
    stateRequests: Map<string /* peer uuid */, Set<string /* Entity uuid */>>,
    lastEntities: Map<string, string>, // entity, owner
    messages: MessageWithSource<Message>[],
    initialStateRequested: boolean,
    outboundChat?: ChatMessageEntry[],
}>('Comms');


export const NewOwnedEntityEvent = new EcsEvent<string>('NewOwnedEntityEvent');

export const MultiplayerMessageEvent =
    new EcsEvent<MessageWithSource<unknown>>('MultiplayerMessageEvent');
const MessageSystem = new System({
    name: 'MessageSystem',
    events: [MultiplayerMessageEvent],
    args: [MultiplayerMessageEvent, Comms] as const,
    step: ({ message, source }, comms) => {
        const maybeMessage = Message.decode(message);
        if (isLeft(maybeMessage)) {
            console.warn('Failed to decode message');
            return;
        }
        comms.messages.push({ message: maybeMessage.right, source });
    }
});

export const CommunicatorResource = new Resource<Communicator>('CommunicatorResource');

export const MultiplayerPhase = new Phase({name: 'MultiplayerPhase'});

/**
 * Gameplay authority contract
 *
 * - An owning client authors its ship's MovementState. The server consumes
 *   that state for gameplay and relays the exact movement delta to observers;
 *   it never sends its separately integrated copy back as a correction.
 * - The server authors NPC movement, projectiles, damage, spawns/despawns,
 *   mission state, and other gameplay outcomes.
 * - Non-owning clients buffer authoritative movement snapshots and present
 *   them through RemoteMovementPresentationSystem; MovementSystem does not
 *   simulate those entities.
 * - Client weapon intent (`WeaponsState.firing`) still travels to the server;
 *   applying server weapon state must preserve pending local input.
 *
 * `entity-owner` remains the legacy transport default because several mixed
 * state components carry client intent as well as server results. Gameplay
 * systems, not that transport default, remain authoritative for those results.
 */
export type ComponentAuthority =
    | 'entity-owner'
    | 'server'
    | 'owning-client'
    | 'local-only';

export interface ReplicationMergeContext {
    readonly source: string;
    readonly peerIsAdmin: boolean;
    readonly localUuid: string;
    readonly localIsAdmin: boolean;
    readonly owner: string;
}

export interface ReplicationPolicy<T = unknown> {
    readonly codec: t.Type<T, unknown, unknown>;
    readonly authority: ComponentAuthority;
    readonly merge?: (
        local: T,
        remote: T,
        context: ReplicationMergeContext,
    ) => T;
    readonly acceptInitialOwnerState?: boolean;
    readonly allowOwnerRemoval?: boolean;
    readonly relayOwnerChanges?: boolean;
}

export class ReplicationPolicyRegistry {
    private readonly policies = new Map<string, ReplicationPolicy<any>>();

    register<T>(
        component: Component<T>,
        policy: ReplicationPolicy<T>,
    ): this {
        return this.registerName(component.name, policy);
    }

    registerName<T>(
        componentName: string,
        policy: ReplicationPolicy<T>,
    ): this {
        this.policies.set(componentName, policy);
        return this;
    }

    get(componentName: string): ReplicationPolicy | undefined {
        return this.policies.get(componentName);
    }
}

export const replicationPolicies = new ReplicationPolicyRegistry();
replicationPolicies.register(MovementStateComponent, {
    codec: MovementState,
    authority: 'owning-client',
});
replicationPolicies.register(RemoteMovementPresentationComponent, {
    codec: t.any,
    authority: 'local-only',
});

const WEAPONS_STATE_COMPONENT_NAME = 'WeaponsStateComponent';
type WeaponStateLike = {
    firing: boolean;
    [key: string]: unknown;
};

function mergeWeaponStateIntent(
    local: unknown,
    remote: unknown,
    context: ReplicationMergeContext,
): unknown {
    if (!(local instanceof Map) || !(remote instanceof Map)) {
        return remote;
    }

    if (context.peerIsAdmin && context.owner === context.localUuid) {
        // The local owner keeps its live trigger edge while accepting all
        // server-authored weapon inventory/result fields.
        const merged = new Map(remote);
        for (const [weaponId, localState] of local) {
            const remoteState = merged.get(weaponId) as
                WeaponStateLike | undefined;
            if (remoteState && typeof remoteState === 'object'
                && typeof (localState as WeaponStateLike).firing === 'boolean') {
                merged.set(weaponId, {
                    ...remoteState,
                    firing: (localState as WeaponStateLike).firing,
                });
            }
        }
        return merged;
    }

    if (context.localIsAdmin && !context.peerIsAdmin
        && context.source === context.owner) {
        // A client may only update firing on weapons the server already knows.
        // Counts, targets, additions, and other result fields remain server
        // authored even if a malicious/old client sends a complete component.
        const merged = new Map(local);
        for (const [weaponId, remoteState] of remote) {
            const localState = merged.get(weaponId) as
                WeaponStateLike | undefined;
            if (localState && typeof localState === 'object'
                && typeof (remoteState as WeaponStateLike).firing === 'boolean') {
                merged.set(weaponId, {
                    ...localState,
                    firing: (remoteState as WeaponStateLike).firing,
                });
            }
        }
        return merged;
    }

    return remote;
}

function weaponStateMap(entity: Entity): Map<string, WeaponStateLike> | undefined {
    for (const [component, data] of entity.components) {
        if (component.name === WEAPONS_STATE_COMPONENT_NAME
            && data instanceof Map) {
            return data as Map<string, WeaponStateLike>;
        }
    }
    return undefined;
}

function weaponStateComponent(entity: Entity): Component<unknown> | undefined {
    return [...entity.components.keys()].find(
        component => component.name === WEAPONS_STATE_COMPONENT_NAME);
}

function captureWeaponFiring(entity: Entity): Map<string, boolean> | undefined {
    const states = weaponStateMap(entity);
    if (!states) {
        return undefined;
    }
    return new Map([...states].map(([id, state]) => [id, state.firing]));
}

function restoreWeaponFiring(
    entity: Entity,
    firing: Map<string, boolean> | undefined,
): void {
    if (!firing) {
        return;
    }
    const states = weaponStateMap(entity);
    if (!states) {
        return;
    }
    for (const [id, value] of firing) {
        const state = states.get(id);
        if (state) {
            state.firing = value;
        }
    }
}

// WeaponsState is owned by the local client only for its `firing` field. Keep
// the policy name-based so nova_ecs does not depend on the Nova game package.
replicationPolicies.registerName(WEAPONS_STATE_COMPONENT_NAME, {
    codec: t.any,
    authority: 'entity-owner',
    merge: mergeWeaponStateIntent,
    // The server derives weapon result state from authoritative outfits. Keep
    // only the trigger intent from a client's first entity state until that
    // derived component exists.
    acceptInitialOwnerState: false,
    allowOwnerRemoval: false,
    relayOwnerChanges: true,
});

function policyFor(componentName: string): ReplicationPolicy {
    // Components without a special policy retain the historical
    // entity-owner replication behavior.
    return replicationPolicies.get(componentName) ?? {
        codec: t.unknown,
        authority: 'entity-owner',
    };
}

function canApplyInbound(
    componentName: string,
    source: string,
    peerIsAdmin: boolean,
    localUuid: string,
    owner: string,
): boolean {
    switch (policyFor(componentName).authority) {
        case 'local-only':
            return false;
        case 'server':
            return peerIsAdmin;
        case 'owning-client':
            return !(peerIsAdmin && owner === localUuid);
        case 'entity-owner':
            return peerIsAdmin || source === owner;
    }
}

function canSendOutbound(
    componentName: string,
    localUuid: string,
    isAdmin: boolean,
    owner: string,
): boolean {
    switch (policyFor(componentName).authority) {
        case 'local-only':
            return false;
        case 'server':
            return isAdmin;
        case 'owning-client':
            // The server relays owning-client deltas explicitly. It must not
            // manufacture a second MovementState stream from its simulation.
            return owner === localUuid;
        case 'entity-owner':
            return isAdmin || owner === localUuid;
    }
}

function canSendFullState(
    componentName: string,
    localUuid: string,
    isAdmin: boolean,
    owner: string,
): boolean {
    if (policyFor(componentName).authority === 'owning-client' && isAdmin) {
        // A newly joining observer still needs the latest complete movement
        // basis. The owning client preserves its existing local copy.
        return true;
    }
    return canSendOutbound(componentName, localUuid, isAdmin, owner);
}

function mergeContext(
    source: string,
    peerIsAdmin: boolean,
    localUuid: string,
    localIsAdmin: boolean,
    owner: string,
): ReplicationMergeContext {
    return { source, peerIsAdmin, localUuid, localIsAdmin, owner };
}

function isOwnerToServer(context: ReplicationMergeContext): boolean {
    return context.localIsAdmin
        && !context.peerIsAdmin
        && context.source === context.owner;
}

function hasComponentNamed(entity: Entity, componentName: string): boolean {
    return [...entity.components.keys()]
        .some(component => component.name === componentName);
}

function encodeComponentSnapshot(
    serializer: Serializer,
    component: Component<unknown>,
    data: unknown,
): unknown {
    const componentType = serializer.componentTypes.get(component);
    if (!componentType) {
        return;
    }
    return componentType.encode(isDraft(data) ? current(data) : data);
}

function canApplyComponentUpdate(
    componentName: string,
    entity: Entity,
    context: ReplicationMergeContext,
): boolean {
    if (!canApplyInbound(
        componentName,
        context.source,
        context.peerIsAdmin,
        context.localUuid,
        context.owner,
    )) {
        return false;
    }
    const policy = policyFor(componentName);
    return !(isOwnerToServer(context)
        && policy.acceptInitialOwnerState === false
        && !hasComponentNamed(entity, componentName));
}

function canApplyComponentRemoval(
    componentName: string,
    context: ReplicationMergeContext,
): boolean {
    return canApplyInbound(
        componentName,
        context.source,
        context.peerIsAdmin,
        context.localUuid,
        context.owner,
    ) && !(isOwnerToServer(context)
        && policyFor(componentName).allowOwnerRemoval === false);
}

function filterEntityDelta(
    entityDelta: EntityDelta,
    entity: Entity,
    source: string,
    peerIsAdmin: boolean,
    localUuid: string,
    localIsAdmin: boolean,
    owner: string,
): EntityDelta | undefined {
    const context = mergeContext(
        source, peerIsAdmin, localUuid, localIsAdmin, owner);
    const componentStates = new Map(
        [...entityDelta.componentStates ?? []]
            .filter(([name]) => canApplyComponentUpdate(
                name, entity, context)),
    );
    const componentDeltas = new Map(
        [...entityDelta.componentDeltas ?? []]
            .filter(([name]) => canApplyComponentUpdate(
                name, entity, context)),
    );
    const removeComponents = new Set(
        [...entityDelta.removeComponents ?? []]
            .filter(name => canApplyComponentRemoval(name, context)),
    );
    const filtered: EntityDelta = {};
    if (componentStates.size > 0) {
        filtered.componentStates = componentStates;
    }
    if (componentDeltas.size > 0) {
        filtered.componentDeltas = componentDeltas;
    }
    if (removeComponents.size > 0) {
        filtered.removeComponents = removeComponents;
    }
    return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function filterEncodedEntity(
    encodedEntity: EncodedEntity,
    localUuid: string,
    isAdmin: boolean,
    owner: string,
): EncodedEntity {
    return {
        ...encodedEntity,
        components: encodedEntity.components
            .filter(([name]) =>
                canSendFullState(name, localUuid, isAdmin, owner))
            .map(([name, value]) => [
                name,
                name === MovementStateComponent.name
                    ? quantizeEncodedMovement(value)
                    : value,
            ] as [string, unknown]),
    };
}

function quantizeEncodedMovement(value: unknown): unknown {
    const decoded = MovementState.decode(value);
    return isLeft(decoded)
        ? value
        : MovementState.encode(quantizeMovementState(decoded.right));
}

function owningClientDelta(
    entityDelta: EntityDelta,
    entity: Entity,
    serializer: Serializer,
): EntityDelta | undefined {
    const componentStates = new Map(
        [...entityDelta.componentStates ?? []]
            .filter(([name]) =>
                policyFor(name).authority === 'owning-client'),
    );
    const componentDeltas = new Map(
        [...entityDelta.componentDeltas ?? []]
            .filter(([name]) =>
                policyFor(name).authority === 'owning-client'),
    );
    const removeComponents = new Set(
        [...entityDelta.removeComponents ?? []]
            .filter(name =>
                policyFor(name).authority === 'owning-client'),
    );
    const filtered: EntityDelta = {};
    if (componentStates.size > 0) {
        filtered.componentStates = componentStates;
    }
    if (componentDeltas.size > 0) {
        filtered.componentDeltas = componentDeltas;
    }
    if (removeComponents.size > 0) {
        filtered.removeComponents = removeComponents;
    }

    const changedNames = new Set([
        ...entityDelta.componentStates?.keys() ?? [],
        ...entityDelta.componentDeltas?.keys() ?? [],
    ]);
    for (const componentName of changedNames) {
        if (!policyFor(componentName).relayOwnerChanges) {
            continue;
        }
        const component = serializer.componentsByName.get(componentName);
        if (!component || !entity.components.has(component)) {
            continue;
        }
        const encoded = encodeComponentSnapshot(
            serializer,
            component,
            entity.components.get(component),
        );
        if (encoded === undefined) {
            continue;
        }
        if (!filtered.componentStates) {
            filtered.componentStates = new Map();
        }
        filtered.componentStates.set(componentName, encoded);
    }
    return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function mergeEntityDeltas(
    first: EntityDelta,
    second: EntityDelta,
): EntityDelta {
    const merged: EntityDelta = {};
    const componentStates = new Map([
        ...(first.componentStates ?? []),
        ...(second.componentStates ?? []),
    ]);
    const componentDeltas = new Map([
        ...(first.componentDeltas ?? []),
        ...(second.componentDeltas ?? []),
    ]);
    const removeComponents = new Set([
        ...(first.removeComponents ?? []),
        ...(second.removeComponents ?? []),
    ]);
    if (componentStates.size > 0) {
        merged.componentStates = componentStates;
    }
    if (componentDeltas.size > 0) {
        merged.componentDeltas = componentDeltas;
    }
    if (removeComponents.size > 0) {
        merged.removeComponents = removeComponents;
    }
    return merged;
}

function containsMovementState(entityDelta: EntityDelta): boolean {
    return entityDelta.componentStates?.has(MovementStateComponent.name)
        || entityDelta.componentDeltas?.has(MovementStateComponent.name)
        || false;
}

function canApplyMovementInbound(
    source: string,
    peerIsAdmin: boolean,
    localIsAdmin: boolean,
    localUuid: string,
    owner: string,
): boolean {
    if (peerIsAdmin) {
        // The local owner remains authoritative for its own presentation.
        return owner !== localUuid;
    }
    // Client movement is accepted by the server, not directly by observers.
    return localIsAdmin && source === owner;
}

function separateMovementSnapshot(
    entityDelta: EntityDelta,
    entity: Entity,
): {
    delta: EntityDelta | undefined;
    movement: MovementState | undefined;
} {
    const encodedMovement = entityDelta.componentStates
        ?.get(MovementStateComponent.name)
        ?? entityDelta.componentDeltas?.get(MovementStateComponent.name);
    let movement: MovementState | undefined;
    if (encodedMovement !== undefined) {
        const decodedState = MovementState.decode(encodedMovement);
        if (!isLeft(decodedState)) {
            movement = decodedState.right;
        } else {
            const decodedDelta = MovementStateDelta.decode(encodedMovement);
            const base = entity.components
                .get(RemoteMovementPresentationComponent)
                ?.snapshots.at(-1)?.state
                ?? entity.components.get(MovementStateComponent);
            if (!isLeft(decodedDelta) && base) {
                movement = copyMovementState(base);
                applyMovementStateDelta(movement, decodedDelta.right);
            }
        }
    }

    const componentStates = new Map(entityDelta.componentStates ?? []);
    const componentDeltas = new Map(entityDelta.componentDeltas ?? []);
    componentStates.delete(MovementStateComponent.name);
    componentDeltas.delete(MovementStateComponent.name);
    const filtered: EntityDelta = {};
    if (componentStates.size > 0) {
        filtered.componentStates = componentStates;
    }
    if (componentDeltas.size > 0) {
        filtered.componentDeltas = componentDeltas;
    }
    if (entityDelta.removeComponents?.size) {
        filtered.removeComponents = entityDelta.removeComponents;
    }
    return {
        delta: Object.keys(filtered).length > 0 ? filtered : undefined,
        movement,
    };
}

function filterOutboundDelta(
    entityDelta: EntityDelta,
    localUuid: string,
    isAdmin: boolean,
    owner: string,
): EntityDelta | undefined {
    const componentStates = new Map(
        [...entityDelta.componentStates ?? []]
            .filter(([name]) => canSendOutbound(name, localUuid, isAdmin, owner))
            .map(([name, value]) => [
                name,
                name === MovementStateComponent.name
                    ? quantizeEncodedMovement(value)
                    : value,
            ] as [string, unknown]),
    );
    const componentDeltas = new Map(
        [...entityDelta.componentDeltas ?? []]
            .filter(([name]) => canSendOutbound(name, localUuid, isAdmin, owner)),
    );
    const removeComponents = new Set(
        [...entityDelta.removeComponents ?? []]
            .filter(name => canSendOutbound(name, localUuid, isAdmin, owner)),
    );
    const filtered: EntityDelta = {};
    if (componentStates.size > 0) {
        filtered.componentStates = componentStates;
    }
    if (componentDeltas.size > 0) {
        filtered.componentDeltas = componentDeltas;
    }
    if (removeComponents.size > 0) {
        filtered.removeComponents = removeComponents;
    }
    return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function sanitizeInboundEntity(
    entity: Entity,
    source: string,
    peerIsAdmin: boolean,
    localUuid: string,
    localIsAdmin: boolean,
    hasExistingEntity: boolean,
): Entity {
    const owner = entity.components.get(MultiplayerData)?.owner ?? '';
    for (const component of [...entity.components.keys()]) {
        if (!canApplyInbound(
            component.name, source, peerIsAdmin, localUuid, owner)) {
            // An owning-client component is retained on first creation: there
            // is no local state to preserve yet. local-only and server-owned
            // components still follow their policy on every full-state path.
            if (policyFor(component.name).authority !== 'owning-client') {
                entity.components.delete(component);
            }
        } else if (!hasExistingEntity
            && isOwnerToServer(mergeContext(
                source, peerIsAdmin, localUuid, localIsAdmin, owner))
            && policyFor(component.name).acceptInitialOwnerState === false) {
            entity.components.delete(component);
        }
    }
    return entity;
}

function mergeInboundState(
    localEntity: Entity,
    remoteEntity: Entity,
    source: string,
    peerIsAdmin: boolean,
    localUuid: string,
    localIsAdmin: boolean,
): Entity {
    const owner = localEntity.components.get(MultiplayerData)?.owner
        ?? remoteEntity.components.get(MultiplayerData)?.owner
        ?? '';
    const context = mergeContext(
        source, peerIsAdmin, localUuid, localIsAdmin, owner);
    for (const [component, data] of remoteEntity.components) {
        if (canApplyInbound(
            component.name, source, peerIsAdmin, localUuid, owner)) {
            const policy = policyFor(component.name);
            const localData = localEntity.components.get(component);
            const merged = localData !== undefined && policy.merge
                ? policy.merge(localData, data, context)
                : data;
            localEntity.components.set(component, merged);
        }
    }
    for (const component of [...localEntity.components.keys()]) {
        if (!remoteEntity.components.has(component)
            && canApplyComponentRemoval(component.name, context)) {
            localEntity.components.delete(component);
        }
    }
    return localEntity;
}

export function multiplayer(communicator: Communicator,
    warn: (message: string) => void = console.warn): Plugin {
    const MultiplayerQuery = new Query([UUID, GetEntity, MultiplayerData] as const);
    const lastMovementSnapshotAt = new Map<string, number>();
    const lastMovementWireState = new Map<string, MovementState>();
    const nextMovementSequenceByEntity = new Map<string, number>();
    const latestInboundMovement = new Map<string, {
        source: string;
        peerIsAdmin: boolean;
        sequence?: number;
        sourceTime?: number;
    }>();
    const sourceClockOffsets = new Map<string, {
        offset: number;
        lastMappedTime?: number;
    }>();
    const interestedEntitiesByPeer = new Map<string, Set<string>>();
    const deferredOwnerWeaponIntent = new Map<string, Map<string, boolean>>();
    const movementSnapshotIntervalMs = 100;
    let messageSubscription: { unsubscribe(): void } | undefined;
    let peerLeaveSubscription: { unsubscribe(): void } | undefined;

    function nextMovementSequence(uuid: string): number {
        const sequence = (nextMovementSequenceByEntity.get(uuid) ?? 0) + 1;
        nextMovementSequenceByEntity.set(uuid, sequence);
        return sequence;
    }

    function clearMovementLifecycle(uuid: string): void {
        lastMovementSnapshotAt.delete(uuid);
        lastMovementWireState.delete(uuid);
        nextMovementSequenceByEntity.delete(uuid);
        latestInboundMovement.delete(uuid);
    }

    const multiplayerSystem = new System({
        name: 'Multiplayer',
        args: [MultiplayerQuery, Entities, Comms,
               DeltaResource, SerializerResource, Emit,
               TimeResource] as const,
        during: [MultiplayerPhase],
        step: (query, entities, comms, deltaMaker, serializer, emit, time) => {
            if (comms.uuid && communicator.uuid && comms.uuid !== communicator.uuid) {
                // Change the owner of all entities owned by our previous uuid
                // to our current uuid.
                for (const [, , multiplayerData] of query) {
                    if (multiplayerData.owner === comms.uuid) {
                        multiplayerData.owner = communicator.uuid;
                    }
                }
            }

            comms.uuid = communicator.uuid;
            if (!comms.uuid) {
                // Can't do anything if we don't have a uuid.
                return;
            }

            const isAdmin = comms.admins.has(comms.uuid);
            const localTime = time.fixedDelta_ms === undefined
                ? Math.max(time.time, wallClockNow())
                : time.time;
            if (time.fixedDelta_ms === undefined) {
                // A lightweight multiplayer-only world (such as the browser
                // room shell) may not install TimePlugin. Keep its sender
                // clock advancing instead of reusing its initial fallback.
                time.time = localTime;
            }

            function observeSourceClock(source: string, sourceTime: number) {
                const sampleOffset = localTime - sourceTime;
                const clock = sourceClockOffsets.get(source);
                if (!clock) {
                    sourceClockOffsets.set(source, { offset: sampleOffset });
                    return;
                }

                // Message latency is part of the presentation offset. Smooth
                // its jitter instead of allowing one packet to move the
                // interpolation cursor backwards.
                const correction = (sampleOffset - clock.offset) * 0.1;
                clock.offset += Math.max(-25, Math.min(25, correction));
            }

            function mapSourceTime(
                source: string,
                sourceTime: number | undefined,
            ): number {
                if (sourceTime === undefined || !Number.isFinite(sourceTime)) {
                    return localTime;
                }

                let clock = sourceClockOffsets.get(source);
                if (!clock) {
                    // Older peers may have per-movement timestamps but no
                    // message send time. Establish a source-specific basis
                    // from the first timestamp and keep using local time
                    // until another sample is available.
                    clock = { offset: localTime - sourceTime };
                    sourceClockOffsets.set(source, clock);
                }
                const mapped = sourceTime + clock.offset;
                clock.lastMappedTime = clock.lastMappedTime === undefined
                    ? mapped
                    : Math.max(clock.lastMappedTime, mapped);
                return clock.lastMappedTime;
            }

            function movementMetadata(
                messageSource: string,
                uuid: string,
                message: Message,
            ) {
                const sourceTimeValue = message.movementTimestamps?.get(uuid)
                    ?? message.sentAt;
                const sourceTime = sourceTimeValue !== undefined
                    && Number.isFinite(sourceTimeValue)
                    ? sourceTimeValue
                    : undefined;
                const sequenceValue = message.movementSequences?.get(uuid);
                const sequence = sequenceValue !== undefined
                    && Number.isInteger(sequenceValue)
                    && sequenceValue >= 0
                    ? sequenceValue
                    : undefined;
                return {
                    sourceTime,
                    sequence,
                    presentationTime: mapSourceTime(
                        messageSource, sourceTime),
                };
            }

            function acceptMovement(
                uuid: string,
                source: string,
                peerIsAdmin: boolean,
                sequence: number | undefined,
                sourceTime: number | undefined,
            ): boolean {
                const previous = latestInboundMovement.get(uuid);
                const current = {
                    source,
                    peerIsAdmin,
                    sequence,
                    sourceTime,
                };
                if (!previous) {
                    latestInboundMovement.set(uuid, current);
                    return true;
                }
                if (previous.peerIsAdmin && !peerIsAdmin) {
                    return false;
                }
                if (peerIsAdmin && !previous.peerIsAdmin) {
                    latestInboundMovement.set(uuid, current);
                    return true;
                }
                if (previous.source !== source) {
                    latestInboundMovement.set(uuid, current);
                    return true;
                }
                if (sequence !== undefined && previous.sequence !== undefined) {
                    if (sequence <= previous.sequence) {
                        return false;
                    }
                    latestInboundMovement.set(uuid, current);
                    return true;
                }
                if (sequence === undefined && previous.sequence !== undefined) {
                    return false;
                }
                if (sourceTime !== undefined && previous.sourceTime !== undefined) {
                    if (sourceTime <= previous.sourceTime) {
                        return false;
                    }
                    latestInboundMovement.set(uuid, current);
                    return true;
                }
                if (sourceTime === undefined && previous.sourceTime === undefined) {
                    // There is no ordering metadata in this legacy packet.
                    // Preserve the old arrival-order behavior; newer peers
                    // always include at least a send timestamp.
                    latestInboundMovement.set(uuid, current);
                    return true;
                }
                latestInboundMovement.set(uuid, current);
                return true;
            }

            function markMovement(uuid: string) {
                movementTimestamps.set(uuid, localTime);
                if (!movementSequences.has(uuid)) {
                    movementSequences.set(uuid, nextMovementSequence(uuid));
                }
            }

            function rememberOwnerMovement(
                uuid: string,
                movementState: MovementState,
                source: string,
                owner: string,
            ): void {
                if (isAdmin && source === owner) {
                    const quantized = quantizeMovementState(movementState);
                    lastMovementWireState.set(uuid, quantized);
                    const entity = entities.get(uuid);
                    if (!entity) {
                        return;
                    }
                    let track = entity.components.get(
                        GuidanceTargetTrackComponent);
                    if (!track) {
                        track = { snapshots: [] };
                        entity.components.set(
                            GuidanceTargetTrackComponent, track);
                    }
                    queueGuidanceTargetSnapshot(track, quantized, localTime);
                }
            }

            function encodeReplicatedEntity(
                entity: Entity,
                uuid: string,
                owner: string,
            ): EncodedEntity {
                const encoded = filterEncodedEntity(
                    serializer.encode(entity),
                    comms.uuid!,
                    isAdmin,
                    owner,
                );
                // The server may have integrated or knocked this ship locally
                // for hit detection. Observers must see the owner's last
                // accepted pose, not that competing copy.
                if (!isAdmin || owner === comms.uuid) {
                    return encoded;
                }
                const ownerMovement = lastMovementWireState.get(uuid);
                if (!ownerMovement) {
                    return encoded;
                }
                return {
                    ...encoded,
                    components: encoded.components.map(([name, value]) => (
                        name === MovementStateComponent.name
                            ? [name, MovementState.encode(ownerMovement)]
                            : [name, value]
                    ) as [string, unknown]),
                };
            }

            function randomAdmin() {
                const remoteAdmins = [...comms.admins]
                    .filter(admin => admin !== comms.uuid);
                return remoteAdmins[
                    Math.floor(Math.random() * remoteAdmins.length)
                ];
            }

            // Request initial state
            if (!comms.initialStateRequested) {
                if (isAdmin) {
                    // The authoritative world is already the source of truth.
                    comms.initialStateRequested = true;
                } else {
                    const admin = randomAdmin();
                    if (admin) {
                        sendMessage({
                            requestState: {
                                uuids: new Set(),
                                invert: true,
                            }
                        }, admin);
                        comms.initialStateRequested = true;
                    }
                }
            }

            function sendMessage(message: Message, destination?: string) {
                communicator.sendMessage(Message.encode({
                    ...message,
                    // `sentAt` is always in this communicator's clock
                    // domain. In particular, a server must not forward a
                    // client-owned timestamp from an incoming packet.
                    sentAt: localTime,
                }), destination);
            }

            const entityMap = new Map(query.map(([uuid, entity, data]) =>
                [uuid, { entity, data }]));
            const entityUuids = new Set(entityMap.keys());
            function interestedEntityUuids(peer: string): Set<string> {
                const centres = [...entityMap.values()]
                    .filter(({ entity }) => entity.components
                        .get(MultiplayerData)?.owner === peer)
                    .map(({ entity }) =>
                        entity.components.get(MovementStateComponent))
                    .filter((movement): movement is MovementState =>
                        movement !== undefined);
                if (centres.length === 0) {
                    return new Set(entityMap.keys());
                }
                return new Set([...entityMap]
                    .filter(([, { entity }]) => {
                        if (entity.components.get(MultiplayerData)?.owner
                            === peer) {
                            return true;
                        }
                        const movement = entity.components
                            .get(MovementStateComponent);
                        return movement === undefined
                            || centres.some(centre =>
                                positionsWithinInterest(centre, movement));
                    })
                    .map(([uuid]) => uuid));
            }
            // Capture local weapon edges before applying inbound state. A
            // merge may make the eventual value equal to its new tracking
            // baseline; the edge must still be emitted (especially keyup).
            const localWeaponIntentChanges = new Set<string>();
            if (!isAdmin) {
                for (const [uuid, { entity, data }] of entityMap) {
                    const component = weaponStateComponent(entity);
                    if (data.owner === comms.uuid
                        && component
                        && deltaMaker.isComponentDirty(entity, component)) {
                        localWeaponIntentChanges.add(uuid);
                    }
                }
            }
            if (isAdmin) {
                for (const [uuid, firing] of deferredOwnerWeaponIntent) {
                    const entry = entityMap.get(uuid);
                    if (!entry) {
                        deferredOwnerWeaponIntent.delete(uuid);
                        continue;
                    }
                    const states = weaponStateMap(entry.entity);
                    if (!states) {
                        continue;
                    }
                    restoreWeaponFiring(entry.entity, firing);
                    deferredOwnerWeaponIntent.delete(uuid);
                }
            }

            // Entities to request the full state of
            // keyed by who to ask for them.
            const fullStateRequests = new DefaultMap<string, Set<string>>(() => new Set());

            // Track entities added and removed
            const added = new Map<string, string>();
            const removed = new Set<string>();
            // Owning-client MovementState is accepted by the server and
            // forwarded verbatim to observers. The server simulates that state
            // for gameplay, but never publishes its own competing movement
            // correction for the client-owned entity.
            const relayedDeltas = new Map<string, EntityDelta>();
            const relayedStates = new Map<string, EncodedEntity>();
            const movementTimestamps = new Map<string, number>();
            const movementSequences = new Map<string, number>();
            const relayedChat: ChatMessageEntry[] = [];

            // Apply changes from messages
            for (const { source, message } of comms.messages) {
                const peerIsAdmin = comms.admins.has(source);
                if (message.sentAt !== undefined
                    && Number.isFinite(message.sentAt)) {
                    observeSourceClock(source, message.sentAt);
                }

                // Set admins
                if (peerIsAdmin && message.admins) {
                    comms.admins = message.admins;
                }

                // Handle chat messages
                if (message.chat && message.chat.length > 0) {
                    for (const entry of message.chat) {
                        if (isAdmin) {
                            relayedChat.push(entry);
                        } else {
                            if (entry.to === comms.uuid || entry.to === 'all' || entry.from === comms.uuid) {
                                emit(ChatMessageEvent, entry);
                            }
                        }
                    }
                }

                // Send requested states
                if (message.requestState) {
                    let uuidsToSend: string[];
                    if (message.requestState.invert) {
                        uuidsToSend = [...setDifference(entityUuids, message.requestState.uuids)];
                    } else {
                        uuidsToSend = [...message.requestState.uuids].filter(
                            uuid => entityUuids.has(uuid));
                    }
                    // The filters above use the start-of-step snapshot, which
                    // can still name an entity a peer removed earlier in this
                    // same step.
                    uuidsToSend = uuidsToSend.filter(
                        uuid => entityMap.has(uuid));
                    if (isAdmin) {
                        const interested = interestedEntityUuids(source);
                        uuidsToSend = uuidsToSend.filter(
                            uuid => interested.has(uuid));
                    }

                    const stateMovementTimestamps = new Map<string, number>();
                    const stateMovementSequences = new Map<string, number>();
                    const state = new Map(uuidsToSend.map(entityUuid => {
                        const entry = entityMap.get(entityUuid)!;
                        const { entity } = entry;
                        const owner = entity.components
                            .get(MultiplayerData)?.owner ?? '';
                        if (entity.components.has(MovementStateComponent)) {
                            stateMovementTimestamps.set(entityUuid, localTime);
                            stateMovementSequences.set(
                                entityUuid, nextMovementSequence(entityUuid));
                        }
                        return [entityUuid, encodeReplicatedEntity(
                            entity, entityUuid, owner)];
                    }));

                    sendMessage({
                        state,
                        movementTimestamps: stateMovementTimestamps,
                        movementSequences: stateMovementSequences,
                    }, source);
                    if (isAdmin) {
                        const known = interestedEntitiesByPeer.get(source)
                            ?? new Set<string>();
                        for (const uuid of state.keys()) {
                            known.add(uuid);
                        }
                        interestedEntitiesByPeer.set(source, known);
                    }
                }

                // Remove entities
                for (const uuid of message.remove ?? []) {
                    const existing = entityMap.get(uuid);
                    if (!existing) {
                        // Never replicated into this client's interest window,
                        // or already gone locally.
                        continue;
                    }
                    if (existing.data.owner === source || peerIsAdmin) {
                        const removedEntity = existing.entity;
                        if (removedEntity) {
                            deltaMaker.untrack(removedEntity);
                        }
                        entities.delete(uuid);
                        fullStateRequests.delete(uuid);
                        added.delete(uuid);
                        removed.add(uuid);
                        entityMap.delete(uuid);
                        relayedStates.delete(uuid);
                        deferredOwnerWeaponIntent.delete(uuid);
                        clearMovementLifecycle(uuid);
                    } else {
                        warn(`'${source}' tried to remove ${uuid}`);
                    }
                }

                // Add new entities
                for (const [uuid, encodedEntity] of message.state ?? []) {
                    const maybeEntity = serializer.decode(encodedEntity);
                    if (isLeft(maybeEntity)) {
                        warn(`Failed to decode entity: ${maybeEntity.left}`);
                        continue;
                    }
                    const decodedEntity = maybeEntity.right;
                    const existingEntry = entityMap.get(uuid);
                    if (existingEntry
                        && existingEntry.data.owner !== source
                        && !peerIsAdmin) {
                        warn(`'${source}' tried to replace existing entity '${uuid}'`);
                        continue;
                    }
                    if (!existingEntry) {
                        clearMovementLifecycle(uuid);
                    }
                    const decodedOwnerBeforeSanitize = decodedEntity.components
                        .get(MultiplayerData)?.owner ?? '';
                    if (!existingEntry
                        && isAdmin
                        && !peerIsAdmin
                        && decodedOwnerBeforeSanitize === source) {
                        const initialWeaponIntent =
                            captureWeaponFiring(decodedEntity);
                        if (initialWeaponIntent) {
                            deferredOwnerWeaponIntent.set(
                                uuid, initialWeaponIntent);
                        }
                    }
                    sanitizeInboundEntity(
                        decodedEntity,
                        source,
                        peerIsAdmin,
                        comms.uuid,
                        isAdmin,
                        existingEntry !== undefined,
                    );
                    const decodedOwner = decodedEntity.components
                        .get(MultiplayerData)?.owner ?? '';
                    const decodedMovement = decodedEntity.components
                        .get(MovementStateComponent);
                    const movementCanApply = decodedMovement !== undefined
                        && canApplyMovementInbound(
                            source,
                            peerIsAdmin,
                            isAdmin,
                            comms.uuid!,
                            decodedOwner,
                        );
                    const movement = decodedMovement
                        ? movementMetadata(source, uuid, message)
                        : undefined;
                    const movementAccepted = movementCanApply
                        && movement !== undefined
                        && acceptMovement(
                            uuid,
                            source,
                            peerIsAdmin,
                            movement.sequence,
                            movement.sourceTime,
                        );
                    if (decodedMovement && (!movementCanApply
                        || !movementAccepted)) {
                        // Preserve an existing authoritative basis while
                        // dropping stale or out-of-path movement updates.
                        const existingMovement = existingEntry?.entity
                            .components.get(MovementStateComponent);
                        const presentationMovement = existingEntry?.entity
                            .components.get(RemoteMovementPresentationComponent)
                            ?.snapshots.at(-1)?.state;
                        if (existingMovement ?? presentationMovement) {
                            decodedEntity.components.set(
                                MovementStateComponent,
                                existingMovement ?? presentationMovement!,
                            );
                        } else if (!(peerIsAdmin
                            && decodedOwner === comms.uuid
                            && existingEntry === undefined)) {
                            // A first server state may be the only basis for
                            // a local owner that is still being restored.
                            decodedEntity.components.delete(
                                MovementStateComponent);
                        }
                    }
                    const remoteMovement = peerIsAdmin
                        && decodedOwner !== comms.uuid
                        && movementCanApply
                        && decodedMovement !== undefined;
                    const preserveClientState: boolean = peerIsAdmin
                        && existingEntry?.data.owner === comms.uuid;
                    const preserveRemotePresentation = remoteMovement
                        && existingEntry !== undefined;
                    const preservePolicyState = existingEntry !== undefined
                        && [
                            ...existingEntry.entity.components.keys(),
                            ...decodedEntity.components.keys(),
                        ].some(component =>
                            policyFor(component.name).merge !== undefined);
                    if (preserveRemotePresentation) {
                        // Keep the interpolated presentation state. The
                        // authoritative state is queued below instead of being
                        // installed as a delayed visible position.
                        const existingMovement = existingEntry!.entity
                            .components.get(MovementStateComponent);
                        if (existingMovement) {
                            decodedEntity.components.set(
                                MovementStateComponent, existingMovement);
                        }
                    }
                    const preserveExistingEntity = preserveClientState
                        || preserveRemotePresentation
                        || preservePolicyState;
                    let entity: Entity;
                    if (preserveExistingEntity) {
                        entity = existingEntry!.entity;
                        const localWeaponFiring = preserveClientState
                            ? captureWeaponFiring(entity)
                            : undefined;
                        deltaMaker.applyRemoteUpdate(entity, () => {
                            mergeInboundState(
                                entity,
                                decodedEntity,
                                source,
                                peerIsAdmin,
                                comms.uuid!,
                                isAdmin,
                            );
                        });
                        // The merge policy handles full states. Reapply the
                        // live intent after DeltaMaker replays any pending
                        // local deltas, too.
                        restoreWeaponFiring(entity, localWeaponFiring);
                    } else {
                        entity = decodedEntity;
                    }
                    if (remoteMovement && decodedMovement
                        && movementAccepted && movement) {
                        let presentation = entity.components
                            .get(RemoteMovementPresentationComponent);
                        if (!presentation) {
                            presentation = { snapshots: [] };
                            entity.components.set(
                                RemoteMovementPresentationComponent,
                                presentation,
                            );
                        }
                        queueRemoteMovementSnapshot(
                            presentation,
                            decodedMovement,
                            movement.presentationTime,
                            movement.sequence,
                        );
                    }
                    if (decodedMovement && movementAccepted) {
                        rememberOwnerMovement(
                            uuid, decodedMovement, source, decodedOwner);
                    }

                    const multiplayerData = entity.components.get(MultiplayerData);
                    if (!multiplayerData) {
                        warn(`New entity '${uuid}' missing MultiplayerData`);
                        continue;
                    }
                    if (!preserveExistingEntity) {
                        deltaMaker.untrack(
                            entityMap.get(uuid)?.entity ?? entity,
                        );
                        entities.set(uuid, entity);
                    }
                    added.set(uuid, multiplayerData.owner);
                    removed.delete(uuid);

                    // Add the newly added entity to the entityMap so we don't
                    // accidentally request its state in `apply deltas`.
                    const handle = entities.get(uuid)!;
                    entityMap.set(uuid, { entity: handle, data: multiplayerData });

                    if (isAdmin && !peerIsAdmin
                        && multiplayerData.owner === source) {
                        // Forward the authoritative basis for a newly seen
                        // client-owned entity. Its movement metadata is
                        // restamped below just like a delta relay.
                        relayedStates.set(uuid, encodeReplicatedEntity(
                            entity, uuid, multiplayerData.owner));
                        if (entity.components.has(MovementStateComponent)) {
                            markMovement(uuid);
                        }
                    }

                    // If the new entity is owned by us, emit that fact.
                    if (multiplayerData.owner === comms.uuid) {
                        emit(NewOwnedEntityEvent, uuid);
                    }
                }

                // Set UUIDs
                if (message.ownedUuids) {
                    comms.ownedUuids = new Set(message.ownedUuids);
                }

                // Apply deltas
                for (const [uuid, entityDelta] of message.delta ?? []) {
                    if (!entityMap.has(uuid)) {
                        fullStateRequests.get(source).add(uuid);
                        continue;
                    }
                    const { entity, data } = entityMap.get(uuid)!;
                    const owner = data.owner;

                    if (source !== owner && !peerIsAdmin) {
                        warn(`'${source}' tried to modify entity '${uuid}'`);
                        continue;
                    }
                    try {
                        let delta = filterEntityDelta(
                            entityDelta,
                            entity,
                            source,
                            peerIsAdmin,
                            comms.uuid,
                            isAdmin,
                            owner,
                        );
                        const remoteMovement = peerIsAdmin
                            && owner !== comms.uuid
                            && delta !== undefined
                            && containsMovementState(delta);
                        const movementCanApply = delta !== undefined
                            && containsMovementState(delta)
                            && canApplyMovementInbound(
                                source,
                                peerIsAdmin,
                                isAdmin,
                                comms.uuid!,
                                owner,
                            );
                        let movementAccepted = true;
                        let movement: ReturnType<typeof movementMetadata>
                            | undefined;
                        if (delta && containsMovementState(delta)) {
                            const separated = separateMovementSnapshot(delta, entity);
                            movement = movementMetadata(source, uuid, message);
                            movementAccepted = movementCanApply
                                && separated.movement !== undefined
                                && acceptMovement(
                                    uuid,
                                    source,
                                    peerIsAdmin,
                                    movement.sequence,
                                    movement.sourceTime,
                                );
                            if (remoteMovement) {
                                delta = separated.delta;
                            } else if (!movementAccepted) {
                                delta = separated.delta;
                            }
                            if (remoteMovement && separated.movement
                                && movementAccepted && movement) {
                                let presentation = entity.components
                                    .get(RemoteMovementPresentationComponent);
                                if (!presentation) {
                                    presentation = { snapshots: [] };
                                    entity.components.set(
                                        RemoteMovementPresentationComponent,
                                        presentation,
                                    );
                                }
                                queueRemoteMovementSnapshot(
                                    presentation,
                                    separated.movement,
                                    movement.presentationTime,
                                    movement.sequence,
                                );
                            }
                            if (separated.movement && movementAccepted) {
                                rememberOwnerMovement(
                                    uuid, separated.movement, source, owner);
                            }
                        }
                        if (delta) {
                            const localWeaponFiring = peerIsAdmin
                                && owner === comms.uuid
                                ? captureWeaponFiring(entity)
                                : undefined;
                            const context = mergeContext(
                                source,
                                peerIsAdmin,
                                comms.uuid,
                                isAdmin,
                                owner,
                            );
                            deltaMaker.applyRemoteDelta(
                                entity,
                                delta,
                                (component, local, remote) => {
                                    const merge = policyFor(
                                        component.name).merge;
                                    return merge
                                        ? merge(local, remote, context)
                                        : remote;
                                },
                            );
                            // DeltaMaker only preserves changes that are
                            // still pending. A held trigger can already have
                            // been sent, so preserve the current intent
                            // explicitly across every server delta.
                            restoreWeaponFiring(entity, localWeaponFiring);
                            entityMap.set(uuid, {
                                entity,
                                data: entity.components.get(MultiplayerData)!,
                            });
                            if (isAdmin && source === owner) {
                                const relay = owningClientDelta(
                                    delta, entity, serializer);
                                if (relay) {
                                    relayedDeltas.set(
                                        uuid,
                                        relayedDeltas.has(uuid)
                                            ? mergeEntityDeltas(
                                                relayedDeltas.get(uuid)!,
                                                relay,
                                            )
                                            : relay,
                                    );
                                    if (containsMovementState(relay)) {
                                        // This is a new server-authored
                                        // transport sample. Never expose the
                                        // owner's clock to observers.
                                        markMovement(uuid);
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.warn(`Failed to apply delta to ${uuid}`);
                        console.warn(e);
                    }
                }
            }
            // Reset messages since they've been processed.
            comms.messages = [];

            if (fullStateRequests.size > 0) {
                // Request state from a (maybe) trusted source
                for (const [source, uuids] of fullStateRequests) {
                    sendMessage({
                        requestState: {
                            uuids, invert: false,
                        }
                    }, source);
                }
            }
            const currentOwners = new Map([...entityMap].map(([uuid, val]) =>
                [uuid, val.entity.components.get(MultiplayerData)!.owner]));
            const entityOwners = new Map([
                ...currentOwners,
                ...comms.lastEntities,
            ]);

            // Entities added by us in the current step. `entityUuids` is a
            // snapshot taken before inbound messages were applied, so an
            // entity that a peer removed during this same step is still
            // listed here while already gone from `entityMap`. Announcing it
            // would describe an entity that no longer exists.
            const addedEntities = setDifference(entityUuids,
                new Set([...comms.lastEntities.keys(), ...added.keys(),
                    ...removed]));
            // Entities removed by us in the current step
            const removedEntities = setDifference(
                new Set([...comms.lastEntities.keys()]),
                new Set([...entityUuids, ...removed]));
            for (const uuid of removedEntities) {
                clearMovementLifecycle(uuid);
            }
            // Update the set of last seen entities.
            comms.lastEntities = new Map([
                ...currentOwners,
                ...added,
            ]);

            // A client can send more than one packet before this world steps.
            // Serialize relayed full states after all packets are applied so
            // a shared sequence cannot pair an old state with a newer delta.
            for (const uuid of [...relayedStates.keys()]) {
                const entry = entityMap.get(uuid);
                if (!entry) {
                    relayedStates.delete(uuid);
                    continue;
                }
                relayedStates.set(uuid, encodeReplicatedEntity(
                    entry.entity, uuid, entry.data.owner));
            }

            const delta = new Map<string, EntityDelta>(relayedDeltas);
            const state = new Map<string, EncodedEntity>(relayedStates);
            let ownedUuids: string[] = [];
            const remove = [...removedEntities].filter(entityUuid =>
                entityOwners.get(entityUuid) === comms.uuid || isAdmin);

            // Send states for new entities
            for (const uuid of addedEntities) {
                const val = entityMap.get(uuid);
                if (!val) {
                    // This runs inside world.step(), so throwing would abort
                    // the rest of the frame and stall the game outright. An
                    // entity that disappeared mid-step simply has nothing to
                    // announce.
                    warn(`No entity to announce for ${uuid}`);
                    continue;
                }
                const { entity } = val;
                if (!isAdmin && val.data.owner !== comms.uuid) {
                    continue;
                }

                state.set(uuid, encodeReplicatedEntity(
                    entity, uuid, val.data.owner));
                if (entity.components.has(MovementStateComponent)) {
                    markMovement(uuid);
                    lastMovementSnapshotAt.set(uuid, localTime);
                    lastMovementWireState.set(
                        uuid,
                        quantizeMovementState(
                            entity.components.get(MovementStateComponent)!),
                    );
                }
            }

            // Get deltas and create drafts 
            const ownedEntities = new Set<Entity>();
            for (const [uuid, { entity, data: multiplayerData }] of entityMap) {
                if (entityMap.get(uuid)?.entity !== entity) {
                    // A full-state replacement may have untracked and
                    // replaced this entity earlier in this same step.
                    continue;
                }
                const owner = multiplayerData.owner;
                if (owner === comms.uuid) {
                    // Interpolated presentation replaces local integration
                    // entirely. Once this peer owns the entity it must
                    // simulate its own movement, so a snapshot buffer left
                    // over from when the server owned it would freeze the
                    // ship between stale 10 Hz samples.
                    entity.components.delete(
                        RemoteMovementPresentationComponent);
                }
                if (owner !== comms.uuid && !isAdmin) {
                    deltaMaker.untrack(entity);
                    continue;
                }
                deltaMaker.track(entity);
                ownedEntities.add(entity);
                const currentDelta = deltaMaker.isDirty(entity)
                    ? deltaMaker.getDelta(entity)
                    : undefined;
                let entityDelta = currentDelta
                    ? filterOutboundDelta(
                        currentDelta,
                        comms.uuid,
                        isAdmin,
                        owner,
                    )
                    : undefined;
                deltaMaker.clearDirty(entity);
                if (localWeaponIntentChanges.has(uuid)) {
                    const component = weaponStateComponent(entity);
                    const states = weaponStateMap(entity);
                    const encoded = component && states
                        ? encodeComponentSnapshot(
                            serializer, component, states)
                        : undefined;
                    if (component && encoded !== undefined) {
                        const componentStates = new Map(
                            entityDelta?.componentStates ?? []);
                        const componentDeltas = new Map(
                            entityDelta?.componentDeltas ?? []);
                        componentStates.set(
                            component.name,
                            encoded,
                        );
                        componentDeltas.delete(component.name);
                        entityDelta = {
                            ...entityDelta,
                            componentStates,
                            componentDeltas: componentDeltas.size > 0
                                ? componentDeltas
                                : undefined,
                        };
                    }
                }
                const movement = entity.components.get(MovementStateComponent);
                if (entityDelta && containsMovementState(entityDelta)) {
                    markMovement(uuid);
                    lastMovementSnapshotAt.set(uuid, localTime);
                    if (movement) {
                        lastMovementWireState.set(
                            uuid, quantizeMovementState(movement));
                    }
                }

                const movementIsActive = movement
                    && (movement.velocity.lengthSquared > 1e-9
                        || movement.accelerating !== 0
                        || movement.turning !== 0
                        || Boolean(movement.turnTo));
                const lastSnapshot = lastMovementSnapshotAt.get(uuid);
                const periodicSnapshotDue = movementIsActive
                    && canSendOutbound(
                        MovementStateComponent.name,
                        comms.uuid,
                        isAdmin,
                        owner,
                    )
                    && (lastSnapshot === undefined
                        || localTime - lastSnapshot >= movementSnapshotIntervalMs);
                if (periodicSnapshotDue && movement) {
                    const snapshot = quantizeMovementState(movement);
                    const previous = lastMovementWireState.get(uuid);
                    const changed = previous === undefined
                        || quantizedMovementDelta(previous, movement)
                            !== undefined;
                    if (changed) {
                        // Send a complete pose, not a partial delta. A
                        // velocity-only server mutation (knockback) must not
                        // survive once the owner publishes again.
                        const snapshotDelta: EntityDelta = {
                            componentStates: new Map([[
                                MovementStateComponent.name,
                                MovementState.encode(snapshot),
                            ]]),
                        };
                        entityDelta = entityDelta
                            ? mergeEntityDeltas(entityDelta, snapshotDelta)
                            : snapshotDelta;
                        markMovement(uuid);
                        lastMovementWireState.set(uuid, snapshot);
                    }
                    lastMovementSnapshotAt.set(uuid, localTime);
                }
                if (entityDelta) {
                    delta.set(
                        uuid,
                        delta.has(uuid)
                            ? mergeEntityDeltas(delta.get(uuid)!, entityDelta)
                            : entityDelta,
                    );
                }
            }
            // Also release entities removed outside the multiplayer system.
            deltaMaker.untrackExcept(ownedEntities);

            const outboundChat = [...(comms.outboundChat ?? []), ...relayedChat];
            comms.outboundChat = [];

            const changes: Message = {};

            let send = false;
            if (outboundChat.length > 0) {
                changes.chat = outboundChat;
                send = true;
            }
            if (delta.size > 0) {
                changes.delta = delta;
                send = true;
            }
            if (state.size > 0) {
                changes.state = state;
                send = true;
            }
            if (movementTimestamps.size > 0) {
                changes.movementTimestamps = movementTimestamps;
            }
            if (movementSequences.size > 0) {
                changes.movementSequences = movementSequences;
            }
            if (remove.length > 0) {
                changes.remove = remove;
                send = true;
            }
            if (ownedUuids.length > 0) {
                changes.ownedUuids = ownedUuids;
                send = true;
            }

            function sendInterestManagedChanges(peer: string): void {
                const interested = interestedEntityUuids(peer);
                const previous = interestedEntitiesByPeer.get(peer)
                    ?? new Set<string>();
                const entering = setDifference(interested, previous);
                const leaving = setDifference(previous, interested);
                const peerState = new Map(
                    [...state].filter(([uuid]) => interested.has(uuid)));
                for (const uuid of entering) {
                    if (peerState.has(uuid)) {
                        continue;
                    }
                    const entry = entityMap.get(uuid);
                    if (!entry) {
                        continue;
                    }
                    peerState.set(uuid, encodeReplicatedEntity(
                        entry.entity,
                        uuid,
                        entry.entity.components
                            .get(MultiplayerData)?.owner ?? '',
                    ));
                }
                const peerDelta = new Map([...delta].filter(([uuid]) =>
                    interested.has(uuid) && !entering.has(uuid)));
                const peerRemove = new Set([
                    ...remove.filter(uuid => previous.has(uuid)),
                    ...leaving,
                ]);
                const movementUuids = new Set<string>();
                for (const [uuid, entityDelta] of peerDelta) {
                    if (containsMovementState(entityDelta)) {
                        movementUuids.add(uuid);
                    }
                }
                for (const [uuid, encodedEntity] of peerState) {
                    if (encodedEntity.components.some(
                        ([name]) => name === MovementStateComponent.name)) {
                        movementUuids.add(uuid);
                    }
                }
                const peerMovementTimestamps = new Map<string, number>();
                const peerMovementSequences = new Map<string, number>();
                for (const uuid of movementUuids) {
                    peerMovementTimestamps.set(
                        uuid, movementTimestamps.get(uuid) ?? localTime);
                    peerMovementSequences.set(
                        uuid,
                        movementSequences.get(uuid)
                            ?? nextMovementSequence(uuid),
                    );
                }

                const peerChanges: Message = {};
                let peerSend = false;
                if (peerDelta.size > 0) {
                    peerChanges.delta = peerDelta;
                    peerSend = true;
                }
                if (peerState.size > 0) {
                    peerChanges.state = peerState;
                    peerSend = true;
                }
                if (peerMovementTimestamps.size > 0) {
                    peerChanges.movementTimestamps = peerMovementTimestamps;
                    peerChanges.movementSequences = peerMovementSequences;
                }
                if (peerRemove.size > 0) {
                    peerChanges.remove = [...peerRemove];
                    peerSend = true;
                }
                if (ownedUuids.length > 0) {
                    peerChanges.ownedUuids = ownedUuids;
                    peerSend = true;
                }
                const peerChat = outboundChat.filter(c => c.to === 'all' || c.to === peer || c.from === peer);
                if (peerChat.length > 0) {
                    peerChanges.chat = peerChat;
                    peerSend = true;
                }
                interestedEntitiesByPeer.set(peer, interested);
                if (peerSend) {
                    sendMessage(peerChanges, peer);
                }
            }

            if (isAdmin) {
                for (const peer of communicator.peers.current.value) {
                    if (peer !== comms.uuid) {
                        sendInterestManagedChanges(peer);
                    }
                }
            } else if (send) {
                sendMessage(changes);
            }
        }
    });

    function build(world: World) {
        world.addPlugin(DeltaPlugin);
        world.addPhase(MultiplayerPhase);
        world.resources.set(CommunicatorResource, communicator);
        if (!world.resources.has(TimeResource)) {
            world.resources.set(TimeResource, {
                delta_ms: 0,
                delta_s: 0,
                time: wallClockNow(),
                frame: 0,
            });
        }
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }

        deltaMaker.addComponent(MultiplayerData, {
            componentType: t.type({
                owner: t.string,
            })
        });

        world.addSystem(multiplayerSystem);
        world.addSystem(MessageSystem);
        world.addComponent(MultiplayerData);
        world.singletonEntity.components.set(Comms, {
            ownedUuids: new Set<string>(),
            uuid: communicator.uuid,
            admins: new Set<string>(['server']),
            lastEntities: new Map<string, string>(),
            stateRequests: new Map(),
            messages: [],
            initialStateRequested: false,
            outboundChat: [],
        });

        messageSubscription = communicator.messages.subscribe(message => {
            world.emit(MultiplayerMessageEvent, message);
        });
        peerLeaveSubscription = communicator.peers.leave.subscribe(peer => {
            sourceClockOffsets.delete(peer);
            interestedEntitiesByPeer.delete(peer);
            for (const [uuid, movement] of [...latestInboundMovement]) {
                if (movement.source === peer) {
                    latestInboundMovement.delete(uuid);
                }
            }
            for (const [uuid, entity] of [...world.entities]) {
                if (entity.components.get(MultiplayerData)?.owner === peer) {
                    world.entities.delete(uuid);
                    clearMovementLifecycle(uuid);
                }
            }
        });
    }

    return {
        name: 'multiplayer',
        build,
        remove(world) {
            messageSubscription?.unsubscribe();
            messageSubscription = undefined;
            peerLeaveSubscription?.unsubscribe();
            peerLeaveSubscription = undefined;
            world.removeSystem(multiplayerSystem);
            world.removeSystem(MessageSystem);
        },
    }
}

function newChatMessageId(from: string): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    return `${from}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

export function broadcastChat(world: World, chat: { to: string, fromName?: string, text: string }) {
    const comms = world.singletonEntity.components.get(Comms);
    if (!comms || !comms.uuid) {
        return;
    }
    const entry: ChatMessageEntry = {
        id: newChatMessageId(comms.uuid),
        from: comms.uuid,
        fromName: chat.fromName ?? 'Captain',
        to: chat.to,
        text: chat.text,
        time: Date.now(),
    };
    comms.outboundChat ??= [];
    comms.outboundChat.push(entry);
    world.emitNow(ChatMessageEvent, entry);
}

