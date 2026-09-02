import 'jasmine';
import { getDefaultOutfitData } from 'novadatainterface/OutfitData';
import {
    getDefaultProjectileWeaponData,
} from 'novadatainterface/WeaponData';
import {
    ShipTurnRateConversionFactor,
    ShipVelocityConversionFactor,
} from 'novaparse/src/parsers/Constants';
import {
    formatMaxSlots,
    pictDisplayScale,
    qualitativeRating,
    sampleShipForInfoTests,
    shipyardInfoLeftColumn,
    shipyardInfoMiddleColumn,
    shipyardInfoPictId,
    shipyardInfoTitle,
    standardWeaponsLines,
} from './shipyard_info_content';

describe('shipyard info qualitative ratings', () => {
    it('maps raw bible-ish values to retail bands', () => {
        expect(qualitativeRating(149)).toEqual('Feeble');
        expect(qualitativeRating(150)).toEqual('Poor');
        expect(qualitativeRating(349)).toEqual('Average');
        expect(qualitativeRating(549)).toEqual('Very Good');
        expect(qualitativeRating(550)).toEqual('Excellent');
    });
});

describe('shipyard info title and pict', () => {
    it('prefers trimmed longName with displayName stripping', () => {
        expect(shipyardInfoTitle(sampleShipForInfoTests()))
            .toEqual('Shuttle');
    });

    it('falls back to ship name when longName is empty', () => {
        expect(shipyardInfoTitle(sampleShipForInfoTests({ longName: '' })))
            .toEqual('Shuttle');
    });

    it('uses infoPict when present and falls back to pict', () => {
        expect(shipyardInfoPictId(sampleShipForInfoTests()))
            .toEqual('nova:9001');
        expect(shipyardInfoPictId(sampleShipForInfoTests({ infoPict: null })))
            .toEqual('nova:5000');
    });
});

describe('shipyard info spec columns', () => {
    it('renders left and middle columns from ship data', () => {
        const ship = sampleShipForInfoTests();
        const left = shipyardInfoLeftColumn(ship);
        expect(left).toContain(`Speed: ${
            Math.round(ship.physics.speed / ShipVelocityConversionFactor)}`);
        expect(left).toContain(`Accel: ${
            qualitativeRating(ship.physics.acceleration / ShipVelocityConversionFactor)}`);
        expect(left).toContain(`Turn: ${
            qualitativeRating(ship.physics.turnRate / ShipTurnRateConversionFactor)}`);
        expect(left).toContain(`Guns: ${formatMaxSlots(ship.maxGuns)}`);
        expect(left).toContain('Turrets: None');

        const middle = shipyardInfoMiddleColumn(ship);
        expect(middle).toContain('Space: 40 tons');
        expect(middle).toContain('Cargo: 20 tons');
        expect(middle).toContain('Energy: 5 jumps');
        expect(middle).toContain('Length: 12 metres');
        expect(middle).toContain('Crew: 2');
    });

    it('never scales pict art up, only down', () => {
        expect(pictDisplayScale(200, 100)).toEqual(1);
        expect(pictDisplayScale(1180, 800)).toBeLessThan(1);
        expect(pictDisplayScale(1180, 800)).toEqual(280 / 800);
    });
});

describe('shipyard standard weapons list', () => {
    it('lists outfit names and weapon names from default outfits', async () => {
        const outfit = {
            ...getDefaultOutfitData(),
            id: 'nova:1',
            name: 'Cargo Expansion',
            weapons: {},
        };
        const weaponOutfit = {
            ...getDefaultOutfitData(),
            id: 'nova:2',
            name: 'Blaster Outfit',
            weapons: { 'nova:10': 2 },
        };
        const weapon = {
            ...getDefaultProjectileWeaponData(),
            id: 'nova:10',
            name: 'Blaster',
        };
        const lookup = {
            async get(id: string) {
                if (id === 'nova:1') {
                    return outfit;
                }
                return weaponOutfit;
            },
        };
        const weapons = { async get() { return weapon; } };
        const lines = await standardWeaponsLines(
            { 'nova:2': 1, 'nova:1': 3 },
            lookup,
            weapons,
        );
        expect(lines).toEqual(['3x Cargo Expansion', '2x Blaster']);
    });
});
