import * as t from 'io-ts';
import { Entities, GetWorld } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MovementState, MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import {
    Communicator, CommunicatorResource, InboundMultiplayerPhase, MultiplayerData,
    MultiplayerPhase, replicationPolicies, ServerClockOffsetResource,
} from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from 'nova_ecs/world';
import { PlatformResource } from './platform_plugin';
import { PlayerDeathComponent } from './death_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { JumpStateComponent } from './jump_plugin';
import { PlayerStateComponent } from './player_state';
import { ShipComponent } from './ship_plugin';
import { SystemIdResource } from './system_id_resource';

export const EXTERNAL_IMPULSE_LIFETIME_MS = 2_000;
const Impulse = t.type({
    sequence: t.number,
    owner: t.string,
    issuedAt: t.number,
    expiresAt: t.number,
    x: t.number,
    y: t.number,
});
export const ExternalImpulse = t.type({
    sequence: t.number,
    impulses: t.array(Impulse),
});
export const ExternalImpulseComponent =
    new Component<t.TypeOf<typeof ExternalImpulse>>('ExternalImpulse');
replicationPolicies.register(ExternalImpulseComponent, {
    codec: ExternalImpulse,
    authority: 'server',
});

/** Called only by server gameplay, with its current movement draft. */
export function authorExternalImpulse(
    entity: Entity, movement: MovementState, owner: string,
    now: number, x: number, y: number,
): void {
    const previous = entity.components.get(ExternalImpulseComponent);
    const sequence = (previous?.sequence ?? 0) + 1;
    // Keep every live entry, not merely the last collision in a network tick.
    entity.components.set(ExternalImpulseComponent, {
        sequence,
        impulses: [
            ...(previous?.impulses ?? [])
                .filter(impulse => impulse.expiresAt > now)
                .map(impulse => ({ ...impulse })),
            { sequence, owner, issuedAt: now,
                expiresAt: now + EXTERNAL_IMPULSE_LIFETIME_MS, x, y },
        ],
    });
    movement.velocity = movement.velocity.add(new Vector(x, y));
}

interface Cursor {
    entity: Entity;
    owner: string;
    sequence: number;
    boundary: string;
    blocked: boolean;
    acceptAfter: number;
}
interface Reception {
    cursors: Map<string, Cursor>;
    connectedAt: number;
    onConnectionChange: () => void;
    communicator?: Communicator;
    unsubscribe?: () => void;
}
const ReceptionResource = new Resource<Reception>('ExternalImpulseReception');

export const ExternalImpulseSystem = new System({
    name: 'ExternalImpulseSystem',
    after: [InboundMultiplayerPhase],
    before: [MultiplayerPhase],
    args: [SingletonComponent, Entities, PlatformResource, TimeResource,
        ReceptionResource, Optional(CommunicatorResource),
        Optional(ServerClockOffsetResource), GetWorld] as const,
    step(_, entities, platform, time, reception, communicator, clock, world) {
        if (platform !== 'browser' || !communicator) return;
        // System worlds install multiplayer after AsteroidPlugin. Bind lazily,
        // and observe disconnects even while a paused world is not stepping.
        if (reception.communicator !== communicator) {
            reception.unsubscribe?.();
            reception.communicator = communicator;
            const subscription = communicator.connected.subscribe(
                reception.onConnectionChange);
            reception.unsubscribe = () => subscription.unsubscribe();
        }
        if (!communicator.connected.value || !communicator.uuid) return;
        const now = time.time - (clock?.offset ?? 0);
        const connectedAt = reception.connectedAt - (clock?.offset ?? 0);
        for (const id of reception.cursors.keys()) {
            if (!entities.has(id)) reception.cursors.delete(id);
        }
        for (const [id, entity] of entities) {
            const owner = entity.components.get(MultiplayerData)?.owner;
            const movement = entity.components.get(MovementStateComponent);
            if (!owner || !movement) continue;
            const state = entity.components.get(ExternalImpulseComponent);
            const cursor = reception.cursors.get(id);
            const player = entity.components.get(PlayerStateComponent);
            const death = entity.components.get(PlayerDeathComponent);
            // Jump flight owns velocity in every phase, including braking and
            // spooling. A cancelled jump also needs a fresh movement baseline.
            const blocked = entity.components.has(PlayerDeathComponent)
                || entity.components.has(DestructionStartedComponent)
                || entity.components.has(JumpStateComponent);
            // Store primitives, never component/draft identity. Respawn and
            // ship replacement can reuse both the entity and movement object.
            const boundary = JSON.stringify([
                entity.components.get(ShipComponent)?.id,
                player?.shipId, player?.currentSystem, world.resources.get(SystemIdResource),
                player?.diedAt, death?.visualFallbackAt,
            ]);
            // Full-state creation/re-entry and ownership handoff already carry
            // a movement baseline. Never add its historical impulse backlog.
            if (!cursor || cursor.entity !== entity || cursor.owner !== owner) {
                reception.cursors.set(id, {
                    entity, owner, sequence: state?.sequence ?? 0,
                    boundary, blocked, acceptAfter: now,
                });
                continue;
            }
            if (blocked || cursor.blocked || cursor.boundary !== boundary) {
                cursor.sequence = Math.max(cursor.sequence, state?.sequence ?? 0);
                cursor.acceptAfter = Math.max(cursor.acceptAfter, now);
                cursor.boundary = boundary;
                cursor.blocked = blocked;
                continue;
            }
            if (!state) continue;
            for (const impulse of state.impulses) {
                if (impulse.sequence <= cursor.sequence) continue;
                // Clock-offset smoothing can briefly put a fresh impulse ahead
                // of the browser's server-time estimate. Defer, don't lose it.
                if (impulse.issuedAt > now) break;
                if (owner === communicator.uuid && impulse.owner === owner
                    && impulse.issuedAt > Math.max(connectedAt, cursor.acceptAfter)
                    && now < impulse.expiresAt) {
                    movement.velocity = movement.velocity.add(
                        new Vector(impulse.x, impulse.y));
                }
                cursor.sequence = impulse.sequence;
            }
        }
    },
});

export const ExternalImpulsePlugin: Plugin = {
    name: 'ExternalImpulsePlugin',
    build(world) {
        world.addComponent(ExternalImpulseComponent);
        const delta = world.resources.get(DeltaResource);
        if (!delta) throw new Error('Expected delta maker for external impulses');
        // Whole queue snapshots make skipped/coalesced network updates safe;
        // array-index patches would require every intermediate queue version.
        delta.addComponent(ExternalImpulseComponent, {
            componentType: ExternalImpulse,
            deltaType: ExternalImpulse,
            getDelta: (_previous, next) => next,
            applyDelta: (_previous, next) => next,
        });
        const reception: Reception = {
            cursors: new Map(),
            connectedAt: world.resources.get(TimeResource)?.time ?? 0,
            onConnectionChange: () => {
                // This subscription outlives a step (and may fire while paused).
                // Fetch current resources instead of retaining tick-local drafts.
                const current = world.resources.get(ReceptionResource);
                if (!current) return;
                current.cursors.clear();
                current.connectedAt = world.resources.get(TimeResource)?.time ?? 0;
            },
        };

        world.resources.set(ReceptionResource, reception);
        world.addSystem(ExternalImpulseSystem);
    },
    remove(world) {
        world.resources.get(ReceptionResource)?.unsubscribe?.();
        world.removeSystem(ExternalImpulseSystem);
        world.resources.delete(ReceptionResource);
    },
};
