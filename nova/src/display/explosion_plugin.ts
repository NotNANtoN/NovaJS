import { ExplosionData } from "novadatainterface/ExplosionData";
import { ShipData } from "novadatainterface/ShipData";
import { Emit, Entities, GetEntity, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { Angle } from "nova_ecs/datatypes/angle";
import { Position } from "nova_ecs/datatypes/position";
import { Vector } from "nova_ecs/datatypes/vector";
import { Entity } from "nova_ecs/entity";
import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { Resource } from "nova_ecs/resource";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { System } from "nova_ecs/system";
import { SingletonComponent } from "nova_ecs/world";
import { v4 } from "uuid";
import { ExplosionDataComponent } from "../nova_plugin/animation_plugin";
import { GameDataResource } from "../nova_plugin/game_data_resource";
import { ProjectileDataComponent } from "../nova_plugin/projectile_data";
import { ProjectileExplodeEvent } from "../nova_plugin/projectile_plugin";
import { SoundEvent } from "../nova_plugin/sound_event";
import { AnimationGraphicComponent } from "./animation_graphic_plugin";
import {
    DisabledComponent,
    PlayerDeathComponent,
    PlayerDestructionCompleteEvent,
} from "../nova_plugin/death_plugin";
import { DestructionStartedComponent } from "../nova_plugin/destruction_state";
import { ShipComponent, ShipDataComponent } from "../nova_plugin/ship_plugin";
import { EntityBudgetResource, reserveEntity } from "../nova_plugin/entity_budget";
import { framesToMilliseconds } from "novaparse/src/parsers/Constants";
import {
    advanceExplosionTiming,
    ExplosionTimingState,
} from "./explosion_timing";
import {
    completeDestructionVisual,
    registerDestructionVisual,
} from "./destruction_visual_state";


interface ExplosionStateData extends ExplosionTimingState {
    completionObservedAt?: number;
}
const ExplosionState =
    new Component<ExplosionStateData>('ExplosionState');
const DestructionCompletionTarget =
    new Component<string>('DestructionCompletionTarget');
const ActiveDestructionVisuals =
    new Resource<Map<string, number>>('ActiveDestructionVisuals');

export const ExplosionSystem = new System({
    name: 'ExplosionSystem',
    args: [AnimationGraphicComponent, ExplosionDataComponent,
        ExplosionState, TimeResource, Entities, UUID, Emit,
        ActiveDestructionVisuals,
        Optional(DestructionCompletionTarget)] as const,
    step(graphic, explosionData, explosionState, time, entities, uuid, emit,
        activeDestructionVisuals, completionTarget) {
        const starting = explosionState.startTime === undefined;
        const timing = advanceExplosionTiming(
            explosionState,
            time.time,
            Math.max(
                0,
                ...Object.values(explosionData.animation.images)
                    .map(image => image.frames.normal.length),
            ),
            explosionData.rate,
        );
        if (starting) {
            if (explosionData.sound) {
                emit(SoundEvent, { id: explosionData.sound })
            }
        }

        graphic.progress = timing.progress;

        if (timing.done && explosionState.completionObservedAt === undefined) {
            explosionState.completionObservedAt = time.time;
            return;
        }
        if (timing.done) {
            entities.delete(uuid);
            if (completionTarget && completeDestructionVisual(
                activeDestructionVisuals,
                completionTarget,
            )) {
                emit(PlayerDestructionCompleteEvent, {
                    ...time,
                    playerUuid: completionTarget,
                }, [completionTarget]);
            }
        }
    }
});

const SecondaryExplosionComponent = new Component<{
    explosion: ExplosionData,
    lastTime?: number,
    period: number,
    radius?: number,
}>('SecondaryExplosion');

function randomPointInCircle(r: number): Vector {
    const r2 = r ** 2;
    while (true) {
        const pos = new Position(
            (Math.random() - 0.5) * 2 * r,
            (Math.random() - 0.5) * 2 * r,
        );
        if (pos.lengthSquared <= r2) {
            return pos;
        }
    }
}

const SecondaryExplosionSystem = new System({
    name: 'SecondaryExplosion',
    args: [SecondaryExplosionComponent, TimeResource, Entities,
        MovementStateComponent, EntityBudgetResource,
        ActiveDestructionVisuals,
        Optional(DestructionCompletionTarget)] as const,
    step(explosion, time, entities, { position }, budget,
        activeDestructionVisuals, completionTarget) {
        if (!explosion.lastTime) {
            explosion.lastTime = 0;
        }
        if (explosion.lastTime + explosion.period > time.time) {
            return;
        }

        explosion.lastTime = time.time;

        // TODO: Fix these types in position.ts
        const pos = position.add(
            randomPointInCircle(explosion.radius ?? 80)) as Position;
        const child = makeExplosion({
            ...explosion.explosion,
            sound: null,
        }, pos, undefined, completionTarget);
        if (reserveEntity(budget, child, 'explosion')) {
            entities.set(v4(), child);
            if (completionTarget) {
                registerDestructionVisual(
                    activeDestructionVisuals,
                    completionTarget,
                );
            }
        }
    }
});

const ProjectileExplosionSystem = new System({
    name: 'ProjectileExplosionSystem',
    events: [ProjectileExplodeEvent],
    args: [ProjectileDataComponent, MovementStateComponent, GameDataResource,
        Entities, EntityBudgetResource] as const,
    step(projectileData, movement, gameData, entities, budget) {
        const primary = projectileData.primaryExplosion;
        if (!primary) {
            return;
        }

        const primaryExplosionData = gameData.data.Explosion.getCached(primary);
        if (!primaryExplosionData) {
            return;
        }

        const secondary = projectileData.secondaryExplosion;
        let secondaryExplosionData: ExplosionData | undefined;
        if (secondary) {
            secondaryExplosionData =
                gameData.data.Explosion.getCached(secondary);
        }

        const explosion = makeExplosion(primaryExplosionData,
            movement.position, secondaryExplosionData);
        if (reserveEntity(budget, explosion, 'explosion')) {
            entities.set(v4(), explosion);
        }
    }
});

/**
 * A ship whose destruction has been seen, so its final explosion can still be
 * placed after the server has removed the wreck. The position is refreshed
 * while the ship lives, because it keeps drifting as it comes apart.
 */
const DyingShips = new Resource<Map<string, {
    ship: ShipData,
    position: Position,
}>>('DyingShips');
/** Local marker: this ship's final explosion has already been played. */
const FinalExplosionShown = new Component<true>('FinalExplosionShown');

function playFinalExplosion(
    ship: ShipData,
    position: Position,
    shipUuid: string,
    gameData: { data: { Explosion: { getCached(id: string): ExplosionData | undefined } } },
    entities: { set(uuid: string, entity: Entity): unknown },
    budget: Parameters<typeof reserveEntity>[0],
    activeDestructionVisuals: Map<string, number>,
): boolean {
    const explosionData = ship.finalExplosion
        ? gameData.data.Explosion.getCached(ship.finalExplosion)
        : undefined;
    if (!explosionData) {
        return false;
    }
    const explosion = makeExplosion(
        explosionData,
        position,
        ship.largeExplosion ? explosionData : undefined,
        shipUuid);
    if (!reserveEntity(budget, explosion, 'explosion')) {
        return false;
    }
    entities.set(v4(), explosion);
    registerDestructionVisual(activeDestructionVisuals, shipUuid);
    return true;
}

export const TrackDyingShips = new System({
    name: 'TrackDyingShips',
    args: [ShipDataComponent, DestructionStartedComponent,
        MovementStateComponent, UUID, DyingShips,
        Optional(FinalExplosionShown)] as const,
    step(ship, _destructionStarted, movement, uuid, dying, shown) {
        if (shown) {
            return;
        }
        dying.set(uuid, {
            ship,
            position: Position.fromVectorLike(movement.position),
        });
    }
});

/**
 * The pilot's own wreck is not removed, so its death is announced by the
 * replicated death marker rather than by the entity disappearing.
 */
const PlayerFinalExplosionSystem = new System({
    name: 'PlayerFinalExplosionSystem',
    args: [ShipDataComponent, PlayerDeathComponent, MovementStateComponent,
        GameDataResource, Entities, EntityBudgetResource, UUID, GetEntity,
        Emit, TimeResource, ActiveDestructionVisuals, DyingShips,
        Optional(FinalExplosionShown)] as const,
    step(ship, _death, movement, gameData, entities, budget, shipUuid, entity,
        emit, time, activeDestructionVisuals, dying, shown) {
        if (shown) {
            return;
        }
        entity.components.set(FinalExplosionShown, true);
        dying.delete(shipUuid);
        if (!playFinalExplosion(ship, Position.fromVectorLike(movement.position),
            shipUuid, gameData, entities, budget, activeDestructionVisuals)) {
            emit(PlayerDestructionCompleteEvent, {
                ...time,
                playerUuid: shipUuid,
            }, [shipUuid]);
        }
    }
});

/**
 * Any other wreck is removed by the server once it is destroyed, and that
 * removal is the only notice a client gets that the ship is gone for good.
 */
export const ShipFinalExplosionSystem = new System({
    name: 'ShipFinalExplosionSystem',
    args: [Entities, DyingShips, GameDataResource, EntityBudgetResource,
        ActiveDestructionVisuals, SingletonComponent] as const,
    step(entities, dying, gameData, budget, activeDestructionVisuals) {
        for (const [uuid, entry] of [...dying]) {
            if (entities.has(uuid)) {
                continue;
            }
            dying.delete(uuid);
            playFinalExplosion(entry.ship, entry.position, uuid, gameData,
                entities, budget, activeDestructionVisuals);
        }
    }
});

// TODO: Sample collisions in the convex hull of the ship
/**
 * Damage and death are resolved on the server, so `ZeroArmorEvent` and
 * `DeathEvent` never reach a browser. The dying flicker is therefore driven by
 * the replicated destruction marker instead: its arrival is what tells a client
 * that a ship has begun to come apart.
 */
const ShipSecondaryExplosionSystem = new System({
    name: 'ShipSecondaryExplosionSystem',
    args: [ShipDataComponent, DestructionStartedComponent, GetEntity,
        Optional(DisabledComponent), GameDataResource] as const,
    step(ship, _destructionStarted, {components}, disabled, gameData) {
        if (ship.initialExplosion == null || disabled
            || components.has(SecondaryExplosionComponent)) {
            return;
        }

        const explosion =
            gameData.data.Explosion.getCached(ship.initialExplosion);
        if (!explosion) {
            return;
        }

        components.set(SecondaryExplosionComponent, {
            explosion,
            period: framesToMilliseconds(90),
        });
    }
});

const ShipSecondaryExplosionDoneSystem = new System({
    name: 'ShipSecondaryExplosionDoneSystem',
    args: [GetEntity, FinalExplosionShown] as const,
    step(entity) {
        entity.components.delete(SecondaryExplosionComponent);
    }
});

export function makeExplosion(explosionData: ExplosionData, position: Position,
    secondaryExplosionData?: ExplosionData, completionTarget?: string) {
    const explosion = new Entity()
        .addComponent(ExplosionDataComponent, explosionData)
        .addComponent(ExplosionState, {})
        .addComponent(MovementStateComponent, {
            position,
            accelerating: 0,
            rotation: new Angle(0),
            turnBack: false,
            turning: 0,
            velocity: new Vector(0, 0),
        });
    if (secondaryExplosionData) {
        explosion.addComponent(SecondaryExplosionComponent, {
            explosion: secondaryExplosionData,
            period: framesToMilliseconds(30),
        });
    }
    if (completionTarget) {
        explosion.addComponent(
            DestructionCompletionTarget, completionTarget);
    }
    return explosion;
}

export const ExplosionPlugin: Plugin = {
    name: 'ExplosionPlugin',
    build(world) {
        world.resources.set(ActiveDestructionVisuals, new Map());
        world.resources.set(DyingShips, new Map());
        world.addComponent(FinalExplosionShown);
        world.addSystem(ExplosionSystem);
        world.addSystem(ProjectileExplosionSystem);
        world.addSystem(SecondaryExplosionSystem);
        world.addSystem(TrackDyingShips);
        world.addSystem(PlayerFinalExplosionSystem);
        world.addSystem(ShipFinalExplosionSystem);
        world.addSystem(ShipSecondaryExplosionSystem);
        world.addSystem(ShipSecondaryExplosionDoneSystem);
    },
    remove(world) {
        world.removeSystem(ExplosionSystem);
        world.removeSystem(ProjectileExplosionSystem);
        world.removeSystem(SecondaryExplosionSystem);
        world.removeSystem(TrackDyingShips);
        world.removeSystem(PlayerFinalExplosionSystem);
        world.removeSystem(ShipFinalExplosionSystem);
        world.removeSystem(ShipSecondaryExplosionSystem);
        world.removeSystem(ShipSecondaryExplosionDoneSystem);
        world.resources.delete(ActiveDestructionVisuals);
        world.resources.delete(DyingShips);
    }
}
