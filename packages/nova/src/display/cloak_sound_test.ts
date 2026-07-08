import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { System } from 'nova_ecs/system';
import { SingletonComponent, World } from 'nova_ecs/world';
import { CloakActiveComponent, CloakActiveState } from '../nova_plugin/cloak_plugin.js';
import { SoundEvent } from '../nova_plugin/sound_plugin.js';
import {
    CLOAK_OFF_SOUND,
    CLOAK_ON_SOUND,
    CloakSoundPlugin,
    cloakTransitionSound,
} from './cloak_sound_plugin.js';

describe('cloakTransitionSound', () => {
    it('plays cloak-on exactly on the false->true edge', () => {
        expect(cloakTransitionSound(false, true)).toBe(CLOAK_ON_SOUND);
    });

    it('plays cloak-off exactly on the true->false edge', () => {
        expect(cloakTransitionSound(true, false)).toBe(CLOAK_OFF_SOUND);
    });

    it('plays nothing when the state is unchanged (no looping)', () => {
        expect(cloakTransitionSound(false, false)).toBeUndefined();
        expect(cloakTransitionSound(true, true)).toBeUndefined();
    });
});

describe('CloakSoundSystem', () => {
    let world: World;
    let played: string[];

    const soundRecorder = new System({
        name: 'SoundRecorder',
        events: [SoundEvent],
        args: [SoundEvent, SingletonComponent] as const,
        step(sound) {
            played.push(sound.id);
        },
    });

    beforeEach(async () => {
        world = new World();
        played = [];
        await world.addPlugin(CloakSoundPlugin);
        world.addSystem(soundRecorder);
    });

    it('plays each edge once across any number of steps', () => {
        const cloakState: CloakActiveState = { active: true };
        world.entities.set('ship', new Entity()
            .addComponent(CloakActiveComponent, cloakState));

        // First sight with an active cloak counts as the activation edge
        // (the sim creates the component on the first toggle).
        world.step();
        world.step();
        world.step();
        expect(played).toEqual([CLOAK_ON_SOUND]);

        // Deactivation (any decloak path mutates the same synced flag).
        cloakState.active = false;
        world.step();
        world.step();
        expect(played).toEqual([CLOAK_ON_SOUND, CLOAK_OFF_SOUND]);

        // Re-activation plays again.
        cloakState.active = true;
        world.step();
        world.step();
        expect(played).toEqual(
            [CLOAK_ON_SOUND, CLOAK_OFF_SOUND, CLOAK_ON_SOUND]);
    });

    it('plays nothing for a ship first seen uncloaked', () => {
        world.entities.set('ship', new Entity()
            .addComponent(CloakActiveComponent, { active: false }));
        world.step();
        world.step();
        expect(played).toEqual([]);
    });
});
