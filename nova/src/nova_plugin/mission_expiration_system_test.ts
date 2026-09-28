import 'jasmine';
import { getDefaultCronData } from 'novadatainterface/CronData';
import { MockGameData } from 'novadatainterface/MockGameData';
import { AsyncSystemResource } from 'nova_ecs/async_system';
import { Entity } from 'nova_ecs/entity';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import { World } from 'nova_ecs/world';
import { GameDataResource } from './game_data_resource';
import { MissionPlugin, MissionRuntimeResource } from './mission_plugin';
import { OutfitsStateComponent } from './outfit_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { createInitialPlayerState, PlayerStateComponent } from './player_state';

async function settle(world: World, steps = 4) {
    for (let i = 0; i < steps; i++) {
        world.step();
        await world.resources.get(AsyncSystemResource)?.done;
    }
}

describe('MissionExpirationSystem', () => {
    async function setup() {
        const world = new World('mission-expiration');
        const gameData = new MockGameData();
        gameData.data.Cron.map.set('nova:128', {
            ...getDefaultCronData(), id: 'nova:128', name: 'Grant',
            random: 100, onStart: 'G200', onEnd: '',
        });
        const ids = { ...(await gameData.ids), Cron: ['nova:128'] };
        Object.defineProperty(gameData, 'ids', { value: Promise.resolve(ids) });
        world.resources.set(GameDataResource, gameData);
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(MissionPlugin);
        const state = createInitialPlayerState();
        const player = new Entity('player')
            .addComponent(PlayerShipSelector, undefined)
            .addComponent(PlayerStateComponent, state)
            .addComponent(OutfitsStateComponent, new Map());
        world.entities.set('player', player);
        return { world, player };
    }

    it('checks each game date once, not every frame', async () => {
        const { world } = await setup();
        const runtime = world.resources.get(MissionRuntimeResource)!;
        const checkDate = spyOn(runtime, 'checkDate').and.callThrough();
        await settle(world, 6);
        expect(checkDate).toHaveBeenCalledTimes(1);
    });

    it('keeps outfits granted by a crön although the step draft is revoked', async () => {
        const { world, player } = await setup();
        const errors: unknown[] = [];
        spyOn(console, 'error').and.callFake((...args: unknown[]) => errors.push(args));
        await settle(world, 6);
        expect(errors).toEqual([]);
        expect(player.components.get(OutfitsStateComponent)?.get('nova:200')?.count).toBe(1);
    });
});
