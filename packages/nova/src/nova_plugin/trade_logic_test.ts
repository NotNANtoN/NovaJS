import 'jasmine';
import { getDefaultJunkData, JunkData } from 'novadatainterface/junk_data';
import { getDefaultPlanetData, PlanetData, TradeTier } from 'novadatainterface/planet_data';
import {
    buyGood,
    freeCargoSpace,
    junkTradeGood,
    otherCargoNames,
    sellGood,
    standardTradeGoods,
    STANDARD_COMMODITY_BASE_PRICES,
    tierPrice,
    TradeGood,
    TradeWorkingState,
} from './trade_logic.js';

function makePlanet(tradeTiers: (TradeTier | null)[],
    rest: Partial<PlanetData> = {}): PlanetData {
    return { ...getDefaultPlanetData(), tradeTiers, ...rest };
}

function makeJunk(junk: Partial<JunkData>): JunkData {
    return { ...getDefaultJunkData(), ...junk };
}

function makeState({ cargo = [], credits = 10_000, capacity = 50 }: {
    cargo?: [string, number][],
    credits?: number,
    capacity?: number,
} = {}): TradeWorkingState {
    return {
        cargo: new Map(cargo),
        credits: { credits },
        cargoCapacity: capacity,
    };
}

const good = (overrides: Partial<TradeGood> = {}): TradeGood => ({
    key: 'cargo:0',
    name: 'Food',
    tier: 'med',
    price: 75,
    canBuy: true,
    canSell: true,
    ...overrides,
});

describe('tierPrice', () => {
    it('applies the Bible tier percentages to the base price', () => {
        // Medical (base 750): the trade_center screenshot's Low 600.
        expect(tierPrice(750, 'low')).toEqual(600);
        // Food (base 75): the screenshot's Med 75.
        expect(tierPrice(75, 'med')).toEqual(75);
        // Luxury goods (base 900): the screenshot's High 1125.
        expect(tierPrice(900, 'high')).toEqual(1125);
    });
});

describe('standardTradeGoods', () => {
    it('lists only commodities the stellar trades in, in STR# order', () => {
        // Earth: Food med, Industrial med, Medical low, Luxury high,
        // Metal med, no Equipment.
        const planet = makePlanet(['med', 'med', 'low', 'high', 'med', null]);
        const goods = standardTradeGoods(planet);
        expect(goods.map(g => g.key)).toEqual(
            ['cargo:0', 'cargo:1', 'cargo:2', 'cargo:3', 'cargo:4']);
        expect(goods.map(g => g.price)).toEqual([75, 350, 600, 1125, 200]);
        expect(goods.every(g => g.canBuy && g.canSell)).toBeTrue();
    });

    it('is empty for a stellar with no exchange tiers', () => {
        expect(standardTradeGoods(makePlanet(
            [null, null, null, null, null, null]))).toEqual([]);
    });

    it('uses the scenario cargo names (STR# 4000) when supplied', () => {
        const planet = makePlanet(['med', 'med', null, null, null, null]);
        const goods = standardTradeGoods(planet,
            ['Grain', 'Machinery', 'Medicine']);
        expect(goods.map(g => g.name)).toEqual(['Grain', 'Machinery']);
        // A gap in the supplied list falls back to the built-in name.
        const partial = standardTradeGoods(
            makePlanet(['med', null, null, null, null, 'med']), ['Grain']);
        expect(partial.map(g => g.name)).toEqual(['Grain', 'Equipment']);
    });
});

describe('junkTradeGood', () => {
    const junk = makeJunk({
        id: 'nova:128',
        name: 'Duranium Alloy',
        basePrice: 900,
        soldAt: ['nova:200'],
        boughtAt: ['nova:300'],
    });

    it('buys at the low tier where the jünk is sold', () => {
        const row = junkTradeGood(junk, 'nova:200', new Set());
        expect(row).toEqual(jasmine.objectContaining({
            key: 'junk:nova:128',
            tier: 'low',
            price: 720,
            canBuy: true,
            canSell: false,
        }));
    });

    it('sells at the high tier where the jünk is bought', () => {
        const row = junkTradeGood(junk, 'nova:300', new Set());
        expect(row).toEqual(jasmine.objectContaining({
            tier: 'high',
            price: 1125,
            canBuy: false,
            canSell: true,
        }));
    });

    it('is null where the jünk does not trade', () => {
        expect(junkTradeGood(junk, 'nova:400', new Set())).toBeNull();
    });

    it('gates buying on the BuyOn control-bit test', () => {
        const gated = makeJunk({ ...junk, buyOn: 'b3' });
        expect(junkTradeGood(gated, 'nova:200', new Set())).toBeNull();
        expect(junkTradeGood(gated, 'nova:200', new Set([3]))?.canBuy)
            .toBeTrue();
    });

    it('fails closed on a malformed NCB test', () => {
        const bad = makeJunk({ ...junk, sellOn: '((((' });
        expect(junkTradeGood(bad, 'nova:300', new Set())).toBeNull();
    });
});

describe('buyGood', () => {
    it('buys as many tons as fit and are affordable', () => {
        const state = makeState({ credits: 1000, capacity: 50 });
        // 1000 cr at 75/ton affords 13; space allows 50.
        expect(buyGood(state, good())).toEqual(13);
        expect(state.cargo.get('cargo:0')).toEqual(13);
        expect(state.credits.credits).toEqual(1000 - 13 * 75);
    });

    it('is limited by free cargo space including mission cargo', () => {
        const state = makeState({
            credits: 100_000, capacity: 50,
            cargo: [['mission:nova:128', 45]],
        });
        expect(buyGood(state, good())).toEqual(5);
        expect(freeCargoSpace(state)).toEqual(0);
    });

    it('buys nothing when broke or full', () => {
        expect(buyGood(makeState({ credits: 74 }), good())).toEqual(0);
        const full = makeState({ cargo: [['cargo:1', 50]], capacity: 50 });
        expect(buyGood(full, good())).toEqual(0);
        expect(full.credits.credits).toEqual(10_000);
    });

    it('never buys goods flagged unbuyable here', () => {
        const state = makeState();
        expect(buyGood(state, good({ canBuy: false }))).toEqual(0);
        expect(state.cargo.size).toEqual(0);
    });
});

describe('sellGood', () => {
    it('sells the whole held quantity at the row price', () => {
        const state = makeState({ cargo: [['cargo:0', 7]], credits: 0 });
        expect(sellGood(state, good())).toEqual(7);
        expect(state.cargo.has('cargo:0')).toBeFalse();
        expect(state.credits.credits).toEqual(7 * 75);
    });

    it('sells nothing when none is held or selling is barred', () => {
        expect(sellGood(makeState(), good())).toEqual(0);
        const state = makeState({ cargo: [['cargo:0', 7]] });
        expect(sellGood(state, good({ canSell: false }))).toEqual(0);
        expect(state.cargo.get('cargo:0')).toEqual(7);
    });

    it('never touches mission cargo (its key is never a trade row)', () => {
        const state = makeState({ cargo: [['mission:nova:128', 7]] });
        expect(sellGood(state, good())).toEqual(0);
        expect(state.cargo.get('mission:nova:128')).toEqual(7);
    });
});

describe('otherCargoNames', () => {
    it('reports mission cargo and non-tradeable junk', () => {
        const cargo = new Map([
            ['cargo:0', 5],
            ['mission:nova:128', 3],
            ['mission:nova:129', 2],
            ['junk:nova:130', 1],
        ]);
        expect(otherCargoNames(cargo, [good()])).toEqual(
            ['mission cargo', 'junk:nova:130']);
    });
});

describe('STANDARD_COMMODITY_BASE_PRICES', () => {
    it('matches the stock STR# 4004 base prices', () => {
        expect(STANDARD_COMMODITY_BASE_PRICES)
            .toEqual([75, 350, 750, 900, 200, 550]);
    });
});
