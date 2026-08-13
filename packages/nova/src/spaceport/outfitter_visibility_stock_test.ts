import 'jasmine';
import { OutfitData } from 'novadatainterface/outfit_data';
import { getIntegrationGameData } from '../communication/simulation_test_fixture.js';
import { getDefaultShipData } from 'novadatainterface/ship_data';
import {
    buysBackOutfit,
    OutfitterContext,
    OutfitterStellar,
    visibleOutfits,
} from './outfitter_rules.js';

/**
 * The outfitter visibility rules run against the REAL Nova game data, so
 * the Bible's rules are pinned to what the shipped game actually contains.
 *
 * Stock facts these lean on (spöb/oütf resource ids; the global id's
 * numeric part is the classic resource id):
 *  - spöb 164 "Snowmelt": techLevel 2, SpecialTech [81].
 *  - spöb 156 "Sirrusa": techLevel 0, no SpecialTech, Flags2 0x0400 — the
 *    ONLY stock stellar with the buys-anything bit.
 *  - oütf 342 "Area Map - Vell-os": techLevel 0 with flag 0x4000 and an
 *    Availability of b9999 (a bit stock data never sets).
 *  - oütf 433 "Map; Fed/Pol": techLevel 81, reachable only via SpecialTech.
 */
describe('outfitter visibility against real Nova data', () => {
    async function allOutfits(): Promise<OutfitData[]> {
        const gameData = await getIntegrationGameData();
        const ids = (await gameData.ids).Outfit;
        return await Promise.all(ids.map(id => gameData.data.Outfit.get(id)));
    }

    function contextFor(outfits: OutfitData[], planet: OutfitterStellar,
        owned: [string, number][] = []): OutfitterContext {
        const byId = new Map(outfits.map(o => [o.id, o]));
        const ship = getDefaultShipData();
        ship.physics = { ...ship.physics, freeMass: 1000 };
        return {
            shipData: ship,
            outfits: new Map(owned),
            getOutfit: id => byId.get(id),
            getWeapon: () => undefined,
            bits: new Set(),
            credits: Infinity,
            planet,
        };
    }

    /** Snowmelt (spöb 164): the low-tech world with one SpecialTech slot. */
    const snowmelt: OutfitterStellar = {
        techLevel: 2, specialTech: [81], buysAnyOutfit: false,
    };

    it('pins the exact outfit list a low-tech stock world shows', async () => {
        const outfits = await allOutfits();
        const visible = visibleOutfits(outfits, contextFor(outfits, snowmelt));

        // The five tech-1 outfits, plus "Map; Fed/Pol" via SpecialTech 81.
        // All six share DispWeight 16, so they order by ascending id.
        expect(visible.map(o => o.id)).toEqual([
            'nova:184', 'nova:185', 'nova:186', 'nova:187', 'nova:188',
            'nova:433',
        ]);
        expect(visible.map(o => o.name)).toEqual([
            'Gravimetric Sensors', 'IFF Decoder', 'Auto-recharger',
            'Auto-eject', 'Escape Pod', 'Map; Fed/Pol',
        ]);
    });

    it('admits the SpecialTech item only where the slot names it', async () => {
        const outfits = await allOutfits();
        const map = outfits.find(o => o.id === 'nova:433')!;
        expect(map.techLevel).toBe(81);

        // A tech-7 world (the highest base tech in stock data) without
        // SpecialTech 81 still does not reach a tech-81 item.
        const noSpecial: OutfitterStellar = {
            techLevel: 7, specialTech: [], buysAnyOutfit: false,
        };
        expect(visibleOutfits(outfits, contextFor(outfits, noSpecial))
            .map(o => o.id)).not.toContain('nova:433');
        expect(visibleOutfits(outfits, contextFor(outfits, snowmelt))
            .map(o => o.id)).toContain('nova:433');
    });

    it('hides the techLevel-0 Vell-os map that 0x4000 protects', async () => {
        const outfits = await allOutfits();
        const vellosMap = outfits.find(o => o.id === 'nova:342')!;
        // A naive `spob.techLevel >= outfit.techLevel` rule would put this
        // in almost every outfitter in the game; 0x4000 plus an
        // Availability of b9999 is what actually keeps it out.
        expect(vellosMap.techLevel).toBe(0);
        expect(vellosMap.hideUnlessAvailable).toBeTrue();
        expect(visibleOutfits(outfits, contextFor(outfits, snowmelt))
            .map(o => o.id)).not.toContain('nova:342');
    });

    it('pins Sirrusa: an outfitter that stocks nothing but buys anything',
        async () => {
            const outfits = await allOutfits();
            // spöb 156, the only stock stellar with Flags2 0x0400.
            const sirrusa: OutfitterStellar = {
                techLevel: 0, specialTech: [], buysAnyOutfit: true,
            };

            // Nothing for sale with an empty hold.
            expect(visibleOutfits(outfits, contextFor(outfits, sirrusa)))
                .toEqual([]);

            // But it buys a high-tech outfit it could never stock. Outfit
            // 137 is tech 7 and sellable; Sirrusa is tech 0.
            const highTech = outfits.find(o => o.id === 'nova:137')!;
            expect(highTech.techLevel).toBeGreaterThan(0);
            expect(highTech.cantSell).toBeFalse();
            expect(buysBackOutfit(highTech, sirrusa)).toBeTrue();
            expect(visibleOutfits(outfits,
                contextFor(outfits, sirrusa, [['nova:137', 1]]))
                .map(o => o.id)).toEqual(['nova:137']);

            // A tech-2 world without the flag will NOT buy that same item.
            expect(buysBackOutfit(highTech, snowmelt)).toBeFalse();
            expect(visibleOutfits(outfits,
                contextFor(outfits, snowmelt, [['nova:137', 1]]))
                .map(o => o.id)).not.toContain('nova:137');
        });

    it('finds every stock 0x1000 outfit already highest at its DispWeight',
        async () => {
            // All four stock excluders (280-283, the Polaris "fire whilst
            // cloaked" variants) are the highest-numbered item at their
            // DispWeight, so the rule suppresses NOTHING in stock data.
            // Stock pairs the variants off with mutually exclusive
            // Availability NCBs instead. If this ever fails, stock data was
            // misread and the exclusion needs re-checking against it.
            const outfits = await allOutfits();
            const excluders = outfits
                .filter(o => o.excludesEqualDisplayWeight)
                .map(o => o.id);
            expect(excluders).toEqual(
                ['nova:280', 'nova:281', 'nova:282', 'nova:283']);

            for (const excluder of outfits
                .filter(o => o.excludesEqualDisplayWeight)) {
                const higher = outfits.filter(o =>
                    o.displayWeight === excluder.displayWeight
                    && Number(o.id.split(':')[1])
                    > Number(excluder.id.split(':')[1]));
                expect(higher).toEqual([]);
            }
        });

    it('pins the stock outfit flag census the rules depend on', async () => {
        const outfits = await allOutfits();
        const count = (predicate: (o: OutfitData) => boolean) =>
            outfits.filter(predicate).length;
        expect(outfits.length).toBe(242);
        // 0x4000 is the dominant stocking mechanism in stock data (61% of
        // outfits): ignoring it would show far too much.
        expect(count(o => o.hideUnlessAvailable)).toBe(149);
        expect(count(o => o.hideUnlessRequirementsMet)).toBe(8);
        expect(count(o => o.sellAnywhere)).toBe(18);
        expect(count(o => o.excludesEqualDisplayWeight)).toBe(4);
        expect(count(o => o.cantSell)).toBe(40);
    });
});
