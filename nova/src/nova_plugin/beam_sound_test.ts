import 'jasmine';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import { GameDataResource } from './game_data_resource';
import { PlatformResource } from './platform_plugin';
import { MockGameData } from 'novadatainterface/MockGameData';
import { BeamPlugin, BeamSystem, BeamDataComponent, BeamStateComponent } from './beam_plugin';
import { CreateTime } from './create_time';
import { FireSubs, WeaponConstructors } from './fire_weapon_plugin';
import { ProjectilePlugin } from './projectile_plugin';
import { ProjectileDataComponent } from './projectile_data';
import { SoundEvent } from './sound_event';
import { getDefaultBeamWeaponData, getDefaultProjectileWeaponData } from 'novadatainterface/WeaponData';

describe('Beam looping sound management', () => {
    it('stops looping sound when beam duration expires', () => {
        const world = new World('beam-sound-stop-test');
        world.resources.set(TimeResource, {
            time: 2000,
            delta_ms: 1000 / 60,
            delta_s: 1 / 60,
            frame: 10,
        });
        world.resources.set(FireSubs, () => []);

        const beamData = {
            ...getDefaultBeamWeaponData(),
            sound: 'nova:350',
            loopSound: true,
            shotDuration: 500,
            beamAnimation: { length: 200 },
        };

        const beam = new Entity('lance-beam')
            .addComponent(BeamDataComponent, beamData as any)
            .addComponent(BeamStateComponent, { length: 200, inaccuracy: 0 })
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                accelerating: 0,
                turning: 0,
                turnBack: false,
            })
            .addComponent(CreateTime, 1000); // Fired at t=1000, now t=2000 > 1000+500

        world.entities.set('lance-beam', beam);
        world.addSystem(BeamSystem);

        let stoppedSoundId: string | undefined;
        world.events.get(SoundEvent).subscribe(event => {
            if (event.stop) {
                stoppedSoundId = event.id;
            }
        });

        world.step();

        expect(world.entities.has('lance-beam')).toBeFalse();
        expect(stoppedSoundId).toBe('nova:350');
    });

    it('stops looping sound on DeleteEvent when a point-defense projectile or beam is deleted', async () => {
        const world = new World('pd-loop-sound-cleanup-test');
        world.resources.set(TimeResource, {
            time: 1000,
            delta_ms: 16,
            delta_s: 0.016,
            frame: 1,
        });
        world.resources.set(FireSubs, () => []);
        world.resources.set(WeaponConstructors, new Map());
        world.resources.set(PlatformResource, 'browser');
        world.resources.set(GameDataResource, new MockGameData());
        await world.addPlugin(BeamPlugin);
        await world.addPlugin(ProjectilePlugin);

        const stoppedSoundIds: string[] = [];
        world.events.get(SoundEvent).subscribe(event => {
            if (event.stop && event.id) {
                stoppedSoundIds.push(event.id);
            }
        });

        const pdProjData = {
            ...getDefaultProjectileWeaponData(),
            sound: 'nova:352',
            loopSound: true,
            guidance: 'pointDefense' as const,
            shotDuration: 200,
        };
        const pdProj = new Entity('pd-projectile')
            .addComponent(ProjectileDataComponent, pdProjData)
            .addComponent(MovementStateComponent, {
                position: new Position(0, 0),
                velocity: new Vector(0, 0),
                rotation: new Angle(0),
                accelerating: 0,
                turning: 0,
                turnBack: false,
            });
        world.entities.set('pd-shot-1', pdProj);
        world.step();

        world.entities.delete('pd-shot-1');
        world.step();

        expect(stoppedSoundIds).toContain('nova:352');
    });
});
