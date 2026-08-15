import 'jasmine';
import { getDefaultShipData, ShipData } from 'novadatainterface/ship_data';
import {
    buyRandomDayRoll,
    canBuyShip,
    compareShipIds,
    playerContribute,
    shipAvailabilityPasses,
    shipAvailableForSale,
    shipBuyRandomPasses,
    shipRequirementsMet,
    ShipyardContext,
    visibleShips,
} from './shipyard_stock_rules.js';

function makeShip(id: string, ship: Partial<ShipData> = {}): ShipData {
    // Ships default to "for sale every day" (buyRandom 100) unless a test
    // overrides it, so the tech/availability/require specs aren't tripped by
    // the data default (buyRandom 0 = never available).
    return { ...getDefaultShipData(), id, buyRandom: 100, ...ship };
}

function makeContext(ship: ShipData,
    ctx: Partial<ShipyardContext> = {}): ShipyardContext {
    void ship;
    return {
        bits: new Set(),
        contribute: 0n,
        day: 0,
        stellarId: 1,
        ...ctx,
    };
}

const STELLAR_TECH_5 = { techLevel: 5, specialTech: [] };

describe('shipStocked / tech level', () => {
    it('stocks ships at or below the stellar tech level', () => {
        const stellar = { techLevel: 5, specialTech: [88] };
        const viper = makeShip('nova:128', { techLevel: 4 });
        const leviathan = makeShip('nova:131', { techLevel: 88 });
        // techLevel 88 is a SpecialTech of this stellar — a low-tech
        // world that also carries one absurdly high-tech ship (the Bible's
        // own example). The Leviathan appears only there.
        expect(canBuyShip(viper, makeContext(viper, {
            planet: stellar })).allowed).toBeTrue();
        expect(canBuyShip(leviathan, makeContext(leviathan, {
            planet: stellar })).allowed).toBeTrue();
    });

    it('refuses ships beyond the stellar tech level', () => {
        const beyond = makeShip('nova:999', { techLevel: 999 });
        const check = canBuyShip(beyond, makeContext(beyond, {
            planet: STELLAR_TECH_5 }));
        expect(check.allowed).toBeFalse();
        expect(check.allowed ? '' : check.reason).toBe('notStocked');
    });

    it('stocks everything with no planet context', () => {
        const exotic = makeShip('nova:999', { techLevel: 9999 });
        expect(canBuyShip(exotic, makeContext(exotic)).allowed).toBeTrue();
    });
});

describe('shipAvailabilityPasses', () => {
    it('passes a blank Availability', () => {
        const ship = makeShip('nova:128', { availability: '' });
        expect(shipAvailabilityPasses(ship, makeContext(ship))).toBeTrue();
    });

    it('reads control bits from the context', () => {
        const ship = makeShip('nova:128', { availability: 'b3 & P30' });
        expect(shipAvailabilityPasses(ship, makeContext(ship, {
            bits: new Set([3]) }))).toBeTrue();
        expect(shipAvailabilityPasses(ship, makeContext(ship)))
            .toBeFalse();
        // P30 (registered) defaults true in the NCB evaluator.
    });
});

describe('shipRequirementsMet', () => {
    it('passes an empty Require', () => {
        expect(shipRequirementsMet('0x0', 0n)).toBeTrue();
    });

    it('ANDs Require against the Contribute set', () => {
        const require = '0x30'; // bits 4,5
        expect(shipRequirementsMet(require, 0x10n | 0x20n)).toBeTrue();
        expect(shipRequirementsMet(require, 0x20n)).toBeFalse();
    });

    it('unions the ship and outfit Contribute sets', () => {
        // The player flies a hull contributing bit 4 and carries an outfit
        // contributing bit 5; together they meet Require bits 4,5.
        const contribute = playerContribute('0x10',
            new Map([['nova:200', '0x20']]));
        expect(shipRequirementsMet('0x30', contribute)).toBeTrue();
        expect(shipRequirementsMet('0x80', contribute)).toBeFalse();
    });
});

describe('shipBuyRandomPasses', () => {
    it('always passes buyRandom 100', () => {
        const ship = makeShip('nova:128', { buyRandom: 100 });
        expect(shipBuyRandomPasses(ship, makeContext(ship)))
            .toBeTrue();
    });

    it('never passes buyRandom 0', () => {
        const ship = makeShip('nova:128', { buyRandom: 0 });
        expect(shipBuyRandomPasses(ship, makeContext(ship)))
            .toBeFalse();
    });

    it('always passes a partial BuyRandom while the day roll is off', () => {
        // The day roll is currently disabled (BUY_RANDOM_DAY_ROLL_ENABLED
        // is false; Matthew 2026-08-14): any nonzero BuyRandom is for sale
        // every day. Re-enabling the roll should fail this spec so the
        // flip is a deliberate, test-visible change.
        const ship = makeShip('nova:131', { buyRandom: 45 });
        for (const day of [0, 1, 100, 4321]) {
            expect(shipBuyRandomPasses(ship, makeContext(ship, {
                day, stellarId: 472 }))).toBeTrue();
        }
    });

    // The roll mechanism itself stays under test while the switch is off,
    // via the exported buyRandomDayRoll.
    it('day roll is deterministic: same inputs, same result', () => {
        const ship = makeShip('nova:131', { buyRandom: 45 });
        const a = buyRandomDayRoll(ship, makeContext(ship, {
            day: 200, stellarId: 472 }));
        // Recompute; the hash is pure, so it must agree.
        const b = buyRandomDayRoll(ship, makeContext(ship, {
            day: 200, stellarId: 472 }));
        expect(a).toBe(b);
    });

    it('day roll varies by day for a partial BuyRandom', () => {
        // A 45% ship spread over many days must not roll under 45 every day.
        const ship = makeShip('nova:131', { buyRandom: 45 });
        const daysOpen: number[] = [];
        for (let day = 0; day < 500; day++) {
            if (buyRandomDayRoll(ship, makeContext(ship, {
                day, stellarId: 472 })) < 45) {
                daysOpen.push(day);
            }
        }
        // It should be open on a reasonable minority of days (say 5-80%):
        // an assertion that would catch a "always open" or "always closed"
        // regression while leaving the exact FNV schedule free.
        expect(daysOpen.length).toBeGreaterThan(500 * 0.05);
        expect(daysOpen.length).toBeLessThan(500 * 0.8);
    });

    it('day roll is independent of which player visits', () => {
        // The daily roll is a property of ship+shipyard+day, not the
        // player: two contexts that differ only in control bits agree.
        const ship = makeShip('nova:131', { buyRandom: 45 });
        const plain = buyRandomDayRoll(ship, makeContext(ship, {
            day: 100, stellarId: 472 }));
        const rich = buyRandomDayRoll(ship, makeContext(ship, {
            day: 100, stellarId: 472,
            bits: new Set([1, 2, 3, 4, 5]) }));
        expect(plain).toBe(rich);
    });

    it('never uses Math.random or Date.now', () => {
        // Spy to prove the module is deterministic.
        spyOn(Math, 'random').and.callThrough();
        spyOn(Date, 'now').and.callThrough();
        const ship = makeShip('nova:131', { buyRandom: 45 });
        for (let day = 0; day < 30; day++) {
            shipBuyRandomPasses(ship, makeContext(ship, {
                day, stellarId: 472 }));
            buyRandomDayRoll(ship, makeContext(ship, {
                day, stellarId: 472 }));
        }
        expect(Math.random).not.toHaveBeenCalled();
        expect(Date.now).not.toHaveBeenCalled();
    });
});

describe('canBuyShip', () => {
    it('refuses when Availability is false', () => {
        const ship = makeShip('nova:131', { availability: 'b9' });
        const check = canBuyShip(ship, makeContext(ship, {
            planet: STELLAR_TECH_5 }));
        expect(check.allowed).toBeFalse();
        expect(check.allowed ? '' : check.reason).toBe('availability');
    });

    it('refuses a never-sold (BuyRandom 0) ship even with the day roll off',
        () => {
            const ship = makeShip('nova:131', { buyRandom: 0 });
            const check = canBuyShip(ship, makeContext(ship, {
                planet: STELLAR_TECH_5 }));
            expect(check.allowed).toBeFalse();
            expect(check.allowed ? '' : check.reason)
                .toBe('notAvailableToday');
            // Permanent "never sold", not a bad day: no "today".
            expect(check.allowed ? '' : check.message)
                .toBe('This ship isn\'t for sale.');
        });

    it('refuses when Require is unmet', () => {
        const ship = makeShip('nova:131', { require: '0x10' });
        const check = canBuyShip(ship, makeContext(ship, {
            planet: STELLAR_TECH_5, contribute: 0n }));
        expect(check.allowed).toBeFalse();
        expect(check.allowed ? '' : check.reason).toBe('require');
    });

    it('allows a fully-qualified ship', () => {
        const ship = makeShip('nova:128', {
            techLevel: 4, buyRandom: 100, availability: 'b3',
        });
        const ctx = makeContext(ship, {
            planet: STELLAR_TECH_5, bits: new Set([3]) });
        expect(canBuyShip(ship, ctx).allowed).toBeTrue();
    });
});

describe('Flags3 0x4000 equal-DispWeight exclusion', () => {
    it('hides higher-numbered ships of equal DispWeight when the excluder '
        + 'is available for sale', () => {
        // Ship A (lower id) shares DispWeight with ship B (higher id), and
        // A carries 0x4000. When A is for sale, B must be excluded.
        const a = makeShip('nova:130', {
            displayWeight: 100,
            excludeEqualDisplayWeight: true,
            buyRandom: 100, techLevel: 3 });
        const b = makeShip('nova:131', {
            displayWeight: 100, techLevel: 3, buyRandom: 100 });
        const c = makeShip('nova:132', {
            displayWeight: 99, techLevel: 3, buyRandom: 100 });
        const ctx = makeContext(a, { planet: STELLAR_TECH_5 });
        const list = visibleShips([c, b, a], ctx).map(s => s.id);
        expect(list).toContain('nova:130');
        // B is hidden (equal DispWeight, higher id, excluder for sale).
        expect(list).not.toContain('nova:131');
        // C has a different DispWeight, so it is not affected.
        expect(list).toContain('nova:132');
    });

    it('does not hide anything when the excluder is NOT for sale today',
        () => {
            const a = makeShip('nova:130', {
                displayWeight: 100,
                excludeEqualDisplayWeight: true,
                buyRandom: 0, techLevel: 3 });
            const b = makeShip('nova:131', {
                displayWeight: 100, techLevel: 3, buyRandom: 100 });
            const ctx = makeContext(a, {
                planet: STELLAR_TECH_5 });
            const list = visibleShips([b, a], ctx).map(s => s.id);
            expect(list).toContain('nova:131');
        });
});

describe('visibleShips', () => {
    it('sorts by DispWeight descending, ties by id ascending', () => {
        const low = makeShip('nova:128', { displayWeight: 5 });
        const high = makeShip('nova:129', { displayWeight: 10 });
        const sameHigh = makeShip('nova:130', { displayWeight: 10 });
        const list = visibleShips(
            [low, sameHigh, high],
            makeContext(low, { planet: STELLAR_TECH_5 }))
            .map(s => s.id);
        expect(list).toEqual(['nova:129', 'nova:130', 'nova:128']);
    });

    it('hides when Flags3 0x0100 is set and Availability is false', () => {
        const ship = makeShip('nova:131', {
            availability: 'b9',
            hideIfAvailabilityFalse: true });
        const list = visibleShips([ship], makeContext(ship, {
            planet: STELLAR_TECH_5 }));
        expect(list.map(s => s.id)).not.toContain('nova:131');
    });

    it('shows greyed when Availability is false without 0x0100', () => {
        const ship = makeShip('nova:141', {
            availability: 'b78', techLevel: 14 });
        const list = visibleShips([ship], makeContext(ship, {
            planet: { techLevel: 20, specialTech: [] } }));
        // Still listed (greyed, purchase refused).
        expect(list.map(s => s.id)).toContain('nova:141');
    });

    it('hides when Flags3 0x0200 is set and Require is unmet', () => {
        const ship = makeShip('nova:131', {
            require: '0x10', hideIfRequireUnmet: true });
        const list = visibleShips([ship], makeContext(ship, {
            planet: STELLAR_TECH_5, contribute: 0n }));
        expect(list.map(s => s.id)).not.toContain('nova:131');
    });

    it('shows greyed when Require is unmet without 0x0200', () => {
        const ship = makeShip('nova:131', { require: '0x10' });
        const list = visibleShips([ship], makeContext(ship, {
            planet: STELLAR_TECH_5, contribute: 0n }));
        expect(list.map(s => s.id)).toContain('nova:131');
    });
});

describe('compareShipIds', () => {
    it('orders by numeric resource id across prefixes', () => {
        expect(compareShipIds('nova:128', 'nova:129')).toBeLessThan(0);
        expect(compareShipIds('nova:129', 'nova:128')).toBeGreaterThan(0);
        // Non-numeric ids sort last.
        expect(compareShipIds('mod:abc', 'nova:1')).toBeGreaterThan(0);
    });
});

describe('shipAvailableForSale', () => {
    it('requires tech, availability, require and the day roll', () => {
        const ship = makeShip('nova:128', {
            techLevel: 4, availability: 'b3', require: '0x10',
            buyRandom: 100 });
        const ctx = makeContext(ship, {
            planet: STELLAR_TECH_5, bits: new Set([3]),
            contribute: 0x10n });
        expect(shipAvailableForSale(ship, ctx)).toBeTrue();
        // Withhold the require bit -> not for sale.
        const unmet = makeContext(ship, {
            planet: STELLAR_TECH_5, bits: new Set([3]),
            contribute: 0n });
        expect(shipAvailableForSale(ship, unmet)).toBeFalse();
    });
});
