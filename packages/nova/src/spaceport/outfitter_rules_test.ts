import 'jasmine';
import { getDefaultOutfitData, OutfitData } from 'novadatainterface/outfit_data';
import { getDefaultShipData, ShipData } from 'novadatainterface/ship_data';
import { getDefaultProjectileWeaponData, WeaponData } from 'novadatainterface/weapon_data';
import {
    ammoCapacity,
    canBuyOutfit,
    canSellOutfit,
    effectiveMax,
    freeCargo,
    freeMass,
    OutfitterContext,
    playerContribute,
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

function makeContext({ ship, outfits, weapons, owned, bits }: {
    ship?: ShipData,
    outfits?: OutfitData[],
    weapons?: WeaponData[],
    owned?: [string, number][],
    bits?: number[],
} = {}): OutfitterContext {
    const outfitMap = new Map((outfits ?? []).map(o => [o.id, o]));
    const weaponMap = new Map((weapons ?? []).map(w => [w.id, w]));
    return {
        shipData: ship ?? makeShip(),
        outfits: new Map(owned ?? []),
        getOutfit: id => outfitMap.get(id),
        getWeapon: id => weaponMap.get(id),
        bits: new Set(bits ?? []),
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
