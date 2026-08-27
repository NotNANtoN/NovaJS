import { getDefaultShipData } from 'novadatainterface/ShipData';
import {
    ESCAPE_POD_RETAIL_MESSAGE,
    findEscapePodOutfit,
    persEscapePodDisposition,
    recoverPilotAfterEscapePod,
} from './escape_pod';
import {
    createInitialPlayerState,
    toPersistentPlayerState,
} from './player_state';

describe('escape pod rules', () => {
    it('finds a positive-count ModType 11 outfit', () => {
        const outfits = new Map([
            ['armor', { count: 2 }],
            ['empty-pod', { count: 0 }],
            ['pod', { count: 1 }],
        ]);
        const escapePodIds = new Set(['empty-pod', 'pod']);

        expect(findEscapePodOutfit(outfits, id => ({
            isEscapePod: escapePodIds.has(id),
        }))).toBe('pod');
    });

    it('replaces ship inventory while preserving the pilot record', () => {
        const state = createInitialPlayerState();
        state.shipId = 'nova:200';
        state.credits = 543_210;
        state.kills = 42;
        state.legalRecords = { 'nova:128': -50 };
        state.holds = [
            { commodity: 'Food', tons: 4, isMissionCargo: false },
            { commodity: 'mission', tons: 3, isMissionCargo: true },
        ];
        state.activeMissions = [{
            missionId: 'mission',
            state: 'active',
            cargo: { type: 1, quantity: 3 },
        }];
        const basicHull = {
            ...getDefaultShipData(),
            id: 'nova:128',
            cargoCapacity: 10,
            fuelCapacity: 300,
            outfits: {
                'nova:128': 1,
            },
        };

        const recovered = recoverPilotAfterEscapePod(
            toPersistentPlayerState(state), basicHull);

        expect(recovered.playerState.shipId).toBe('nova:128');
        expect(recovered.playerState.cargoCapacity).toBe(10);
        expect(recovered.playerState.fuel).toBe(300);
        expect(recovered.playerState.holds).toEqual([]);
        expect(recovered.playerState.activeMissions[0].cargo?.quantity)
            .toBe(0);
        expect(recovered.outfits).toEqual(new Map([
            ['nova:128', { count: 1 }],
        ]));
        expect(recovered.playerState.credits).toBe(543_210);
        expect(recovered.playerState.kills).toBe(42);
        expect(recovered.playerState.legalRecords)
            .toEqual({ 'nova:128': -50 });
        expect(state.shipId).toBe('nova:200');
        expect(state.holds.length).toBe(2);
    });

    it('uses the retail escape-pod rescue wording', () => {
        expect(ESCAPE_POD_RETAIL_MESSAGE).toContain(
            'a passing prospector picks up your distress beacon');
        expect(ESCAPE_POD_RETAIL_MESSAGE).toContain(
            'scratch up enough money to buy a new ship');
    });

    it('suppresses only the visible pers pod for govt flag 0x0100', () => {
        expect(persEscapePodDisposition(0, 0x0100)).toBe('none');
        expect(persEscapePodDisposition(0x0002, 0)).toBe('launch');
        expect(persEscapePodDisposition(0x0002, 0x0100)).toBe('suppress');
    });
});
