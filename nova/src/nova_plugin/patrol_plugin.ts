import { Entities } from 'nova_ecs/arg_types';
import { Position } from 'nova_ecs/datatypes/position';
import { Component } from 'nova_ecs/component';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import {
    MovementPhysicsComponent,
    MovementStateComponent,
} from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { System } from 'nova_ecs/system';
import {
    DisabledComponent,
} from './death_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { ArmorComponent } from './health_plugin';
import { FollowAI, NpcFleeComponent } from './npc_plugin';
import { NpcCombatRoleComponent } from './npc_components';
import { PlatformResource } from './platform_plugin';
import { shouldYieldToCombat } from './npc_traffic';
import { approachTarget } from './flight_controller';
import { JumpStateComponent } from './jump_plugin';
import {
    nextPatrolWaypoint,
    PatrolDirection,
    PatrolPoint,
} from './patrol';
import { TargetComponent } from './target_component';

/**
 * This marker is authoritative server state. It is intentionally not
 * replicated: clients receive the movement authored by the server.
 */
export interface PatrolState {
    guardPost: PatrolPoint;
    radius: number;
    waypoint?: [number, number];
    direction?: PatrolDirection;
}

export const PatrolComponent =
    new Component<PatrolState>('PatrolComponent');

/** A patrol's ring is a presentation choice, not a documented retail value. */
export const DEFAULT_PATROL_RADIUS = 900;
/** Enough slack to keep a circuit from chattering at each waypoint. */
export const PATROL_WAYPOINT_TOLERANCE = 80;
const PATROL_WAYPOINT_SPEED_TOLERANCE = 20;

function setNextWaypoint(
    patrol: PatrolState,
    movement: {
        position: Position,
        rotation: { angle: number },
    },
): void {
    const next = nextPatrolWaypoint(
        patrol.guardPost,
        patrol.radius,
        [movement.position.x, movement.position.y],
        movement.rotation.angle,
        { direction: patrol.direction },
    );
    patrol.waypoint = next.position;
    patrol.direction = next.direction;
}

function hasReachedWaypoint(
    patrol: PatrolState,
    movement: {
        position: Position,
        velocity: { length: number },
    },
): boolean {
    if (!patrol.waypoint) {
        return false;
    }
    const dx = movement.position.x - patrol.waypoint[0];
    const dy = movement.position.y - patrol.waypoint[1];
    return Math.hypot(dx, dy) <= PATROL_WAYPOINT_TOLERANCE
        && movement.velocity.length <= PATROL_WAYPOINT_SPEED_TOLERANCE;
}

/**
 * Keep a marked military NPC moving between points on its guard ring.
 * FollowAI runs first, so a live combat target has already had a chance to
 * author movement before this system either yields or takes station.
 */
export const PatrolFlightSystem = new System({
    name: 'PatrolFlight',
    after: [FollowAI],
    args: [
        PatrolComponent,
        NpcCombatRoleComponent,
        MovementStateComponent,
        MovementPhysicsComponent,
        Entities,
        MultiplayerData,
        PlatformResource,
        Optional(TargetComponent),
        Optional(NpcFleeComponent),
        Optional(JumpStateComponent),
        Optional(DisabledComponent),
        Optional(DestructionStartedComponent),
        Optional(ArmorComponent),
    ] as const,
    step(
        patrol,
        combatRole,
        movement,
        physics,
        entities,
        multiplayer,
        platform,
        target,
        fleeing,
        jump,
        disabled,
        destructionStarted,
        armor,
    ) {
        if (combatRole !== 'military'
            || platform !== 'node'
            || multiplayer.owner !== 'server') {
            return;
        }

        const hasLiveTarget = target?.target !== undefined
            && entities.has(target.target);
        const destroyed = Boolean(
            disabled
            || destructionStarted
            || armor && armor.current <= 0,
        );
        if (shouldYieldToCombat(
            hasLiveTarget,
            fleeing !== undefined,
            jump !== undefined,
            destroyed,
        )) {
            return;
        }

        if (!patrol.waypoint || hasReachedWaypoint(patrol, movement)) {
            setNextWaypoint(patrol, movement);
        }
        if (!patrol.waypoint) {
            return;
        }

        const command = approachTarget(
            movement,
            { position: new Position(
                patrol.waypoint[0], patrol.waypoint[1]) },
            physics,
            {
                standoff: 0,
                tolerance: PATROL_WAYPOINT_TOLERANCE,
                caution: 0.85,
            },
        );
        movement.turnTo = command.turnTo;
        movement.accelerating = command.accelerating;
        movement.turnBack = command.turnBack;
    },
});

export const PatrolPlugin: Plugin = {
    name: 'PatrolPlugin',
    build(world) {
        world.addComponent(PatrolComponent);
        world.addSystem(PatrolFlightSystem);
    },
    remove(world) {
        world.removeSystem(PatrolFlightSystem);
    },
};
