import { ShipData } from "novadatainterface/ShipData";
import { WeaponDamage } from "novadatainterface/WeaponData";
import { Angle } from "nova_ecs/datatypes/angle";
import { Position } from "nova_ecs/datatypes/position";
import { Vector } from "nova_ecs/datatypes/vector";
import { Entity } from "nova_ecs/entity";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import * as SAT from "sat";
import { BlastDamageComponent, BlastIgnoreComponent } from "./blast_plugin";
import { CollisionHitterComponent } from "./collision_interaction";
import { CompositeHull, HurtboxHullComponent } from "./collisions_plugin";

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
