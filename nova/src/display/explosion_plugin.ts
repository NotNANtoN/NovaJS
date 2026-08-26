import { ExplosionData } from "novadatainterface/ExplosionData";
import { ShipData } from "novadatainterface/ShipData";
import { WeaponDamage } from "novadatainterface/WeaponData";
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
import * as SAT from "sat";
import { v4 } from "uuid";
import { ExplosionDataComponent } from "../nova_plugin/animation_plugin";
import { GameDataResource } from "../nova_plugin/game_data_resource";
import { ProjectileDataComponent } from "../nova_plugin/projectile_data";
import { ProjectileExplodeEvent } from "../nova_plugin/projectile_plugin";
import { SoundEvent } from "../nova_plugin/sound_event";
import { AnimationGraphicComponent } from "./animation_graphic_plugin";
import {
    DeathEvent,
    PlayerDeathSystem,
    PlayerDestructionCompleteEvent,
    ZeroArmorEvent,
} from "../nova_plugin/death_plugin";
import { BlastDamageComponent, BlastIgnoreComponent } from "../nova_plugin/blast_plugin";
import { CompositeHull, HurtboxHullComponent } from "../nova_plugin/collisions_plugin";
import { CollisionHitterComponent } from "../nova_plugin/collision_interaction";
import { ShipComponent, ShipDataComponent } from "../nova_plugin/ship_plugin";
import { DeathAISystem } from "../nova_plugin/npc_plugin";
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
                emit(PlayerDestructionCompleteEvent, time, [completionTarget]);
            }
        }
    }
});

// Retail says a heavy ship's death blast scales with its mass but gives no
// coefficient, so these are calibrated against the ship table: the heaviest
// hull in the game is mass 10,000 while even a carrier carries only a couple
// of thousand points of shield and armor. A shared coefficient for reach and
// damage would make one Leviathan death sterilise everything on screen, so
// reach is capped at a few hull lengths.
const SHIP_EXPLOSION_DAMAGE_PER_MASS = 0.02;
const SHIP_EXPLOSION_RADIUS_PER_MASS = 0.02;
const SHIP_EXPLOSION_MAX_RADIUS = 200;

export function shipExplosionBlastStrength(mass: number): number {
    return Number.isFinite(mass) && mass > 0
        ? mass * SHIP_EXPLOSION_DAMAGE_PER_MASS
        : 0;
}

export function shipExplosionBlastRadius(mass: number): number {
    return Number.isFinite(mass) && mass > 0
        ? Math.min(mass * SHIP_EXPLOSION_RADIUS_PER_MASS,
            SHIP_EXPLOSION_MAX_RADIUS)
        : 0;
}

export function makeShipExplosionBlast(
    ship: ShipData,
    position: Position,
    sourceUuid: string,
): Entity | undefined {
    if (!ship.largeExplosion) {
        return undefined;
    }
    const strength = shipExplosionBlastStrength(ship.physics.mass);
    if (strength <= 0) {
        return undefined;
    }
    const damage: WeaponDamage = {
        shield: strength,
        armor: strength,
        ionization: 0,
        ionizationColor: 0,
        passThroughShield: 0,
        knockback: strength,
    };
    return new Entity(`${ship.id} Explosion Blast`)
        .addComponent(BlastDamageComponent, damage)
        .addComponent(BlastIgnoreComponent, new Set([sourceUuid]))
        .addComponent(HurtboxHullComponent, new CompositeHull([
            new SAT.Circle(new SAT.Vector(0, 0),
                shipExplosionBlastRadius(ship.physics.mass)),
        ]))
        .addComponent(CollisionHitterComponent, {
            hitTypes: new Set(['normal']),
        })
        .addComponent(MovementStateComponent, {
            position: Position.fromVectorLike(position),
            accelerating: 0,
            rotation: new Angle(0),
            turnBack: false,
            turning: 0,
            velocity: new Vector(0, 0),
        });
}

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

const ShipFinalExplosionSystem = new System({
    name: 'ShipFinalExplosionSystem',
    events: [DeathEvent],
    before: [PlayerDeathSystem, DeathAISystem],
    args: [ShipDataComponent, GameDataResource, MovementStateComponent,
        Entities, EntityBudgetResource, UUID, Emit, TimeResource,
        ActiveDestructionVisuals] as const,
    step(ship, gameData, movement, entities, budget, shipUuid, emit, time,
        activeDestructionVisuals) {
        const blast = makeShipExplosionBlast(
            ship,
            movement.position,
            shipUuid,
        );
        if (blast) {
            entities.set(v4(), blast);
        }
        if (!ship.finalExplosion) {
            emit(PlayerDestructionCompleteEvent, time, [shipUuid]);
            return;
        }
        const explosionData =
            gameData.data.Explosion.getCached(ship.finalExplosion);

        if (!explosionData) {
            emit(PlayerDestructionCompleteEvent, time, [shipUuid]);
            return;
        }
        let largeExplosion: ExplosionData | undefined;
        if (ship.largeExplosion) {
            largeExplosion = explosionData;
        }
        const explosion = makeExplosion(
            explosionData,
            Position.fromVectorLike(movement.position),
            largeExplosion,
            shipUuid);
        if (reserveEntity(budget, explosion, 'explosion')) {
            entities.set(v4(), explosion);
            registerDestructionVisual(activeDestructionVisuals, shipUuid);
        } else {
            emit(PlayerDestructionCompleteEvent, time, [shipUuid]);
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
        world.resources.delete(ActiveDestructionVisuals);
    }
}
