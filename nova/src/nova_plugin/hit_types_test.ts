import 'jasmine';
import * as SAT from 'sat';
import RBush from 'rbush';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { getDefaultBeamWeaponData, getDefaultProjectileWeaponData } from 'novadatainterface/WeaponData';
import { getDefaultPlanetData } from 'novadatainterface/PlanetData';
import { CollisionEvent, CollisionHitterComponent, CollisionVulnerabilityComponent } from './collision_interaction';
import { CollisionSystem, CompositeHull, HitboxHullComponent, HurtboxHullComponent, RBushResource } from './collisions_plugin';
import {
    PLANET_BUSTER, planetVulnerableTo, shipHitLayer, stellarDamageAmount, weaponHitTypes,
} from './hit_types';
import { makePlanet } from './make_planet';
import { StellarHealthComponent } from './stellar_blast';

function box() {
    return new CompositeHull([new SAT.Box(new SAT.Vector(-5, -5), 10, 10).toPolygon()]);
}

/** Run one collision pass of `weapon` against targets with the given layers. */
function hits(hitTypes: Set<string>, targets: Record<string, Set<string>>): string[] {
    const world = new World('hit-types');
    world.resources.set(RBushResource, new RBush());
    world.addSystem(CollisionSystem);
    world.entities.set('shot', new Entity()
        .addComponent(HurtboxHullComponent, box())
        .addComponent(CollisionHitterComponent, { hitTypes }));
    for (const [uuid, vulnerableTo] of Object.entries(targets)) {
        world.entities.set(uuid, new Entity()
            .addComponent(HitboxHullComponent, box())
            .addComponent(CollisionVulnerabilityComponent, { vulnerableTo }));
    }
    const hit: string[] = [];
    world.events.get(CollisionEvent).subscribe(event => {
        if (event.initiator) hit.push(event.other);
    });
    world.step();
    return hit.sort();
}

describe('planet-type collision filtering', () => {
    const projectile = getDefaultProjectileWeaponData();
    const planetBuster = { ...projectile, planetType: true };
    const destroyable = planetVulnerableTo({ strength: 1000 })!;
    const layers = {
        destroyablePlanet: destroyable,
        wraith: new Set([shipHitLayer({ planetTypeShip: true })]),
        ship: new Set([shipHitLayer({ planetTypeShip: false })]),
    };

    it('assigns weapon and target layers from data flags', () => {
        expect([...weaponHitTypes(projectile)]).toEqual(['normal']);
        expect([...weaponHitTypes(planetBuster)]).toEqual([PLANET_BUSTER]);
        expect([...weaponHitTypes({ ...projectile, guidance: 'pointDefense' })])
            .toEqual(['pointDefense']);
        expect([...weaponHitTypes({ ...getDefaultBeamWeaponData(), planetType: true })])
            .toEqual([PLANET_BUSTER]);
        expect(planetVulnerableTo({ strength: 0 })).toBeUndefined();
        expect(planetVulnerableTo({ strength: -1 })).toBeUndefined();
        expect(shipHitLayer(undefined)).toBe('normal');
    });

    it('planet-type weapons hit only destroyable stellars and planet-type ships', () => {
        expect(hits(weaponHitTypes(planetBuster), layers))
            .toEqual(['destroyablePlanet', 'wraith']);
    });

    it('normal weapons hit neither stellars nor planet-type ships', () => {
        expect(hits(weaponHitTypes(projectile), layers)).toEqual(['ship']);
    });

    it('only destroyable stellars get a vulnerability and damage pool', () => {
        const invincible = makePlanet({ ...getDefaultPlanetData(), id: 'nova:1', strength: 0 });
        expect(invincible.components.has(CollisionVulnerabilityComponent)).toBeFalse();
        expect(invincible.components.has(StellarHealthComponent)).toBeFalse();
        const target = makePlanet({ ...getDefaultPlanetData(), id: 'nova:2', strength: 750 });
        expect([...target.components.get(CollisionVulnerabilityComponent)!.vulnerableTo])
            .toEqual([PLANET_BUSTER]);
        expect(target.components.get(StellarHealthComponent))
            .toEqual({ current: 750, max: 750, attackers: [] });
    });

    it('counts combined mass and energy damage', () => {
        const damage = { ...projectile.damage, armor: 30, shield: 12 };
        expect(stellarDamageAmount(damage)).toBe(42);
        expect(stellarDamageAmount(damage, 0.5)).toBe(21);
        expect(stellarDamageAmount({ ...damage, armor: -5, shield: 0 })).toBe(0);
    });
});
