import 'jasmine';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { getShipAIProfile, ShipAIProfile } from './ship_ai_profile';

function profileFor(inherentAI: number): ShipAIProfile {
    return getShipAIProfile({
        ...getDefaultShipData(),
        inherentAI,
    });
}

describe('ship AI profiles', () => {
    it('defaults missing ship data to the safe retail type', () => {
        expect(getDefaultShipData().inherentAI).toBe(1);
    });

    it('maps the one-based retail wimpy trader type', () => {
        expect(profileFor(1)).toEqual({
            role: 'wimpy-trader',
            weaponStandoffMultiplier: 1,
            initiatesCombat: false,
            pursuitRangeMultiplier: 1,
            fleesWhenAttacked: true,
            breaksOffOutOfRange: false,
            jumpsWithoutEnemies: false,
            parksWithoutEnemies: false,
            policesPiracy: false,
        });
    });

    it('maps the brave trader type', () => {
        expect(profileFor(2)).toEqual({
            role: 'brave-trader',
            weaponStandoffMultiplier: 0.9,
            initiatesCombat: false,
            pursuitRangeMultiplier: 1.5,
            fleesWhenAttacked: false,
            breaksOffOutOfRange: true,
            jumpsWithoutEnemies: false,
            parksWithoutEnemies: false,
            policesPiracy: false,
        });
    });

    it('maps the warship type', () => {
        expect(profileFor(3)).toEqual({
            role: 'warship',
            weaponStandoffMultiplier: 0.75,
            initiatesCombat: true,
            pursuitRangeMultiplier: 3,
            fleesWhenAttacked: false,
            breaksOffOutOfRange: false,
            jumpsWithoutEnemies: true,
            parksWithoutEnemies: false,
            policesPiracy: false,
        });
    });

    it('maps the interceptor type', () => {
        expect(profileFor(4)).toEqual({
            role: 'interceptor',
            weaponStandoffMultiplier: 0.55,
            initiatesCombat: true,
            pursuitRangeMultiplier: 5,
            fleesWhenAttacked: false,
            breaksOffOutOfRange: false,
            jumpsWithoutEnemies: false,
            parksWithoutEnemies: true,
            policesPiracy: true,
        });
    });

    it('falls back safely for zero, escort, and custom values', () => {
        const safe = profileFor(1);
        expect(profileFor(0)).toEqual(safe);
        expect(profileFor(5)).toEqual(safe);
        expect(profileFor(99)).toEqual(safe);
    });
});
