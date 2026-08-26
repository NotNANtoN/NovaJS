import 'jasmine';
import {
    DEFAULT_FLEET_FORMATION_SPACING,
    composeFleetRoster,
    formationSlot,
    rollEscortCount,
    rollEscortCounts,
} from './fleet';

describe('fleet roster logic', () => {
    it('rolls inclusive escort bounds', () => {
        expect(rollEscortCount(2, 4, () => 0)).toBe(2);
        expect(rollEscortCount(2, 4, () => 0.999999)).toBe(4);
        expect(rollEscortCount(2, 4, () => 1)).toBe(4);
        expect(rollEscortCount(4, 2, () => 0.5)).toBe(4);
    });

    it('rolls every escort class and preserves duplicate classes', () => {
        const randomValues = [0, 0.999999, 0];
        const counts = rollEscortCounts([
            { shipId: 'scout', min: 1, max: 2 },
            { shipId: 'scout', min: 2, max: 3 },
            { shipId: 'freighter', min: 0, max: 0 },
        ], () => randomValues.shift() ?? 0);
        expect(counts).toEqual([1, 3, 0]);

        const roster = composeFleetRoster({
            leaderShipId: 'carrier',
            escorts: [
                { shipId: 'scout', min: 1, max: 1 },
                { shipId: 'scout', min: 2, max: 2 },
            ],
        });
        expect(roster).toEqual({
            leaderShipId: 'carrier',
            escortShipIds: ['scout', 'scout', 'scout'],
        });
    });

    it('places escorts in deterministic staggered rows behind the leader', () => {
        expect(formationSlot(0)).toEqual({
            x: -DEFAULT_FLEET_FORMATION_SPACING,
            y: DEFAULT_FLEET_FORMATION_SPACING,
        });
        expect(formationSlot(1)).toEqual({
            x: DEFAULT_FLEET_FORMATION_SPACING,
            y: DEFAULT_FLEET_FORMATION_SPACING,
        });
        expect(formationSlot(2)).toEqual({
            x: -DEFAULT_FLEET_FORMATION_SPACING * 2,
            y: DEFAULT_FLEET_FORMATION_SPACING * 2,
        });
        expect(formationSlot(-1, -10)).toEqual({ x: 0, y: 0 });
    });
});
