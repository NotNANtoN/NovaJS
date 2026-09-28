import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { MockGameData } from 'novadatainterface/MockGameData';
import { getDefaultMissionData } from 'novadatainterface/MissionData';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { evaluateTestExpression } from '../nova_plugin/ncb';
import { OutfitsState } from '../nova_plugin/outfit_plugin';
import { createInitialPlayerState } from '../nova_plugin/player_state';
import { ShipComponent, ShipDataComponent } from '../nova_plugin/ship_plugin';
import { runShopSetExpression } from './shop_ncb';

const readBit = (bits: readonly boolean[] | ReadonlySet<number>, bit: number) =>
    evaluateTestExpression(`b${bit}`, { missionBits: bits as never });

describe('runShopSetExpression', () => {
    let gameData: MockGameData;

    beforeEach(() => {
        gameData = new MockGameData();
        gameData.data.Ship.map.set('nova:165', {
            ...getDefaultShipData(),
            id: 'nova:165',
            name: 'Mod Starbridge',
            cargoCapacity: 25,
            outfits: { 'nova:200': 2 },
        });
        gameData.data.Mission.map.set('nova:731', {
            ...getDefaultMissionData(),
            id: 'nova:731',
            name: 'Forged licence follow-up',
        });
    });

    it('runs G/D and bit operators on the dialog outfit map', async () => {
        const state = createInitialPlayerState();
        const outfits: OutfitsState = new Map([
            ['nova:265', { count: 1 }], ['nova:128', { count: 1 }],
        ]);
        await runShopSetExpression({
            gameData: gameData as never,
            state,
            outfits,
            expression: 'b77 G300 D265',
        });
        expect(readBit(state.missionBits, 77)).toBeTrue();
        expect(outfits.get('nova:300')?.count).toBe(1);
        expect(outfits.has('nova:265')).toBeFalse();
        expect(outfits.get('nova:128')?.count).toBe(1);
    });

    it('starts S missions queued by the expression (retail oütf 363)', async () => {
        const state = createInitialPlayerState();
        await runShopSetExpression({
            gameData: gameData as never,
            state,
            outfits: new Map(),
            expression: 'S731 D265',
        });
        expect(state.activeMissions.map(entry => entry.missionId))
            .toContain('nova:731');
    });

    it('swaps the hull for H with its defaults and asks the server (retail 314)', async () => {
        const state = createInitialPlayerState();
        const previous = state.shipId;
        const outfits: OutfitsState = new Map([['nova:128', { count: 3 }]]);
        const entity = new Entity().addComponent(ShipComponent, { id: previous });
        const requests: unknown[][] = [];
        const result = await runShopSetExpression({
            gameData: gameData as never,
            state,
            outfits,
            entity,
            expression: 'H165',
            source: { kind: 'outfit', id: 'nova:314' },
            requestShipGrant: async (...args) => {
                requests.push(args.slice(1, 3));
                return {};
            },
        });
        expect(state.shipId).toBe('nova:165');
        expect(state.cargoCapacity).toBe(25);
        expect(result.ship?.id).toBe('nova:165');
        // H resets non-persistent outfits and adds the hull defaults.
        expect([...outfits]).toEqual([['nova:200', { count: 2 }]]);
        expect(entity.components.get(ShipComponent)?.id).toBe('nova:165');
        expect(entity.components.get(ShipDataComponent)?.id).toBe('nova:165');
        expect(requests).toEqual([
            ['nova:165', { kind: 'outfit', id: 'nova:314' }],
        ]);
    });

    it('restores the previous hull when the server rejects the grant', async () => {
        const state = createInitialPlayerState();
        const previous = state.shipId;
        const entity = new Entity().addComponent(ShipComponent, { id: previous });
        let changed = 0;
        await runShopSetExpression({
            gameData: gameData as never,
            state,
            outfits: new Map(),
            entity,
            expression: 'H165',
            source: { kind: 'outfit', id: 'nova:314' },
            requestShipGrant: () => Promise.reject(new Error('nope')),
            onStateChanged: () => changed++,
            logger: () => undefined,
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(state.shipId).toBe(previous);
        expect(entity.components.get(ShipComponent)?.id).toBe(previous);
        expect(changed).toBe(1);
    });

    it('does not ask for a grant without a source (ship OnPurchase)', async () => {
        const state = createInitialPlayerState();
        const request = jasmine.createSpy('request');
        await runShopSetExpression({
            gameData: gameData as never,
            state,
            expression: 'b8888',
            requestShipGrant: request,
        });
        expect(readBit(state.missionBits, 8888)).toBeTrue();
        expect(request).not.toHaveBeenCalled();
    });

    it('ignores empty expressions', async () => {
        const state = createInitialPlayerState();
        const before = JSON.stringify(state);
        await runShopSetExpression({
            gameData: gameData as never, state, expression: '  ',
        });
        expect(JSON.stringify(state)).toBe(before);
    });
});
