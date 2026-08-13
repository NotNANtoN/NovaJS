import "jasmine";
import { Entity } from "nova_ecs/entity";
import { TimePlugin } from "nova_ecs/plugins/time_plugin";
import { World } from "nova_ecs/world";
import { DisplayAssetDataInterface } from "../client/gamedata/display_asset_data.js";
import { DisplayAssetDataResource } from "../nova_plugin/game_data_resource.js";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin.js";
import { PlayerSoundEvent, SoundEvent } from "../nova_plugin/sound_plugin.js";
import { SoundPlugin } from "./sound_plugin.js";

const PLAYER_UUID = 'player ship';
const OTHER_UUID = 'other ship';

async function makeSoundWorld() {
    const world = new World('sound test');
    const played: string[] = [];
    const stopped: string[] = [];
    const fakeAssets = {
        data: {
            Sound: {
                getCached(id: string) {
                    return {
                        volume: 0,
                        play() { played.push(id); },
                        stop() { stopped.push(id); },
                    };
                },
                // SoundPlugin pre-warms the UI sounds via get().
                get(id: string) {
                    return Promise.resolve(this.getCached(id));
                },
            },
        },
    } as unknown as DisplayAssetDataInterface;
    world.resources.set(DisplayAssetDataResource, fakeAssets);
    // The per-frame sound limiter keys off the display clock, so the
    // sound systems need TimeResource (the real display world always has
    // it — every animation system reads it).
    await world.addPlugin(TimePlugin);
    await world.addPlugin(SoundPlugin);

    const player = new Entity('player');
    player.components.set(PlayerShipSelector, undefined);
    world.entities.set(PLAYER_UUID, player);
    world.entities.set(OTHER_UUID, new Entity('other'));
    return { world, played, stopped };
}

describe('display sound plugin', () => {
    it('plays untargeted sounds for everyone', async () => {
        const { world, played } = await makeSoundWorld();
        world.emit(SoundEvent, { id: 'nova:200' });
        world.step();
        // Exactly once: the player-only system must not double-play
        // the everyone-hears channel.
        expect(played).toEqual(['nova:200']);
    });

    it("plays player-only sounds for the local player's ship", async () => {
        const { world, played } = await makeSoundWorld();
        world.emit(PlayerSoundEvent, { id: 'nova:128' }, [PLAYER_UUID]);
        world.step();
        expect(played).toEqual(['nova:128']);
    });

    it("keeps other ships' player-only sounds silent", async () => {
        const { world, played } = await makeSoundWorld();
        world.emit(PlayerSoundEvent, { id: 'nova:128' }, [OTHER_UUID]);
        world.step();
        expect(played).toEqual([]);
    });

    it('stops playback instead of playing when asked', async () => {
        const { world, played, stopped } = await makeSoundWorld();
        world.emit(PlayerSoundEvent,
            { id: 'nova:128', stop: true }, [PLAYER_UUID]);
        world.step();
        expect(played).toEqual([]);
        expect(stopped).toEqual(['nova:128']);
    });

    it("ignores stops targeted at other ships' sounds", async () => {
        const { world, stopped } = await makeSoundWorld();
        world.emit(PlayerSoundEvent,
            { id: 'nova:128', stop: true }, [OTHER_UUID]);
        world.step();
        expect(stopped).toEqual([]);
    });

    // The per-frame cap, through the real plugin rather than the pure
    // limiter (see sound_limiter_test for the logic itself): a fleet of
    // identical escorts told to attack fires on one frame.
    it('caps identical same-frame sounds at three', async () => {
        const { world, played } = await makeSoundWorld();
        for (let i = 0; i < 8; i++) {
            world.emit(SoundEvent, { id: 'nova:200' });
        }
        world.step();
        expect(played).toEqual(['nova:200', 'nova:200', 'nova:200']);
    });

    it('caps each sound id separately in one frame', async () => {
        const { world, played } = await makeSoundWorld();
        for (let i = 0; i < 5; i++) {
            world.emit(SoundEvent, { id: 'nova:200' });
            world.emit(SoundEvent, { id: 'nova:201' });
        }
        world.step();
        expect(played.filter(id => id === 'nova:200').length).toEqual(3);
        expect(played.filter(id => id === 'nova:201').length).toEqual(3);
    });

    it('never limits stops, however many arrive at once', async () => {
        // Silencing must always get through — a dropped stop would leave
        // a looping sound ringing forever.
        const { world, stopped } = await makeSoundWorld();
        for (let i = 0; i < 6; i++) {
            world.emit(PlayerSoundEvent,
                { id: 'nova:128', stop: true }, [PLAYER_UUID]);
        }
        world.step();
        expect(stopped.length).toEqual(6);
    });
});
