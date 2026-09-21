import { Component } from 'nova_ecs/component';
import { Entity } from 'nova_ecs/entity';
import { assertArchetype, ComponentTuple } from 'nova_ecs/archetype';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { ShipComponent } from './ship_plugin';
import { TargetComponent } from './target_component';
import { HiredEscortComponent } from './escort_plugin';
import { PlanetComponent } from './planet_plugin';
import { ProjectileComponent } from './projectile_data';
import { HurtboxHullComponent } from './collisions_plugin';
import { BeamDataComponent } from './beam_plugin';

export const ShipArchetypeComponents = [
    ShipComponent,
    MovementStateComponent,
    TargetComponent,
] as const;

export const EscortArchetypeComponents = [
    ShipComponent,
    MovementStateComponent,
    TargetComponent,
    HiredEscortComponent,
] as const;

export const PlanetArchetypeComponents = [
    PlanetComponent,
    MovementStateComponent,
] as const;

export const ProjectileArchetypeComponents = [
    ProjectileComponent,
    MovementStateComponent,
    HurtboxHullComponent,
] as const;

export const BeamArchetypeComponents = [
    BeamDataComponent,
] as const;

/**
 * Checks whether an entity has all components required by an archetype.
 */
export function isArchetype<T extends ComponentTuple>(
    entity: Entity,
    components: T,
): boolean {
    return components.every(comp => entity.components.has(comp as Component<unknown>));
}

export function assertShipArchetype(entity: Entity, context = 'Ship'): void {
    assertArchetype(entity, ShipArchetypeComponents, context);
}

export function assertEscortArchetype(entity: Entity, context = 'Escort'): void {
    assertArchetype(entity, EscortArchetypeComponents, context);
}

export function assertPlanetArchetype(entity: Entity, context = 'Planet'): void {
    assertArchetype(entity, PlanetArchetypeComponents, context);
}

export function assertProjectileArchetype(entity: Entity, context = 'Projectile'): void {
    assertArchetype(entity, ProjectileArchetypeComponents, context);
}
