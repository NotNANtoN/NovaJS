import { getDefaultShipData } from 'novadatainterface/ShipData';
import { MockGameData } from 'novadatainterface/MockGameData';
import { Entity } from 'nova_ecs/entity';
import { NcbRuntime, PendingMissionJumpComponent, PendingMissionSoundComponent } from './ncb_runtime';
import { OutfitsStateComponent } from './outfit_plugin';
import { createInitialPlayerState, PlayerStateComponent } from './player_state';
import { ShipComponent, ShipDataComponent } from './ship_plugin';

async function settleAsyncEffects() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('NcbRuntime', () => {
    it('reloads ship data even without defaults and resets H changes', async () => {
        const gameData = new MockGameData();
        const ship = {
            ...getDefaultShipData(),
            id: 'nova:129',
            cargoCapacity: 20,
            outfits: { 'nova:2': 3 },
        };
        gameData.data.Ship.map.set(ship.id, ship);
        const runtime = new NcbRuntime(gameData);
        const state = createInitialPlayerState();
        const entity = new Entity()
            .addComponent(ShipComponent, { id: 'nova:128' })
            .addComponent(ShipDataComponent, getDefaultShipData())
            .addComponent(OutfitsStateComponent, new Map([
                ['nova:1', { count: 2 }],
            ]));

        runtime.apply('C129', entity, state);
        await settleAsyncEffects();
        expect(entity.components.get(ShipComponent)?.id).toBe('nova:129');
        expect(entity.components.get(ShipDataComponent)?.id).toBe('nova:129');
        expect(entity.components.get(OutfitsStateComponent)?.get('nova:1'))
            .toEqual({ count: 2 });

        runtime.apply('H129', entity, state);
        await settleAsyncEffects();
        expect(entity.components.get(OutfitsStateComponent)).toEqual(new Map([
            ['nova:2', { count: 3 }],
        ]));
    });

    it('asks the server to grant C/E/H hulls with the set expression source', async () => {
        const gameData = new MockGameData();
        gameData.data.Ship.map.set('nova:381', { ...getDefaultShipData(), id: 'nova:381' });
        const requests: unknown[][] = [];
        const runtime = new NcbRuntime(gameData, {
            requestShipGrant: async (_state, shipId, source, apply) => {
                requests.push([shipId, source]);
                apply({ balance: { shipId, fuel: 1, ammo: {}, revision: 9 }, credits: 5 });
            },
        });
        const state = createInitialPlayerState();
        const entity = new Entity()
            .addComponent(ShipComponent, { id: 'nova:128' })
            .addComponent(PlayerStateComponent, state);
        runtime.apply('b1 H381', entity, state, { kind: 'mission', id: 'nova:197' });
        await settleAsyncEffects();
        expect(requests).toEqual([['nova:381', { kind: 'mission', id: 'nova:197' }]]);
        expect(state.shipId).toBe('nova:381');
        expect(state.combatResources?.revision).toBe(9);
    });

    it('restores the previous hull when the server rejects a grant', async () => {
        const gameData = new MockGameData();
        gameData.data.Ship.map.set('nova:381', { ...getDefaultShipData(), id: 'nova:381' });
        const runtime = new NcbRuntime(gameData, {
            requestShipGrant: async () => { throw new Error('Ship not granted by source'); },
        });
        const state = createInitialPlayerState();
        const entity = new Entity()
            .addComponent(ShipComponent, { id: 'nova:128' })
            .addComponent(PlayerStateComponent, state);
        runtime.apply('H381', entity, state, { kind: 'outfit', id: 'nova:1' });
        await settleAsyncEffects();
        expect(state.shipId).toBe('nova:128');
        expect(entity.components.get(ShipComponent)?.id).toBe('nova:128');
    });

    it('records jumps and sounds as ECS effects', () => {
        const runtime = new NcbRuntime(new MockGameData());
        const entity = new Entity();
        const state = createInitialPlayerState();

        runtime.apply('M131 P9', entity, state);

        expect(entity.components.get(PendingMissionJumpComponent))
            .toEqual({ systemId: 'nova:131', relative: false });
        expect(entity.components.get(PendingMissionSoundComponent))
            .toEqual({ soundId: 'nova:9' });
    });
});
