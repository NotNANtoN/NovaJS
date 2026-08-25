import 'jasmine';
import { isRight } from 'fp-ts/Either';
import { getDefaultPlanetData } from
    'novadatainterface/PlanetData';
import {
    LANDING_MAX_SPEED_SQUARED,
    LANDING_RANGE_SQUARED,
    canInitiateLanding,
    chooseLandingCandidate,
    landingCapabilities,
    landingDecision,
    landingAction,
    landingResultMessage,
    PlanetComponent,
    PlanetType,
    resolveLandingCapabilities,
    updateLandingInput,
} from './planet_plugin';
import { makePlanet } from './make_planet';

const earth = {
    uuid: 'planet nova:128',
    id: 'nova:128',
    name: 'Earth',
    distanceSquared: 2_500,
    canLand: true,
    inhabited: true,
};

describe('planet landing selection', () => {
    it('decodes old id-only planet descriptors', () => {
        const decoded = PlanetType.decode({ id: 'nova:128' });
        expect(isRight(decoded)).toBeTrue();
        if (isRight(decoded)) {
            expect(decoded.right).toEqual({ id: 'nova:128' });
        }
    });

    it('replicates authoritative landing metadata from server data', () => {
        const entity = makePlanet({
            ...getDefaultPlanetData(),
            id: 'nova:128',
            name: 'Earth',
            flags: 571_744_335,
            techLevel: 12,
            specialTech: [14, 20],
            canLand: true,
            inhabited: true,
        });
        expect(entity.components.get(PlanetComponent)).toEqual({
            id: 'nova:128',
            name: 'Earth',
            flags: 571_744_335,
            techLevel: 12,
            specialTech: [14, 20],
            canLand: true,
            inhabited: true,
        });
    });

    it('selects retail Earth as a valid landing target', () => {
        // Parsed retail spöb 128 has landing bit 0x1 and does not have the
        // uninhabited bit 0x20.
        const retailEarthFlags = 571_744_335;
        expect(retailEarthFlags & 0x1).toBe(0x1);
        expect(retailEarthFlags & 0x20).toBe(0);
        expect(chooseLandingCandidate([earth])).toEqual(earth);
        expect(landingAction(undefined, earth, 0)).toBe('select');
        expect(landingAction(earth.uuid, earth, 0)).toBe('land');
    });

    it('derives retail eligibility from raw flags when fields are absent', () => {
        expect(landingCapabilities({
            flags: 571_744_335,
            canLand: undefined,
            inhabited: undefined,
        })).toEqual({ canLand: true, inhabited: true });
        expect(landingCapabilities({
            // Retail Jupiter (spöb nova:159): uninhabited and not landable.
            flags: 32,
            canLand: undefined,
            inhabited: undefined,
        })).toEqual({ canLand: false, inhabited: false });
        expect(landingCapabilities({
            flags: undefined,
            canLand: undefined,
            inhabited: undefined,
        })).toEqual({ canLand: undefined, inhabited: undefined });
    });

    it('prefers current server metadata over stale local JSON', () => {
        expect(resolveLandingCapabilities({
            flags: 571_744_335,
            canLand: true,
            inhabited: true,
        }, {
            flags: 32,
            canLand: false,
            inhabited: false,
        })).toEqual({ canLand: true, inhabited: true });
        expect(resolveLandingCapabilities({
            flags: 32,
        }, {
            canLand: true,
            inhabited: true,
        })).toEqual({ canLand: false, inhabited: false });
        expect(resolveLandingCapabilities({
        }, {
            canLand: true,
            inhabited: true,
        })).toEqual({ canLand: true, inhabited: true });
    });

    it('requires a release before the second landing press', () => {
        const first = updateLandingInput(false, 'start');
        expect(first).toEqual({ held: true, begin: true });
        expect(updateLandingInput(first.held, 'start').begin).toBeFalse();
        expect(updateLandingInput(first.held, 'repeat').begin).toBeFalse();

        const released = updateLandingInput(first.held, false);
        expect(released.held).toBeFalse();
        expect(updateLandingInput(released.held, 'start').begin).toBeTrue();
    });

    it('targets the closest stellar but refuses one that is not landable', () => {
        const jupiter = { ...earth, uuid: 'jupiter', id: 'nova:159',
            distanceSquared: 10, canLand: false, inhabited: false };
        const target = chooseLandingCandidate([
            jupiter,
            { ...earth, uuid: 'wormhole', id: 'nova:465',
                distanceSquared: 20, inhabited: false },
            earth,
        ]);
        expect(target).toEqual(jupiter);
        expect(landingAction(jupiter.uuid, jupiter, 0)).toBe('refuse');
    });

    it('refuses landing outside range or above the speed limit', () => {
        expect(canInitiateLanding(earth, 0)).toBeTrue();
        expect(canInitiateLanding(
            { ...earth, distanceSquared: LANDING_RANGE_SQUARED },
            0,
        )).toBeTrue();
        expect(canInitiateLanding(
            { ...earth, distanceSquared: LANDING_RANGE_SQUARED + 1 },
            0,
        )).toBeFalse();
        expect(canInitiateLanding(
            earth,
            LANDING_MAX_SPEED_SQUARED,
        )).toBeTrue();
        expect(canInitiateLanding(
            earth,
            LANDING_MAX_SPEED_SQUARED + 1,
        )).toBeFalse();
    });

    it('returns a typed reason for every legitimate rejection', () => {
        expect(landingDecision(
            earth.uuid,
            { ...earth, canLand: false },
            0,
        )).toEqual({ action: 'refuse', reason: 'cannot-land' });
        expect(landingDecision(
            earth.uuid,
            { ...earth, inhabited: false },
            0,
        )).toEqual({ action: 'refuse', reason: 'uninhabited' });
        expect(landingDecision(
            earth.uuid,
            { ...earth, distanceSquared: LANDING_RANGE_SQUARED + 1 },
            0,
        )).toEqual({ action: 'refuse', reason: 'too-far' });
        expect(landingDecision(
            earth.uuid,
            earth,
            LANDING_MAX_SPEED_SQUARED + 1,
        )).toEqual({ action: 'refuse', reason: 'too-fast' });
        expect(landingDecision(
            earth.uuid,
            { ...earth, canLand: undefined },
            0,
        )).toEqual({ action: 'refuse', reason: 'metadata-unavailable' });
    });

    it('maps landing results to visible sidebar copy', () => {
        expect(landingResultMessage({
            outcome: 'selected',
            planetName: 'Earth',
        })).toContain('press L again');
        expect(landingResultMessage({
            outcome: 'rejected',
            reason: 'too-far',
            planetName: 'Earth',
        })).toBe('Earth is too far away to land.');
        expect(landingResultMessage({
            outcome: 'rejected',
            reason: 'too-fast',
            planetName: 'Earth',
        })).toBe('Slow down before landing on Earth.');
        expect(landingResultMessage({
            outcome: 'rejected',
            reason: 'uninhabited',
            planetName: 'Luna',
        })).toBe('Luna has no usable spaceport.');
        expect(landingResultMessage({
            outcome: 'rejected',
            reason: 'metadata-unavailable',
            planetName: 'Earth',
        })).toBe('Landing data for Earth is unavailable.');
    });
});
