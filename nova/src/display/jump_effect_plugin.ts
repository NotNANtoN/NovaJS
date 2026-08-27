import { Emit, Entities, UUID } from 'nova_ecs/arg_types';
import { Position } from 'nova_ecs/datatypes/position';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { Query } from 'nova_ecs/query';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import {
    MovementPhysicsComponent,
    MovementStateComponent,
} from 'nova_ecs/plugins/movement_plugin';
import { MULTIPLAYER_INTEREST_RADIUS } from
    'nova_ecs/plugins/multiplayer_plugin';
import { SingletonComponent } from 'nova_ecs/world';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import {
    JumpState,
    JumpStateComponent,
    JUMP_ARRIVAL_MS,
    JUMP_DEPARTURE_SPEED_MULTIPLIER,
    SYSTEM_DEPARTURE_RADIUS,
    distanceFromSystemOrigin,
} from '../nova_plugin/jump_plugin';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin';
import { ShipComponent } from '../nova_plugin/ship_plugin';
import { SoundEvent } from '../nova_plugin/sound_event';
import { AnimationGraphicComponent, ObjectDrawSystem } from
    './animation_graphic_plugin';

const JumpEffectSeenResource = new Resource<
    Map<string, JumpState['phase']>
>('JumpEffectSeen');

const PlayerMovementQuery = new Query([
    PlayerShipSelector,
    MovementStateComponent,
] as const, 'JumpEffectPlayerMovement');

function isNearPlayer(
    movement: { position: { x: number, y: number } },
    players: readonly [
        unknown,
        { position: { x: number, y: number } },
    ][],
): boolean {
    return players.some(([, player]) => {
        return distanceFromSystemOrigin(new Position(
            movement.position.x - player.position.x,
            movement.position.y - player.position.y,
        ))
            <= MULTIPLAYER_INTEREST_RADIUS;
    });
}

function arrivalProgress(
    jump: Pick<JumpState, 'phaseStartedAt' | 'transitionAt'>,
    now: number,
): number {
    const duration = Math.max(
        1,
        jump.transitionAt - jump.phaseStartedAt || JUMP_ARRIVAL_MS,
    );
    return Math.min(
        1,
        Math.max(0, (now - jump.phaseStartedAt) / duration),
    );
}

/**
 * Measures only the speed a ship carries beyond its ordinary top speed, so
 * cruising into a jump shows no streak and the stretch grows purely with the
 * hyperspace boost.
 */
export function departureStretchFactor(
    speed: number,
    maxVelocity: number,
): number {
    const cruiseSpeed = Math.max(0, maxVelocity);
    const boostRange = cruiseSpeed
        * (JUMP_DEPARTURE_SPEED_MULTIPLIER - 1);
    if (boostRange === 0) {
        return 0;
    }
    return Math.max(0, Math.min(1, (speed - cruiseSpeed) / boostRange));
}

function departureAlpha(
    movement: { position: { x: number, y: number } },
): number {
    const distance = distanceFromSystemOrigin(new Position(
        movement.position.x,
        movement.position.y,
    ));
    const fadeStart = SYSTEM_DEPARTURE_RADIUS * 0.85;
    return Math.min(
        1,
        Math.max(
            0,
            (SYSTEM_DEPARTURE_RADIUS - distance)
                / (SYSTEM_DEPARTURE_RADIUS - fadeStart),
        ),
    );
}

function resetGraphic(graphic: {
    container: {
        alpha: number,
        rotation: number,
        scale: { set: (x: number, y?: number) => void },
    },
}): void {
    graphic.container.rotation = 0;
    graphic.container.scale.set(1, 1);
    graphic.container.alpha = 1;
}

function applyJumpGraphic(
    graphic: {
        container: {
            alpha: number,
            rotation: number,
            scale: { set: (x: number, y?: number) => void },
        },
        sprites: Map<string, { pixiSprite: { rotation: number } }>,
    },
    movement: { rotation: { angle: number } },
    jump: JumpState,
    progress: number,
): void {
    const departure = jump.phase !== 'arriving';
    const longitudinal = departure
        ? 1 + progress * 3
        : 4 - progress * 3;
    const transverse = departure
        ? 1 - progress * 0.35
        : 0.65 + progress * 0.35;
    graphic.container.rotation = movement.rotation.angle;
    graphic.container.scale.set(transverse, longitudinal);
    graphic.container.alpha = departure
        ? departureAlpha(movement)
        : progress;
    for (const sprite of graphic.sprites.values()) {
        sprite.pixiSprite.rotation -= movement.rotation.angle;
    }
}

export const JumpEffectSystem = new System({
    name: 'JumpEffectSystem',
    after: [ObjectDrawSystem],
    args: [
        ShipComponent,
        MovementStateComponent,
        MovementPhysicsComponent,
        AnimationGraphicComponent,
        Optional(JumpStateComponent),
        Optional(PlayerShipSelector),
        TimeResource,
        UUID,
        Emit,
        PlayerMovementQuery,
        JumpEffectSeenResource,
    ] as const,
    step(
        _ship,
        movement,
        physics,
        graphic,
        jump,
        playerShip,
        time,
        uuid,
        emit,
        players,
        seen,
    ) {
        if (graphic.managed.disposed) {
            seen.delete(uuid);
            return;
        }
        if (playerShip || !jump) {
            seen.delete(uuid);
            resetGraphic(graphic);
            return;
        }

        const previousPhase = seen.get(uuid);
        if (previousPhase !== jump.phase) {
            seen.set(uuid, jump.phase);
            const startsCharging = jump.phase === 'braking'
                || jump.phase === 'spooling' && previousPhase === undefined;
            if ((startsCharging || jump.phase === 'departing')
                && isNearPlayer(movement, players)) {
                emit(SoundEvent, {
                    id: startsCharging
                        ? 'nova:128' : 'nova:130',
                });
            }
        }

        applyJumpGraphic(
            graphic,
            movement,
            jump,
            jump.phase === 'arriving'
                ? arrivalProgress(jump, time.time)
                : departureStretchFactor(
                    movement.velocity.length,
                    physics.maxVelocity,
                ),
        );
    },
});

const JumpEffectCleanupSystem = new System({
    name: 'JumpEffectCleanupSystem',
    after: [JumpEffectSystem],
    args: [
        SingletonComponent,
        Entities,
        JumpEffectSeenResource,
    ] as const,
    step(_singleton, entities, seen) {
        for (const [uuid, phase] of seen) {
            const jump = entities.get(uuid)?.components
                .get(JumpStateComponent);
            if (!jump || jump.phase !== phase) {
                seen.delete(uuid);
            }
        }
    },
});

export const JumpEffectPlugin: Plugin = {
    name: 'JumpEffectPlugin',
    build(world) {
        world.resources.set(JumpEffectSeenResource, new Map());
        world.addSystem(JumpEffectSystem);
        world.addSystem(JumpEffectCleanupSystem);
    },
    remove(world) {
        world.removeSystem(JumpEffectCleanupSystem);
        world.removeSystem(JumpEffectSystem);
        world.resources.delete(JumpEffectSeenResource);
    },
};
