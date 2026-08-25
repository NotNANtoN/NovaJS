import { ExplosionData } from "novadatainterface/ExplosionData";
import { Emit, Entities, GetEntity, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { Angle } from "nova_ecs/datatypes/angle";
import { Position } from "nova_ecs/datatypes/position";
import { Vector } from "nova_ecs/datatypes/vector";
import { Entity } from "nova_ecs/entity";
import { Plugin } from "nova_ecs/plugin";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { System } from "nova_ecs/system";
import { v4 } from "uuid";
import { ExplosionDataComponent } from "../nova_plugin/animation_plugin";
import { GameDataResource } from "../nova_plugin/game_data_resource";
import { ProjectileDataComponent } from "../nova_plugin/projectile_data";
import { ProjectileExplodeEvent } from "../nova_plugin/projectile_plugin";
import { SoundEvent } from "../nova_plugin/sound_event";
import { AnimationGraphicComponent } from "./animation_graphic_plugin";
import { DeathEvent, PlayerDeathSystem, ZeroArmorEvent } from "../nova_plugin/death_plugin";
import { ShipComponent, ShipDataComponent } from "../nova_plugin/ship_plugin";
import { DeathAISystem } from "../nova_plugin/npc_plugin";
import { EntityBudgetResource, reserveEntity } from "../nova_plugin/entity_budget";
import { framesToMilliseconds } from "novaparse/src/parsers/Constants";
import {
    advanceExplosionTiming,
    ExplosionTimingState,
} from "./explosion_timing";


const ExplosionState =
    new Component<ExplosionTimingState>('ExplosionState');

export const ExplosionSystem = new System({
    name: 'ExplosionSystem',
    args: [AnimationGraphicComponent, ExplosionDataComponent,
        ExplosionState, TimeResource, Entities, UUID, Emit] as const,
    step(graphic, explosionData, explosionState, time, entities, uuid, emit) {
        const starting = explosionState.startTime === undefined;
        const timing = advanceExplosionTiming(
            explosionState,
            time.time,
            Math.max(0, ...[...graphic.sprites.values()].map(s => s.frames)),
            explosionData.rate,
        );
        if (starting) {
            if (explosionData.sound) {
                emit(SoundEvent, { id: explosionData.sound })
            }
        }

        graphic.progress = timing.progress;

        if (timing.done) {
            entities.delete(uuid);
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
        MovementStateComponent, EntityBudgetResource] as const,
    step(explosion, time, entities, { position }, budget) {
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
        }, pos);
        if (reserveEntity(budget, child, 'explosion')) {
            entities.set(v4(), child);
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

const ShipFinalExplosionSystem = new System({
    name: 'ShipFinalExplosionSystem',
    events: [DeathEvent],
    before: [PlayerDeathSystem, DeathAISystem],
    args: [ShipDataComponent, GameDataResource, MovementStateComponent,
        Entities, EntityBudgetResource] as const,
    step(ship, gameData, movement, entities, budget) {
        if (!ship.finalExplosion) {
            return;
        }
        const explosionData =
            gameData.data.Explosion.getCached(ship.finalExplosion);

        if (!explosionData) {
            return;
        }
        let largeExplosion: ExplosionData | undefined;
        if (ship.largeExplosion) {
            largeExplosion = explosionData;
        }
        const explosion = makeExplosion(
            explosionData,
            Position.fromVectorLike(movement.position),
            largeExplosion);
        if (reserveEntity(budget, explosion, 'explosion')) {
            entities.set(v4(), explosion);
        }
    }
});

// TODO: Sample collisions in the convex hull of the ship
const ShipSecondaryExplosionSystem = new System({
    name: 'ShipSecondaryExplosionSystem',
    events: [ZeroArmorEvent],
    args: [ShipDataComponent, GetEntity, GameDataResource] as const,
    step(ship, {components}, gameData) {
        if (ship.initialExplosion == null) {
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
    args: [GetEntity] as const,
    events: [DeathEvent],
    step(entity) {
        entity.components.delete(SecondaryExplosionComponent);
    }
});

export function makeExplosion(explosionData: ExplosionData, position: Position,
    secondaryExplosionData?: ExplosionData) {
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
    return explosion;
}

export const ExplosionPlugin: Plugin = {
    name: 'ExplosionPlugin',
    build(world) {
        world.addSystem(ExplosionSystem);
        world.addSystem(ProjectileExplosionSystem);
        world.addSystem(SecondaryExplosionSystem);
        world.addSystem(ShipFinalExplosionSystem);
        world.addSystem(ShipSecondaryExplosionSystem);
        world.addSystem(ShipSecondaryExplosionDoneSystem);
    },
    remove(world) {
        world.removeSystem(ExplosionSystem);
        world.removeSystem(ProjectileExplosionSystem);
        world.removeSystem(SecondaryExplosionSystem);
        world.removeSystem(ShipFinalExplosionSystem);
        world.removeSystem(ShipSecondaryExplosionSystem);
        world.removeSystem(ShipSecondaryExplosionDoneSystem);
    }
}
