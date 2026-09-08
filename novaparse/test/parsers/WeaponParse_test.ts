import 'jasmine';
import { Resource } from 'resource_fork';
import { WeaponParse } from '../../src/parsers/WeaponParse';
import { WeapResource } from '../../src/resource_parsers/WeapResource';
import { OutfResource } from '../../src/resource_parsers/OutfResource';
import { getEmptyNovaResources } from '../../src/resource_parsers/ResourceHolderBase';
import { ammoOutfitIds } from 'novadatainterface/WeaponData';

// Exercise the real big-endian resource fields, not pre-decoded weapon mocks.
function weapon(ammo: number, guidance = 0, flags3 = 0): WeapResource {
    const data = new DataView(new ArrayBuffer(120));
    data.setInt16(8, guidance);
    data.setInt16(12, ammo);
    data.setInt16(14, 0);
    data.setInt16(18, -1);
    data.setInt16(22, -1);
    data.setUint16(28, 1); // Flags and Flags2 bit 0 must not control ammo consumption.
    data.setUint16(72, 1);
    data.setInt16(90, 3);
    data.setUint16(102, flags3);
    const result = new WeapResource(new Resource('wëap', 200, 'Test weapon', data), getEmptyNovaResources());
    result.globalID = 'plugin:200';
    result.prefix = 'plugin';
    result.idSpace.wëap[200] = result;
    if (ammo >= 0 && ammo <= 255 && guidance !== 99) {
        const supplyID = ammo + 128;
        const supply = new WeapResource(new Resource('wëap', supplyID, 'Ammo supply', data), result.idSpace);
        supply.globalID = `plugin:${supplyID}`;
        supply.prefix = 'plugin';
        result.idSpace.wëap[supplyID] = supply;
    }
    return result;
}

function outfit(weap: WeapResource, id: number, modifiers: Array<[number, number, number]>): OutfResource {
    const data = new DataView(new ArrayBuffer(560));
    for (const [offset, type, value] of modifiers) {
        data.setInt16(offset, type);
        data.setInt16(offset + 2, value);
    }
    const result = new OutfResource(new Resource('oütf', id, 'Test outfit', data), weap.idSpace);
    result.globalID = `ammo-plugin:${id}`;
    result.prefix = 'ammo-plugin';
    weap.idSpace.oütf[id] = result;
    return result;
}

describe('WeaponParse ammunition', () => {
    it('preserves unlimited and self-destruct as distinct behaviors', async () => {
        const report = jasmine.createSpy('report');
        for (const code of [-1, -999]) {
            const parsed = await WeaponParse(weapon(code), report);
            expect(parsed.ammoType).toBe('unlimited');
            expect(parsed.destroyShipWhenFiring).toBe(code === -999);
        }
        expect(report).not.toHaveBeenCalled();
    });

    it('converts the signed AmmoType to fuel units per shot, including fractional and zero costs', async () => {
        const report = jasmine.createSpy('report');
        // Bible p. 65: -1005 = 0.5; existing binary fixture: -1540 = 54.
        for (const [code, cost] of [[-1000, 0], [-1005, 0.5], [-1540, 54], [-32768, 3176.8]]) {
            for (const guidance of [0, 3, -1]) {
                const resource = weapon(code, guidance);
                resource.duration = 99;
                // Projectile graphics are unrelated to ammo; avoid missing-asset diagnostics.
                if (guidance === -1) {
                    resource.idSpace.spïn[3000] = {
                        idSpace: { rlëD: { 1: { globalID: 'sprite:1', numberOfFrames: 1 } } },
                        spriteID: 1,
                    } as unknown as typeof resource.idSpace.spïn[number];
                }
                const parsed = await WeaponParse(resource, report);
                expect(parsed.ammoType).toEqual(['energy', cost]);
                expect(parsed.destroyShipWhenFiring).toBeFalse();
            }
        }
        expect(report).not.toHaveBeenCalled();
    });

    it('reverse-links a weapon supply through every outfit modifier slot using global IDs', async () => {
        const report = jasmine.createSpy('report');
        for (const code of [0, 3, 255]) {
            for (const offset of [6, 18, 22, 26]) {
                const resource = weapon(code);
                outfit(resource, code + 128, [[6, 1, code + 128]]); // A launcher is not ammunition.
                const ammo = outfit(resource, 900, [[offset, 3, code + 128]]);
                expect((await WeaponParse(resource, report)).ammoType).toEqual(['outfit', ammo.globalID]);
            }
        }
        expect(report).not.toHaveBeenCalled();
    });

    it('does not count repeated matching slots on one outfit as ambiguity', async () => {
        const resource = weapon(3);
        const ammo = outfit(resource, 900, [[6, 3, 131], [26, 3, 131]]);
        const report = jasmine.createSpy('report');
        expect((await WeaponParse(resource, report)).ammoType).toEqual(['outfit', ammo.globalID]);
        expect(report).not.toHaveBeenCalled();
    });

    it('rejects missing links even with a non-throwing diagnostic callback', async () => {
        const resource = weapon(3);
        outfit(resource, 131, [[6, 3, 3]]); // ModVal is a full ID, not an index.
        const report = jasmine.createSpy('report');
        await expectAsync(WeaponParse(resource, report)).toBeRejectedWithError(
            'Missing ammunition oütf for wëap plugin:200 (AmmoType 3, ammo supply wëap 131): expected an oütf with ModType 3 and ModVal 131; restore the missing outfit or correct AmmoType/ModVal');
        expect(report).not.toHaveBeenCalled();
    });

    it('preserves alternative supply outfits with sorted, deduplicated global IDs', async () => {
        const resource = weapon(3);
        const second = outfit(resource, 901, [[18, 3, 131], [26, 3, 131]]);
        outfit(resource, 900, [[6, 3, 131]]);
        resource.idSpace.oütf[902] = second;
        const report = jasmine.createSpy('report');
        expect((await WeaponParse(resource, report)).ammoType).toEqual(
            ['outfits', ['ammo-plugin:900', 'ammo-plugin:901']]);
        expect(report).not.toHaveBeenCalled();
    });

    it('keeps a single canonical outfit when it is enumerated more than once', async () => {
        const resource = weapon(3);
        resource.idSpace.oütf[901] = outfit(resource, 900, [[6, 3, 131]]);
        expect((await WeaponParse(resource, () => {})).ammoType).toEqual(['outfit', 'ammo-plugin:900']);
    });

    it('excludes unrelated plug-in supplies with the same numeric weapon ID', async () => {
        const resource = weapon(3);
        const other = weapon(3);
        other.idSpace.wëap[131].globalID = 'other-plugin:131';
        const unrelated = outfit(other, 902, [[6, 3, 131]]);
        resource.idSpace.oütf[902] = unrelated;
        const matching = outfit(resource, 900, [[6, 3, 131]]);
        expect((await WeaponParse(resource, () => {})).ammoType).toEqual(['outfit', matching.globalID]);
        delete resource.idSpace.oütf[900];
        await expectAsync(WeaponParse(resource, () => {})).toBeRejectedWithError(/Missing ammunition oütf/);
    });

    it('accepts outfits from different plug-ins when they resolve to the same nova supply', async () => {
        const resource = weapon(3);
        resource.idSpace.wëap[131].globalID = 'nova:131';
        outfit(resource, 900, [[6, 3, 131]]);
        const other = weapon(3);
        other.idSpace.wëap[131].globalID = 'nova:131';
        const shared = outfit(other, 901, [[18, 3, 131]]);
        shared.globalID = 'other-plugin:901';
        resource.idSpace.oütf[901] = shared;
        expect((await WeaponParse(resource, () => {})).ammoType).toEqual(
            ['outfits', ['ammo-plugin:900', 'other-plugin:901']]);
    });

    it('exposes outfit IDs for all ammunition variants', () => {
        expect(ammoOutfitIds('unlimited')).toEqual([]);
        expect(ammoOutfitIds(['energy', 2])).toEqual([]);
        expect(ammoOutfitIds(['outfit', 'nova:135'])).toEqual(['nova:135']);
        const alternatives = ['nova:135', 'nova:325'];
        expect(ammoOutfitIds(['outfits', alternatives])).toBe(alternatives);
    });

    it('rejects undocumented ammo codes rather than granting unlimited ammo', async () => {
        for (const code of [-998, -2, 256, 32767]) {
            const report = jasmine.createSpy('report');
            await expectAsync(WeaponParse(weapon(code), report)).toBeRejectedWithError(
                `Unsupported AmmoType ${code} for wëap plugin:200: expected -1 (unlimited), -999 (self-destruct), <= -1000 (fuel), or 0..255 (weapon ammo supply); correct the resource AmmoType`);
            expect(report).not.toHaveBeenCalled();
        }
    });

    it('accepts the documented inclusive -1000 boundary as zero fuel, not unlimited', async () => {
        // Bible p. 65: "-1000 & below" uses "abs(AmmoType+1000)/10" fuel per shot.
        const report = jasmine.createSpy('report');
        expect((await WeaponParse(weapon(-1000), report)).ammoType).toEqual(['energy', 0]);
        expect(report).not.toHaveBeenCalled();
    });

    it('keeps fighter bay AmmoType as a ship ID rather than an ammo index', async () => {
        const resource = weapon(131, 99);
        resource.idSpace.shïp[131] = { globalID: 'ships:131' } as typeof resource.idSpace.shïp[number];
        const report = jasmine.createSpy('report');
        const parsed = await WeaponParse(resource, report);
        expect(parsed.ammoType).toBe('unlimited');
        expect(parsed.type).toBe('BayWeaponData');
        if (parsed.type === 'BayWeaponData') expect(parsed.shipID).toBe('ships:131');
        expect(report).not.toHaveBeenCalled();
    });

    it('reads only Flags3 bit 0 for oneAmmoPerBurst and preserves it even without a finite burst', async () => {
        for (const flags of [0, 1, 2, 0x8000, 0x8001]) {
            for (const count of [-1, 0, 3]) {
                const resource = weapon(-1, 0, flags);

                resource.burstCount = count;
                const parsed = await WeaponParse(resource, () => {});
                if (parsed.type === 'BayWeaponData') throw new Error('Expected non-bay weapon');
                expect(parsed.oneAmmoPerBurst).toBe((flags & 1) !== 0);
                expect(parsed.burstCount).toBe(Math.max(count, 0));
            }
        }
    });
});
