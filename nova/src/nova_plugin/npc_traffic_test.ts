import 'jasmine';
import {
    chooseTrafficDeparture,
    chooseTrafficDestination,
    decideTrafficLanding,
    shouldYieldToCombat,
    shouldTrafficDepart,
    trafficDwellDuration,
    TRAFFIC_DWELL_MAX_MS,
    TRAFFIC_DWELL_MIN_MS,
    TRAFFIC_LANDING_MAX_SPEED_SQUARED,
    TRAFFIC_LANDING_RANGE_SQUARED,
} from './npc_traffic';

const earth = {
    uuid: 'planet earth',
    id: 'nova:128',
    distanceSquared: 100,
    canLand: true,
    inhabited: true,
};

describe('NPC traffic decisions', () => {
    it('chooses only valid stellars with deterministic sampling', () => {
        const selected = chooseTrafficDestination([
            {
                ...earth,
                uuid: 'planet invalid',
                canLand: false,
            },
            { ...earth, uuid: 'planet zeta' },
            { ...earth, uuid: 'planet alpha' },
        ], () => 0);

        expect(selected?.uuid).toBe('planet alpha');
        expect(chooseTrafficDestination(
            [{ ...earth, inhabited: false }],
            () => 0,
        )).toBeUndefined();
        expect(chooseTrafficDestination(
            [{ ...earth }, { ...earth, uuid: 'planet beta' }],
            () => 1,
            'planet beta',
        )?.uuid).toBe('planet earth');
    });

    it('selects a cached departure link deterministically', () => {
        const available = new Set(['nova:next', 'nova:other']);
        expect(chooseTrafficDeparture(
            ['nova:other', 'nova:next', 'nova:missing'],
            available,
            () => 0,
        )).toBe('nova:next');
        expect(chooseTrafficDeparture(
            ['nova:missing'],
            available,
            () => 0,
        )).toBeUndefined();
    });

    it('waits to enter landing range and speed before docking', () => {
        expect(decideTrafficLanding(
            undefined, earth, 0, 0,
        )).toBe('select');
        expect(decideTrafficLanding(
            earth.uuid,
            earth,
            TRAFFIC_LANDING_RANGE_SQUARED + 1,
            0,
        )).toBe('wait');
        expect(decideTrafficLanding(
            earth.uuid,
            earth,
            0,
            TRAFFIC_LANDING_MAX_SPEED_SQUARED + 1,
        )).toBe('wait');
        expect(decideTrafficLanding(
            earth.uuid, earth, 0, 0,
        )).toBe('land');
        expect(decideTrafficLanding(
            earth.uuid,
            { ...earth, canLand: false },
            0,
            0,
        )).toBe('depart');
        expect(decideTrafficLanding(
            earth.uuid, undefined, 0, 0,
        )).toBe('depart');
    });

    it('suspends traffic for combat and unsafe ship states', () => {
        expect(shouldYieldToCombat(true, false, false, false)).toBeTrue();
        expect(shouldYieldToCombat(false, true, false, false)).toBeTrue();
        expect(shouldYieldToCombat(false, false, true, false)).toBeTrue();
        expect(shouldYieldToCombat(false, false, false, true)).toBeTrue();
        expect(shouldYieldToCombat(false, false, false, false)).toBeFalse();
    });

    it('keeps dwell times within the configured interval', () => {
        expect(trafficDwellDuration(
            () => 0,
        )).toBe(TRAFFIC_DWELL_MIN_MS);
        expect(trafficDwellDuration(
            () => 1,
        )).toBe(TRAFFIC_DWELL_MAX_MS);
    });

    it('occasionally chooses to depart after doing business', () => {
        expect(shouldTrafficDepart(() => 0)).toBeFalse();
        expect(shouldTrafficDepart(() => 1)).toBeTrue();
        expect(shouldTrafficDepart(() => 0.8, 0.25)).toBeTrue();
        expect(shouldTrafficDepart(() => 0.7, 0.25)).toBeFalse();
    });
});
