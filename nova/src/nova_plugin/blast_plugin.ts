import { WeaponDamage } from 'novadatainterface/WeaponData';
import { Entities, EmitNow, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { ProvideArg } from 'nova_ecs/provide_arg';
import { System } from 'nova_ecs/system';
import { CollisionSystem } from './collisions_plugin';
import { CollisionEvent } from './collision_interaction';
import { DamagedEvent } from './death_plugin';
import { recordShotImpact } from './fire_sync';
import { PlatformResource } from './platform_plugin';


// Damage done by a blast.
export const BlastDamageComponent = new Component<WeaponDamage>('BlastComponent');

// A set of entities not to interact with. Usually just the entity that
// the projectile already hit so damage is not applied twice.
export const BlastIgnoreComponent = new Component<Set<string>>('BlastIgnoreComponent');

/**
 * The synchronized shot whose explosion this is. Server: each ship the blast
 * damages is reported as a `blast` ShotImpact. Client: such a blast never
 * decides hits on replicated entities itself.
 */
export const BlastShotComponent =
    new Component<{ source: string, seq: number }>('BlastShot');

const BlastCollisionSystem = new System({
    name: 'BlastCollisionSystem',
    events: [CollisionEvent],
    args: [CollisionEvent, BlastDamageComponent,
        Optional(BlastIgnoreComponent), EmitNow, UUID, Entities,
        Optional(BlastShotComponent), Optional(PlatformResource),
        Optional(TimeResource), Optional(MovementStateComponent)] as const,
    step(collision, damage, ignore, emitNow, uuid, entities, shot, platform,
        time, movement) {
        if (ignore?.has(collision.other)) {
            return;
        }
        const replicated = entities.get(collision.other)
            ?.components.has(MultiplayerData) ?? false;
        if (shot && replicated) {
            if (platform === 'browser') {
                // The server reports which ships this blast damaged.
                return;
            }
            if (platform === 'node' && time && movement) {
                recordShotImpact(entities, shot.source, shot.seq, time.time,
                    movement.position, collision.other, 'blast');
            }
        }
        emitNow(DamagedEvent, {
            damage,
            damager: uuid,
            fromExplosion: true,
        }, [collision.other])
    }
});

const BlastDoneComponent = new Component<{ done: boolean }>('BlastDone');
const BlastDoneProvider = ProvideArg({
    provided: BlastDoneComponent,
    args: [] as const,
    factory: () => ({ done: false }),
});
// Deletes blasts after they've existed for one frame
const BlastEndSystem = new System({
    name: 'BlastEndSystem',
    // Happens before the collision system so blasts can
    // exist for exactly one collision event (todo: maybe collision
    // event should emit the entity value directly?)
    before: [CollisionSystem],
    args: [Entities, UUID, BlastDoneProvider, BlastDamageComponent] as const,
    step(entities, uuid, blastDone) {
        if (blastDone.done) {
            entities.delete(uuid);
        }
        blastDone.done = true;
    }
});

export const BlastPlugin: Plugin = {
    name: 'BlastPlugin',
    build(world) {
        world.addSystem(BlastCollisionSystem);
        world.addSystem(BlastEndSystem);
    }
}
