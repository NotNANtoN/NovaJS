import 'jasmine';
import { getDefaultOutfitData, OutfitData } from 'novadatainterface/outfit_data';
import { getDefaultShipData, ShipData } from 'novadatainterface/ship_data';
import { getDefaultProjectileWeaponData, WeaponData } from 'novadatainterface/weapon_data';
import {
    ammoCapacity,
    BULK_BUY_LIMIT,
    canBuyOutfit,
    canSellOutfit,
    effectiveMax,
    freeCargo,
    freeMass,
    maxBuyCount,
    maxSellCount,
    OUTFIT_RESALE_FRACTION,
    outfitResaleValue,
    OutfitterContext,
    playerContribute,
    sellRefund,
} from './outfitter_rules.js';

function makeShip(physics: Partial<ShipData['physics']> = {},
    rest: Partial<ShipData> = {}): ShipData {
    const ship = { ...getDefaultShipData(), ...rest };
    ship.physics = { ...ship.physics, freeMass: 100, ...physics };
    return ship;
}

function makeOutfit(id: string, outfit: Partial<OutfitData> = {},
    physics: Partial<OutfitData['physics']> = {}): OutfitData {
    return {
        ...getDefaultOutfitData(),
        id,
        ...outfit,
        physics: { freeMass: 0, ...physics },
    };
}

function makeWeapon(id: string, weapon: Partial<WeaponData> = {}): WeaponData {
    return { ...getDefaultProjectileWeaponData(), id, ...weapon } as WeaponData;
}

function makeContext({ ship, outfits, weapons, owned, bits, credits }: {
    ship?: ShipData,
    outfits?: OutfitData[],
    weapons?: WeaponData[],
    owned?: [string, number][],
    bits?: number[],
    credits?: number,
} = {}): OutfitterContext {
    const outfitMap = new Map((outfits ?? []).map(o => [o.id, o]));
    const weaponMap = new Map((weapons ?? []).map(w => [w.id, w]));
    return {
        shipData: ship ?? makeShip(),
        outfits: new Map(owned ?? []),
        getOutfit: id => outfitMap.get(id),
        getWeapon: id => weaponMap.get(id),
        bits: new Set(bits ?? []),
        // Default to effectively unlimited so tests that don't care about
        // money aren't gated by it (stock default outfit price is 0).
        credits: credits ?? Infinity,
    };
}

describe('freeMass', () => {
    it('subtracts the mass of owned outfits', () => {
        const heavy = makeOutfit('nova:200', {}, { freeMass: 10 });
        const context = makeContext({
            outfits: [heavy],
            owned: [['nova:200', 2]],
        });
        expect(freeMass(context)).toBe(80);
    });
});

describe('freeCargo', () => {
    it('applies outfit cargo modifications', () => {
        const expander = makeOutfit('nova:200', {}, { freeCargo: 15 });
        const context = makeContext({
            ship: makeShip({ freeCargo: 10 }),
            outfits: [expander],
            owned: [['nova:200', 1]],
        });
        expect(freeCargo(context)).toBe(25);
    });
});

describe('playerContribute', () => {
    it('unions the ship and outfit contribute sets', () => {
        const context = makeContext({
            ship: makeShip({}, { contribute: '0x1' }),
            outfits: [makeOutfit('nova:200', { contribute: '0x100000000' })],
            owned: [['nova:200', 1]],
        });
        expect(playerContribute(context)).toBe(0x100000001n);
    });
});

describe('canBuyOutfit', () => {
    it('allows a plain affordable outfit', () => {
        const outfit = makeOutfit('nova:200', {}, { freeMass: 10 });
        expect(canBuyOutfit(outfit, makeContext()))
            .toEqual({ allowed: true });
    });

    it('requires enough free mass', () => {
        const outfit = makeOutfit('nova:200', {}, { freeMass: 30 });
        const context = makeContext({
            ship: makeShip({ freeMass: 50 }),
            outfits: [outfit],
            owned: [['nova:200', 1]],
        });
        // 20 tons left; another 30-ton outfit doesn't fit.
        expect(canBuyOutfit(outfit, context)).toEqual(jasmine.objectContaining(
            { allowed: false, reason: 'mass' }));
    });

    it('requires a free gun hardpoint for fixed guns', () => {
        const gun = makeOutfit('nova:200', { fixedGun: true });
        const full = makeContext({
            ship: makeShip({ maxGuns: 2 }),
            outfits: [gun],
            owned: [['nova:200', 2]],
        });
        expect(canBuyOutfit(gun, full)).toEqual(jasmine.objectContaining(
            { allowed: false, reason: 'gunHardpoints' }));

        const oneFree = makeContext({
            ship: makeShip({ maxGuns: 2 }),
            outfits: [gun],
            owned: [['nova:200', 1]],
        });
        expect(canBuyOutfit(gun, oneFree)).toEqual({ allowed: true });
    });

    it('requires a free turret hardpoint for turrets', () => {
        const turret = makeOutfit('nova:200', { turret: true });
        const context = makeContext({
            ship: makeShip({ maxTurrets: 1 }),
            outfits: [turret],
            owned: [['nova:200', 1]],
        });
        expect(canBuyOutfit(turret, context)).toEqual(jasmine.objectContaining(
            { allowed: false, reason: 'turretHardpoints' }));
    });

    it('counts outfit-granted hardpoints', () => {
        const gun = makeOutfit('nova:200', { fixedGun: true });
        const rack = makeOutfit('nova:201', {}, { maxGuns: 1 });
        const context = makeContext({
            ship: makeShip({ maxGuns: 1 }),
            outfits: [gun, rack],
            owned: [['nova:200', 1], ['nova:201', 1]],
        });
        expect(canBuyOutfit(gun, context)).toEqual({ allowed: true });
    });

    it('enforces the max count', () => {
        const outfit = makeOutfit('nova:200', { max: 2 });
        const context = makeContext({
            outfits: [outfit],
            owned: [['nova:200', 2]],
        });
        expect(canBuyOutfit(outfit, context)).toEqual(jasmine.objectContaining(
            { allowed: false, reason: 'maxCount' }));
    });

    it('treats max 0 as unlimited', () => {
        const outfit = makeOutfit('nova:200', { max: 0 });
        const context = makeContext({
            outfits: [outfit],
            owned: [['nova:200', 500]],
        });
        expect(canBuyOutfit(outfit, context)).toEqual({ allowed: true });
    });

    it('multiplies max by owned increase-maximum items', () => {
        const outfit = makeOutfit('nova:200', { max: 2 });
        const booster = makeOutfit('nova:201', { increasesMax: 'nova:200' });
        const context = makeContext({
            outfits: [outfit, booster],
            owned: [['nova:200', 2], ['nova:201', 2]],
        });
        expect(effectiveMax(outfit, context)).toBe(4);
        expect(canBuyOutfit(outfit, context)).toEqual({ allowed: true });
    });

    it('enforces the availability control bit test', () => {
        const outfit = makeOutfit('nova:200', { availability: 'b13 & !b14' });
        expect(canBuyOutfit(outfit, makeContext({ bits: [13] })))
            .toEqual({ allowed: true });
        expect(canBuyOutfit(outfit, makeContext({ bits: [] })))
            .toEqual(jasmine.objectContaining(
                { allowed: false, reason: 'availability' }));
        expect(canBuyOutfit(outfit, makeContext({ bits: [13, 14] })))
            .toEqual(jasmine.objectContaining(
                { allowed: false, reason: 'availability' }));
    });

    it('lets availability check owned outfits with Oxxx', () => {
        const licensed = makeOutfit('nova:200', { availability: 'o300' });
        const license = makeOutfit('nova:300');
        expect(canBuyOutfit(licensed, makeContext({
            outfits: [license],
            owned: [['nova:300', 1]],
        }))).toEqual({ allowed: true });
        expect(canBuyOutfit(licensed, makeContext())).toEqual(
            jasmine.objectContaining(
                { allowed: false, reason: 'availability' }));
    });

    it('treats a malformed availability expression as available', () => {
        const outfit = makeOutfit('nova:200', { availability: 'b13 &' });
        expect(canBuyOutfit(outfit, makeContext()))
            .toEqual({ allowed: true });
    });

    it('requires the player contribute bits to cover the require bits', () => {
        const outfit = makeOutfit('nova:200', { require: '0x3' });
        const partial = makeContext({
            ship: makeShip({}, { contribute: '0x1' }),
        });
        expect(canBuyOutfit(outfit, partial)).toEqual(jasmine.objectContaining(
            { allowed: false, reason: 'require' }));

        const covering = makeContext({
            ship: makeShip({}, { contribute: '0x1' }),
            outfits: [makeOutfit('nova:201', { contribute: '0x2' })],
            owned: [['nova:201', 1]],
        });
        expect(canBuyOutfit(outfit, covering)).toEqual({ allowed: true });
    });

    describe('launcher-restricted ammunition', () => {
        // A launcher weapon that draws 15 rounds per instance from its
        // own supply, the outfit that grants it, and its ammo outfit.
        const launcherWeapon = makeWeapon('nova:134', {
            ammoType: ['weapon', 'nova:134'],
            maxAmmo: 15,
        });
        const launcher = makeOutfit('nova:133', {
            weapons: { 'nova:134': 1 },
        });
        const ammo = makeOutfit('nova:135', {
            max: 200,
            ammoFor: 'nova:134',
        });

        it('denies ammo without a launcher', () => {
            const context = makeContext({
                outfits: [launcher, ammo],
                weapons: [launcherWeapon],
            });
            expect(ammoCapacity(ammo, context)).toBe(0);
            expect(canBuyOutfit(ammo, context)).toEqual(
                jasmine.objectContaining(
                    { allowed: false, reason: 'needsLauncher' }));
        });

        it('caps ammo at maxAmmo per owned launcher', () => {
            const oneLauncher = makeContext({
                outfits: [launcher, ammo],
                weapons: [launcherWeapon],
                owned: [['nova:133', 1], ['nova:135', 14]],
            });
            expect(ammoCapacity(ammo, oneLauncher)).toBe(15);
            expect(canBuyOutfit(ammo, oneLauncher))
                .toEqual({ allowed: true });

            const full = makeContext({
                outfits: [launcher, ammo],
                weapons: [launcherWeapon],
                owned: [['nova:133', 1], ['nova:135', 15]],
            });
            expect(canBuyOutfit(ammo, full)).toEqual(
                jasmine.objectContaining(
                    { allowed: false, reason: 'needsLauncher' }));

            const twoLaunchers = makeContext({
                outfits: [launcher, ammo],
                weapons: [launcherWeapon],
                owned: [['nova:133', 2], ['nova:135', 15]],
            });
            expect(ammoCapacity(ammo, twoLaunchers)).toBe(30);
            expect(canBuyOutfit(ammo, twoLaunchers))
                .toEqual({ allowed: true });
        });

        it('freely sells ammo whose weapon has no maxAmmo', () => {
            // MaxAmmo <= 0: constrained by the outfit's Max field
            // instead, so no launcher is needed.
            const freeAmmoWeapon = makeWeapon('nova:134', {
                ammoType: ['weapon', 'nova:134'],
                maxAmmo: 0,
            });
            const context = makeContext({
                outfits: [launcher, ammo],
                weapons: [freeAmmoWeapon],
            });
            expect(ammoCapacity(ammo, context)).toBeUndefined();
            expect(canBuyOutfit(ammo, context)).toEqual({ allowed: true });
        });
    });

    it('requires enough cargo space for cargo-consuming outfits', () => {
        const scoop = makeOutfit('nova:200', {}, { freeCargo: -10 });
        expect(canBuyOutfit(scoop, makeContext({
            ship: makeShip({ freeCargo: 5 }),
        }))).toEqual(jasmine.objectContaining(
            { allowed: false, reason: 'cargo' }));
        expect(canBuyOutfit(scoop, makeContext({
            ship: makeShip({ freeCargo: 20 }),
        }))).toEqual({ allowed: true });
    });

    it('requires enough credits to afford the item', () => {
        const outfit = makeOutfit('nova:200', { price: 5000 });
        expect(canBuyOutfit(outfit, makeContext({ credits: 4999 })))
            .toEqual(jasmine.objectContaining(
                { allowed: false, reason: 'credits' }));
        // Exactly the price is affordable.
        expect(canBuyOutfit(outfit, makeContext({ credits: 5000 })))
            .toEqual({ allowed: true });
    });

    it('lets a free outfit be bought with zero credits', () => {
        const free = makeOutfit('nova:200', { price: 0 });
        expect(canBuyOutfit(free, makeContext({ credits: 0 })))
            .toEqual({ allowed: true });
    });
});

describe('outfitResaleValue', () => {
    it('is 50% of the outfit price (Matthew\'s rule)', () => {
        expect(OUTFIT_RESALE_FRACTION).toBe(0.5);
        expect(outfitResaleValue(makeOutfit('nova:200', { price: 5000 })))
            .toBe(2500);
    });

    it('floors fractional halves', () => {
        expect(outfitResaleValue(makeOutfit('nova:200', { price: 4001 })))
            .toBe(2000); // 2000.5 floored.
    });
});

describe('sellRefund (same-visit full refund)', () => {
    const outfit = makeOutfit('nova:200', { price: 5000 });

    it('refunds the full price for a unit bought this visit', () => {
        expect(sellRefund(outfit, 1))
            .toEqual({ credited: 5000, boughtThisVisit: 0 });
    });

    it('falls back to the 50% resale for a pre-owned unit', () => {
        expect(sellRefund(outfit, 0))
            .toEqual({ credited: 2500, boughtThisVisit: 0 });
    });

    it('drains same-visit purchases first, then pre-owned (bulk split)', () => {
        // Bought 3 this visit, selling 5: 3 full refunds then 2 at 50%.
        let boughtThisVisit = 3;
        const credited: number[] = [];
        for (let i = 0; i < 5; i++) {
            const refund = sellRefund(outfit, boughtThisVisit);
            credited.push(refund.credited);
            boughtThisVisit = refund.boughtThisVisit;
        }
        expect(credited).toEqual([5000, 5000, 5000, 2500, 2500]);
        expect(boughtThisVisit).toBe(0);
    });

    it('treats a reset visit (count 0) as entirely pre-owned', () => {
        // After the outfitter closes, visitPurchases resets to 0, so a
        // later re-entry sells everything at the 50% resale value.
        expect(sellRefund(outfit, 0).credited).toBe(2500);
    });
});

describe('canSellOutfit', () => {
    it('requires owning the outfit', () => {
        const outfit = makeOutfit('nova:200');
        expect(canSellOutfit(outfit, makeContext())).toEqual(
            jasmine.objectContaining({ allowed: false, reason: 'notOwned' }));
    });

    it('denies selling unsellable outfits', () => {
        const outfit = makeOutfit('nova:200', { cantSell: true });
        const context = makeContext({
            outfits: [outfit],
            owned: [['nova:200', 1]],
        });
        expect(canSellOutfit(outfit, context)).toEqual(
            jasmine.objectContaining({ allowed: false, reason: 'cantSell' }));
    });

    it('allows selling owned sellable outfits', () => {
        const outfit = makeOutfit('nova:200');
        const context = makeContext({
            outfits: [outfit],
            owned: [['nova:200', 1]],
        });
        expect(canSellOutfit(outfit, context)).toEqual({ allowed: true });
    });
});

describe('maxBuyCount', () => {
    it('is limited by the ship\'s free mass', () => {
        const outfit = makeOutfit('nova:200', {}, { freeMass: 30 });
        const context = makeContext({ outfits: [outfit] });
        // 100 tons free / 30 per unit = 3.
        expect(maxBuyCount(outfit, context)).toBe(3);
        // The simulation must not mutate the real outfit list.
        expect(context.outfits.get('nova:200')).toBeUndefined();
    });

    it('is limited by the effective Max including owned units', () => {
        const outfit = makeOutfit('nova:200', { max: 5 });
        const context = makeContext({
            outfits: [outfit],
            owned: [['nova:200', 3]],
        });
        expect(maxBuyCount(outfit, context)).toBe(2);
    });

    it('is zero when the availability test fails', () => {
        const outfit = makeOutfit('nova:200', { availability: 'b1' });
        expect(maxBuyCount(outfit, makeContext({ outfits: [outfit] })))
            .toBe(0);
    });

    it('caps effectively unlimited outfits at the bulk limit', () => {
        const outfit = makeOutfit('nova:200'); // No mass, no Max.
        const context = makeContext({ outfits: [outfit] });
        expect(maxBuyCount(outfit, context)).toBe(BULK_BUY_LIMIT);
        expect(maxBuyCount(outfit, context, 25)).toBe(25);
    });

    it('is limited by affordability (floor(credits/price))', () => {
        const outfit = makeOutfit('nova:200', { price: 1000 });
        // 3500 credits / 1000 each = 3 affordable.
        expect(maxBuyCount(outfit, makeContext({
            outfits: [outfit], credits: 3500,
        }))).toBe(3);
        // Exactly enough for 4.
        expect(maxBuyCount(outfit, makeContext({
            outfits: [outfit], credits: 4000,
        }))).toBe(4);
        // Can't afford even one.
        expect(maxBuyCount(outfit, makeContext({
            outfits: [outfit], credits: 999,
        }))).toBe(0);
    });

    it('takes the tighter of the mass and affordability bounds', () => {
        const outfit = makeOutfit('nova:200', { price: 1000 }, { freeMass: 30 });
        // Mass allows 3 (100/30), but credits only cover 2.
        expect(maxBuyCount(outfit, makeContext({
            outfits: [outfit], credits: 2500,
        }))).toBe(2);
    });

    it('is limited by launcher ammo capacity', () => {
        const launcherWeapon = makeWeapon('nova:300', {
            maxAmmo: 4,
            ammoType: ['weapon', 'nova:300'],
        });
        const launcher = makeOutfit('nova:201',
            { weapons: { 'nova:300': 1 } });
        const ammo = makeOutfit('nova:202', { ammoFor: 'nova:300' });
        const context = makeContext({
            outfits: [launcher, ammo],
            weapons: [launcherWeapon],
            owned: [['nova:201', 1], ['nova:202', 1]],
        });
        expect(maxBuyCount(ammo, context)).toBe(3);
    });
});

describe('maxSellCount', () => {
    it('is everything owned for a sellable outfit', () => {
        const outfit = makeOutfit('nova:200');
        const context = makeContext({
            outfits: [outfit],
            owned: [['nova:200', 7]],
        });
        expect(maxSellCount(outfit, context)).toBe(7);
    });

    it('is zero for unsellable or unowned outfits', () => {
        const unsellable = makeOutfit('nova:200', { cantSell: true });
        const context = makeContext({
            outfits: [unsellable],
            owned: [['nova:200', 7]],
        });
        expect(maxSellCount(unsellable, context)).toBe(0);
        const unowned = makeOutfit('nova:201');
        expect(maxSellCount(unowned, context)).toBe(0);
    });
});
