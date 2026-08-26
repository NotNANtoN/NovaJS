import 'jasmine';
import * as SAT from 'sat';
import { getDefaultExplosionData } from 'novadatainterface/ExplosionData';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { Entity } from 'nova_ecs/entity';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import { ArmorComponent, ShieldComponent } from './health_plugin';
import { Stat } from './stat';
import { DeathEvent, DeathPlugin, AppliedDamageEvent } from './death_plugin';
import {
    CollisionVulnerabilityComponent,
} from './collision_interaction';
import {
    CollisionsPlugin,
    CompositeHull,
    HitboxHullComponent,
} from './collisions_plugin';
import { BlastPlugin } from './blast_plugin';
import { EntityBudget, EntityBudgetResource } from './entity_budget';
import { GameDataResource } from './game_data_resource';
import { ExplosionPlugin } from '../display/explosion_plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { ShipComponent, ShipDataComponent } from './ship_plugin';

describe('ship death blasts', () => {
    it('damages a nearby ship through the collision path', async () => {
        const explosionData = getDefaultExplosionData();
        const gameData = {
            data: {
                Explosion: {
                    getCached: () => explosionData,
                },
            },
        };
        const time = {
            time: 0,
            delta_ms: 0,
            delta_s: 0,
            frame: 0,
        };
        const world = new World('ship-death-blast-test');
        world.resources.set(TimeResource, time);
        world.resources.set(GameDataResource, gameData as never);
        world.resources.set(EntityBudgetResource, new EntityBudget());
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(DeathPlugin);
        await world.addPlugin(CollisionsPlugin);
        await world.addPlugin(BlastPlugin);
        await world.addPlugin(ExplosionPlugin);

        const sourceData = getDefaultShipData();
        sourceData.id = 'large-ship';
        sourceData.finalExplosion = 'death';
        sourceData.largeExplosion = true;
        sourceData.physics.mass = 500;
        const source = new Entity('source')
            .addComponent(ShipComponent, { id: sourceData.id })
            .addComponent(ShipDataComponent, sourceData)
            .addComponent(MovementStateComponent, {
                accelerating: 0,
                position: new Position(0, 0),
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity: new Vector(0, 0),
            });
        const target = new Entity('target')
            .addComponent(ShipComponent, { id: 'target-ship' })
            .addComponent(ShipDataComponent, getDefaultShipData())
            .addComponent(ShieldComponent, new Stat({
                current: 100,
                recharge: 0,
                max: 100,
            }))
            .addComponent(ArmorComponent, new Stat({
                current: 100,
                recharge: 0,
                max: 100,
            }))
            .addComponent(MovementStateComponent, {
                accelerating: 0,
                position: new Position(0, 0),
                rotation: new Angle(0),
                turnBack: false,
                turning: 0,
                velocity: new Vector(0, 0),
            })
            .addComponent(HitboxHullComponent, new CompositeHull([
                new SAT.Circle(new SAT.Vector(0, 0), 1),
            ]))
            .addComponent(CollisionVulnerabilityComponent, {
                vulnerableTo: new Set(['normal']),
            });
        world.entities.set('source', source);
        world.entities.set('target', target);

        const applied: unknown[] = [];
        world.events.get(AppliedDamageEvent).subscribe(damage => {
            applied.push(damage);
        });
        world.emitNow(DeathEvent, time, ['source']);
        world.step();

        expect(target.components.get(ShieldComponent)?.current)
            .toBeCloseTo(90, 8);
        expect(applied).toContain(jasmine.objectContaining({
            shield: 10,
            armor: 0,
            damager: jasmine.any(String),
            fromExplosion: true,
        }));
    });
});
