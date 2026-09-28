import { PlanetData } from "novadatainterface/PlanetData";
import { Angle } from "nova_ecs/datatypes/angle";
import { Position } from "nova_ecs/datatypes/position";
import { Vector } from "nova_ecs/datatypes/vector";
import { Entity } from "nova_ecs/entity";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { PlanetComponent } from "./planet_plugin";
import { AlwaysRelevantComponent } from 'nova_ecs/plugins/multiplayer_plugin';
import { CollisionVulnerabilityComponent } from "./collision_interaction";
import { planetVulnerableTo } from "./hit_types";
import { StellarBlastComponent, StellarHealthComponent } from "./stellar_blast";

export function makePlanet(planetData: PlanetData): Entity {
    const planet = new Entity(planetData.name)
        .addComponent(AlwaysRelevantComponent, undefined);

    planet.components.set(PlanetComponent, {
        id: planetData.id,
        name: planetData.name,
        flags: planetData.flags,
        techLevel: planetData.techLevel,
        specialTech: [...(planetData.specialTech ?? [])],
        canLand: planetData.canLand,
        inhabited: planetData.inhabited,
        ...(planetData.strength !== undefined ? { strength: planetData.strength } : {}),
        ...(planetData.deadType !== undefined ? { deadType: planetData.deadType } : {}),
    });

    planet.components.set(MovementStateComponent, {
        accelerating: 0,
        position: new Position(planetData.position[0],
            planetData.position[1]),
        rotation: new Angle(0),
        turnBack: false,
        turning: 0,
        velocity: new Vector(0, 0),
    });

    // Only destroyable stellars (spöb Strength > 0) can be hit at all, and
    // then only by planet-type weapons. The hit shape comes from the
    // stellar's sprite hull (HitboxHullProvider).
    const vulnerableTo = planetVulnerableTo(planetData);
    if (vulnerableTo) {
        planet.components.set(CollisionVulnerabilityComponent, { vulnerableTo });
        planet.components.set(StellarHealthComponent, {
            current: planetData.strength!,
            max: planetData.strength!,
            attackers: [],
        });
        planet.components.set(StellarBlastComponent, { seq: 0 });
    }

    return planet;
}
