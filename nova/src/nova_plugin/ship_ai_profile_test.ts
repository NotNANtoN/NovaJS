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
            weaponStandoffMultiplier: 1,
            disengageDamageFraction: 0.25,
            initiatesCombat: false,
            pursuitRangeMultiplier: 1,
        });
    });

    it('maps the brave trader type', () => {
        expect(profileFor(2)).toEqual({
            weaponStandoffMultiplier: 0.9,
            disengageDamageFraction: 0.6,
            initiatesCombat: false,
            pursuitRangeMultiplier: 1.5,
        });
    });

    it('maps the warship type', () => {
        expect(profileFor(3)).toEqual({
            weaponStandoffMultiplier: 0.75,
            disengageDamageFraction: 0.8,
            initiatesCombat: true,
            pursuitRangeMultiplier: 3,
        });
    });

    it('maps the interceptor type', () => {
        expect(profileFor(4)).toEqual({
            weaponStandoffMultiplier: 0.55,
            disengageDamageFraction: 0.9,
            initiatesCombat: true,
            pursuitRangeMultiplier: 5,
        });
    });

    it('falls back safely for zero, escort, and custom values', () => {
        const safe = profileFor(1);
        expect(profileFor(0)).toEqual(safe);
        expect(profileFor(5)).toEqual(safe);
        expect(profileFor(99)).toEqual(safe);
    });
});
