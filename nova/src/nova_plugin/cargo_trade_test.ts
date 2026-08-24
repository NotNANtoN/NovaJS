import {
    allocateCargo,
    createInitialPlayerState,
    getFreeSpace,
    releaseMissionCargo,
} from './player_state';
import {
    buyCommodity,
    sellCommodity,
} from './trade_model';

describe('cargo and trade model', () => {
    it('allocates and releases ordinary and mission cargo independently', () => {
        const state = createInitialPlayerState();
        state.cargoCapacity = 10;

        expect(allocateCargo(state, {
            commodity: 'Food',
            tons: 4,
            isMissionCargo: false,
        })).toBe(true);
        expect(allocateCargo(state, {
            commodity: 'proc:test',
            tons: 3,
            isMissionCargo: true,
        })).toBe(true);
        expect(getFreeSpace(state)).toBe(3);

        expect(releaseMissionCargo(state, 'proc:test')).toBe(3);
        expect(getFreeSpace(state)).toBe(6);
        expect(state.holds).toEqual([{
            commodity: 'Food',
            tons: 4,
            isMissionCargo: false,
        }]);
    });

    it('applies credit and free-space math to buy and sell', () => {
        const state = createInitialPlayerState();
        state.cargoCapacity = 5;
        const lowFood = {
            commodity: 'Food' as const,
            priceLevel: 'low' as const,
            price: 60,
        };
        const highFood = {
            ...lowFood,
            priceLevel: 'high' as const,
            price: 93,
        };

        expect(buyCommodity(state, lowFood, 3)).toEqual({
            success: true,
            tons: 3,
            total: 180,
        });
        expect(state.credits).toBe(9_820);
        expect(getFreeSpace(state)).toBe(2);
        expect(buyCommodity(state, lowFood, 3).success).toBe(false);

        expect(sellCommodity(state, highFood, 2)).toEqual({
            success: true,
            tons: 2,
            total: 186,
        });
        expect(state.credits).toBe(10_006);
        expect(getFreeSpace(state)).toBe(4);
    });

    it('does not sell mission cargo through the trade model', () => {
        const state = createInitialPlayerState();
        allocateCargo(state, {
            commodity: 'Food',
            tons: 2,
            isMissionCargo: true,
        });
        const offer = {
            commodity: 'Food' as const,
            priceLevel: 'high' as const,
            price: 93,
        };
        expect(sellCommodity(state, offer).success).toBe(false);
        expect(getFreeSpace(state)).toBe(8);
    });
});

