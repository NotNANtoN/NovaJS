import 'jasmine';
import { ShipData } from 'novadatainterface/ship_data';
import { getIntegrationGameData } from '../communication/simulation_test_fixture.js';
import {
    shipBuyRandomPasses,
    ShipyardContext,
    visibleShips,
} from './shipyard_stock_rules.js';

/** Shipyard gates against the REAL Nova game data (see the shïp gates in
 * shipyard_stock_rules.ts. Resource ids below are the classic shïp ids.) */
describe('shipyard stock against real Nova data', () => {
    async function allShips(): Promise<ShipData[]> {
        const gameData = await getIntegrationGameData();
        const ids = (await gameData.ids).Ship;
        return await Promise.all(ids.map(id => gameData.data.Ship.get(id)));
    }
    function makeCtx(over: Partial<ShipyardContext> = {}): ShipyardContext {
        return { bits: new Set(), contribute: 0n, day: 0, stellarId: 472, ...over };
    }
    async function byId(): Promise<Map<string, ShipData>> {
        return new Map((await allShips()).map(s => [s.id, s]));
    }

    it('exposes the parsed Availability/Require/BuyRandom/Flags3 gates', async () => {
        const ships = await byId();
        const shuttle = ships.get('nova:128')!; // Shuttle
        expect(shuttle.buyRandom).toBe(35);
        expect(shuttle.hideIfAvailabilityFalse).toBeTrue();
        expect(shuttle.hideIfRequireUnmet).toBeTrue();
        const leviathan = ships.get('nova:131')!; // Leviathan
        expect(leviathan.availability).toContain('b33');
        expect(leviathan.buyRandom).toBe(45);
        expect(BigInt(leviathan.require)).toBe(274877906944n);
    });

    it('hides the Leviathan at a 0x0100 shipyard when its Availability fails',
        async () => {
            const leviathan = (await byId()).get('nova:131')!;
            // No control bits: 'b33 & P30' is false, and 0x0100 hides it.
            expect(visibleShips([leviathan], makeCtx()))
                .not.toContain(leviathan);
        });

    it('never sells a BuyRandom-0 ship, and hides it via 0x0100 + b9999',
        async () => {
            const dart = (await byId()).get('nova:173')!; // Vell-os Dart
            expect(dart.buyRandom).toBe(0);
            expect(shipBuyRandomPasses(dart, makeCtx())).toBeFalse();
            // buyRandom 0 AND availability b9999 fails without the bit, so
            // the 0x0100 flag hides it entirely.
            expect(visibleShips([dart], makeCtx())).not.toContain(dart);
        });

    it('varies by day for a partial BuyRandom stock ship', async () => {
        const shuttle = (await byId()).get('nova:128')!; // 35%
        const open = new Set<number>();
        for (let d = 0; d < 100; d++) {
            if (shipBuyRandomPasses(shuttle, makeCtx({ day: d }))) {
                open.add(d);
            }
        }
        expect(open.size).toBeGreaterThan(5);
        expect(open.size).toBeLessThan(95);
    });
});
