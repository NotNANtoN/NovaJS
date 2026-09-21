import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { createInitialPlayerState, PlayerStateComponent } from './player_state';
import { ShipComponent } from './ship_plugin';
import { transferFlagship } from './flagship_swap';

describe('transferFlagship', () => {
    it('swaps the player flagship and preserves the old hull as an escort in fleet', () => {
        const state = createInitialPlayerState();
        state.shipId = 'nova:128'; // Starter Shuttle

        const playerEntity = new Entity('player')
            .addComponent(PlayerStateComponent, state)
            .addComponent(ShipComponent, { id: 'nova:128' });

        const result = transferFlagship(state, playerEntity, 'nova:130', 'player-uuid');

        expect(result.previousShipId).toBe('nova:128');
        expect(result.newShipId).toBe('nova:130');
        expect(state.shipId).toBe('nova:130');
        expect(playerEntity.components.get(ShipComponent)?.id).toBe('nova:130');
        expect(state.escorts?.length).toBe(1);
        expect(state.escorts?.[0].shipId).toBe('nova:128');
        expect(state.escorts?.[0].dailyPay).toBe(10);
    });
});
