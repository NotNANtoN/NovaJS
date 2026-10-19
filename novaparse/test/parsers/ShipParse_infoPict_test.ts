import 'jasmine';
import { resolveShipInfoPict, ShipParse } from '../../src/parsers/ShipParse';
import { getEmptyNovaResources } from '../../src/resource_parsers/ResourceHolderBase';
import { ShipResource } from '../../src/resource_parsers/ShipResource';

describe('resolveShipInfoPict', () => {
    it('maps desc.graphic through the ship PICT table', () => {
        const ship = {
            idSpace: {
                PICT: {
                    4214: { globalID: 'nova:4214' },
                },
            },
        } as unknown as ShipResource;
        expect(resolveShipInfoPict(ship, { graphic: 4214 }))
            .toEqual('nova:4214');
    });

    it('returns null when graphic is unset or missing', () => {
        const ship = {
            idSpace: { PICT: {} },
        } as unknown as ShipResource;
        expect(resolveShipInfoPict(ship, undefined)).toBeNull();
        expect(resolveShipInfoPict(ship, { graphic: 0 })).toBeNull();
        expect(resolveShipInfoPict(ship, { graphic: 99 })).toBeNull();
    });

    it('includes built-in weapon ammunition (w.ammo) in parsed ship outfits and keeps energyRecharge finite when FuelRegen is 0', async () => {
        const idSpace = getEmptyNovaResources();
        idSpace.wëap[155] = {
            globalID: 'nova:155',
            guidance: 'unguided',
            ammoType: 27, // 27 + 128 = 155 (Hail Chaingun)
            idSpace,
        } as any;
        idSpace.oütf[169] = {
            globalID: 'nova:169',
            mass: 5,
            functions: [['weapon', 155]],
            idSpace,
        } as any;
        idSpace.oütf[170] = {
            globalID: 'nova:170',
            mass: 0,
            functions: [['ammunition', 155]],
            idSpace,
        } as any;
        const globalSpace = getEmptyNovaResources();
        globalSpace.oütf['nova:169' as any] = idSpace.oütf[169];
        globalSpace.oütf['nova:170' as any] = idSpace.oütf[170];

        const ship = {
            id: 155,
            globalID: 'nova:155',
            name: 'Firebird',
            prefix: 'nova',
            pictID: 5027,
            targetPictID: 3027,
            descID: 13027,
            initialExplosion: null,
            finalExplosion: null,
            finalExplosionSparks: false,
            outfits: [],
            weapons: [{ id: 155, count: 2, ammo: 50 }],
            freeSpace: 20,
            shield: 180,
            shieldRecharge: 25,
            armor: 100,
            armorRecharge: 0,
            fuelCapacity: 300,
            energyRecharge: 0,
            ionization: 100,
            deionize: 10,
            speed: 300,
            acceleration: 350,
            turnRate: 40,
            flags2N: 0,
            mass: 60,
            cargoSpace: 15,
            deathDelay: 10,
            maxGuns: 4,
            maxTurrets: 1,
            techLevel: 5,
            cost: 120000,
            displayOrder: 50,
            inherentAI: 3,
            crew: 2,
            strength: 30,
            inherentGovt: 129,
            flagsN: 0,
            flags3: 0,
            availabilityNCB: '',
            appearOn: '',
            onPurchase: '',
            onCapture: '',
            onRetire: '',
            contribute: [0, 0],
            require: [0, 0],
            buyRandom: 100,
            hireRandom: 50,
            subtitle: 'Fighter',
            shortName: 'Firebird',
            commName: 'Firebird',
            longName: 'Auroran Firebird',
            escortType: -1,
            upgradeTo: -1,
            escUpgrdCost: 0,
            escSellValue: 0,
            idSpace,
        } as unknown as ShipResource;

        const parsed = await ShipParse(
            ship,
            () => {},
            Promise.resolve({}),
            Promise.resolve({}),
            Promise.resolve({ 'nova:155': 'nova:169' }),
            Promise.resolve(globalSpace),
        );

        expect(parsed.outfits['nova:169']).toBe(2);
        expect(parsed.outfits['nova:170']).toBe(50);
        expect(parsed.physics.energyRecharge).toBe(0);
    });
});
