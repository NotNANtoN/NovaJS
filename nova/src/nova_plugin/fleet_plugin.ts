import * as t from 'io-ts';
import { Entities, Emit, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { System } from 'nova_ecs/system';
import {
    MovementPhysicsComponent,
    MovementState,
    MovementStateComponent,
} from 'nova_ecs/plugins/movement_plugin';
import {
    MultiplayerData,
    replicationPolicies,
} from 'nova_ecs/plugins/multiplayer_plugin';
import { PlatformResource } from './platform_plugin';
import {
    FollowAI,
    NpcFleeComponent,
    NpcPurposeAI,
} from './npc_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { ArmorComponent } from './health_plugin';
import {
    InitiateJumpEvent,
    JumpStateComponent,
} from './jump_plugin';
import { TargetComponent } from './target_component';
import { approachTarget } from './flight_controller';
import {
    formationSlot,
    FormationOffset,
} from './fleet';

const FleetMemberDataCodec = t.type({
    fleetId: t.string,
    leaderUuid: t.string,
    role: t.union([t.literal('leader'), t.literal('escort')]),
    slot: t.number,
});
export type FleetMemberData = t.TypeOf<typeof FleetMemberDataCodec>;

/**
 * Every ship in a fleet carries the same stable fleet id. Leaders point to
 * themselves; escorts point at the leader entity UUID. The component is server
 * authoritative because membership and station commands are gameplay state.
 */
export const FleetMemberComponent = new Component<FleetMemberData>(
    'FleetMemberComponent',
);
replicationPolicies.register(FleetMemberComponent, {
    codec: FleetMemberDataCodec,
    authority: 'server',
});

const inheritedTargets = new WeakMap<Entity, string>();

function isDestroyed(entity: Entity): boolean {
    if (entity.components.has(DestructionStartedComponent)) {
        return true;
    }
    const armor = entity.components.get(ArmorComponent);
    return armor !== undefined && armor.current <= 0;
}

function leaderFor(
    member: FleetMemberData,
    entities: ReadonlyMap<string, Entity>,
): Entity | undefined {
    const leader = entities.get(member.leaderUuid);
    const leaderMember = leader?.components.get(FleetMemberComponent);
    if (!leader || !leaderMember
        || leaderMember.role !== 'leader'
        || leaderMember.fleetId !== member.fleetId
        || isDestroyed(leader)) {
        return undefined;
    }
    return leader;
}

function clearInheritedTarget(
    entity: Entity,
    target: { target: string | undefined } | undefined,
): void {
    const inherited = inheritedTargets.get(entity);
    if (inherited !== undefined && target?.target === inherited) {
        target.target = undefined;
    }
    inheritedTargets.delete(entity);
}

export function worldFormationPosition(
    leader: MovementState,
    offset: FormationOffset,
): Position {
    const forward = leader.rotation.getUnitVector();
    const right = new Vector(-forward.y, forward.x);
    // formationSlot measures +y as distance *behind* the leader, so a station
    // is found by going backwards along the leader's heading. Adding it along
    // forward would sit the escorts ahead of the ship they are escorting.
    const worldOffset = right.scale(offset.x).add(forward.scale(-offset.y));
    return new Position(
        leader.position.x + worldOffset.x,
        leader.position.y + worldOffset.y,
    );
}

/**
 * Copy a leader's selected target to idle escorts. The target selection itself
 * remains in NpcPlugin, so government relations and MaxOdds continue to be
 * decided by the normal authoritative NPC AI before the fleet coordinates it.
 */
export const FleetDefenseSystem = new System({
    name: 'FleetDefense',
    after: [NpcPurposeAI],
    args: [
        FleetMemberComponent,
        TargetComponent,
        Entities,
        GetEntity,
        MultiplayerData,
        PlatformResource,
    ] as const,
    step(member, target, entities, entity, multiplayer, platform) {
        if (platform !== 'node' || multiplayer.owner !== 'server'
            || member.role !== 'escort') {
            return;
        }
        const leader = leaderFor(member, entities);
        if (!leader) {
            entity.components.delete(FleetMemberComponent);
            clearInheritedTarget(entity, target);
            return;
        }
        if (leader.components.has(NpcFleeComponent)
            || leader.components.has(JumpStateComponent)) {
            clearInheritedTarget(entity, target);
            return;
        }

        const leaderTarget = leader.components.get(TargetComponent)?.target;
        if (leaderTarget && entities.has(leaderTarget)) {
            target.target = leaderTarget;
            inheritedTargets.set(entity, leaderTarget);
        } else {
            clearInheritedTarget(entity, target);
        }
    },
});

/**
 * Hold an escort's formation slot whenever it is not fighting. A leader's
 * retreat or jump takes priority over combat so the group does not split while
 * leaving. FollowAI remains responsible for manoeuvring toward a hostile
 * target copied from the leader.
 */
export const FleetCohesionSystem = new System({
    name: 'FleetCohesion',
    after: [FollowAI],
    args: [
        FleetMemberComponent,
        MovementStateComponent,
        MovementPhysicsComponent,
        Entities,
        GetEntity,
        Emit,
        MultiplayerData,
        PlatformResource,
        Optional(TargetComponent),
        Optional(JumpStateComponent),
        Optional(NpcFleeComponent),
    ] as const,
    step(member, movement, physics, entities, entity, emit, multiplayer,
        platform, target, jump, escortFlee) {
        if (platform !== 'node' || multiplayer.owner !== 'server'
            || member.role !== 'escort') {
            return;
        }

        const leader = leaderFor(member, entities);
        if (!leader) {
            entity.components.delete(FleetMemberComponent);
            clearInheritedTarget(entity, target);
            return;
        }
        const leaderMovement = leader.components.get(MovementStateComponent);
        if (!leaderMovement) {
            clearInheritedTarget(entity, target);
            movement.accelerating = 0;
            movement.turnTo = null;
            movement.turnBack = false;
            return;
        }

        const leaderJump = leader.components.get(JumpStateComponent);
        if (leaderJump) {
            clearInheritedTarget(entity, target);
            if (!jump) {
                emit(InitiateJumpEvent, { to: leaderJump.to }, [entity]);
            }
            return;
        }
        if (jump) {
            return;
        }
        const leaderFlee = leader.components.has(NpcFleeComponent);
        if (leaderFlee) {
            if (target) {
                target.target = undefined;
            }
            inheritedTargets.delete(entity);
        } else if (escortFlee || target?.target) {
            // FollowAI has already selected a combat target. Do not overwrite
            // that manoeuvre with a station-keeping command.
            return;
        }

        const offset = formationSlot(member.slot);
        const command = approachTarget(
            movement,
            {
                position: worldFormationPosition(leaderMovement, offset),
                velocity: leaderMovement.velocity,
            },
            physics,
            { standoff: 0, tolerance: 25 },
        );
        movement.turnTo = command.turnTo;
        movement.accelerating = command.accelerating;
        movement.turnBack = command.turnBack;
        if (command.turnTo === null && !command.turnBack) {
            movement.turning = 0;
        }
    },
});

/**
 * InitiateJumpEvent is the existing authoritative jump boundary. Relaying it
 * from a leader keeps all escorts on the same departure path without creating
 * a second jump implementation here.
 */
export const FleetJumpRelaySystem = new System({
    name: 'FleetJumpRelay',
    events: [InitiateJumpEvent],
    args: [
        InitiateJumpEvent,
        FleetMemberComponent,
        Entities,
        UUID,
        Emit,
        MultiplayerData,
        PlatformResource,
    ] as const,
    step({ to }, member, entities, leaderUuid, emit, _multiplayer, platform) {
        if (platform !== 'node' || member.role !== 'leader') {
            return;
        }
        for (const [escortUuid, escort] of entities) {
            const escortMember = escort.components.get(FleetMemberComponent);
            if (!escortMember || escortMember.role !== 'escort'
                || escortMember.fleetId !== member.fleetId
                || escortMember.leaderUuid !== leaderUuid) {
                continue;
            }
            emit(InitiateJumpEvent, { to }, [escortUuid]);
        }
    },
});

export const FleetPlugin: Plugin = {
    name: 'FleetPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        world.addComponent(FleetMemberComponent);
        deltaMaker.addComponent(FleetMemberComponent, {
            componentType: FleetMemberDataCodec,
        });
        world.addSystem(FleetDefenseSystem);
        world.addSystem(FleetCohesionSystem);
        world.addSystem(FleetJumpRelaySystem);
    },
    remove(world) {
        world.removeSystem(FleetDefenseSystem);
        world.removeSystem(FleetCohesionSystem);
        world.removeSystem(FleetJumpRelaySystem);
    },
};
