import { getDefaultShipData } from 'novadatainterface/ShipData';
import { MockGameData } from 'novadatainterface/MockGameData';
import { Entity } from 'nova_ecs/entity';
import { NcbRuntime, PendingMissionJumpComponent, PendingMissionSoundComponent } from './ncb_runtime';
import { OutfitsStateComponent } from './outfit_plugin';
import { createInitialPlayerState } from './player_state';
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
