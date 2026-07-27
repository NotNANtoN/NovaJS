import 'jasmine';
import { Angle } from 'nova_ecs/datatypes/vector';
import {
    AXIS_ALIGN_TOLERANCE_RAD,
    axesAligned,
    BOARD_DISTANCE_SQUARED,
    BOARD_REL_SPEED_SQUARED,
    boardingBlockedReason,
    captureChance,
    CAPTURE_CHANCE_MAX,
    CAPTURE_CHANCE_MIN,
    creditBooty,
    CREDIT_BOOTY_FRACTION,
    fuelTransferAmount,
    planCargoPlunder,
} from './boarding_component.js';

describe('axis alignment gate (Matthew\'s spec)', () => {
    const zero = new Angle(0);

    it('accepts parallel axes (same facing)', () => {
        expect(axesAligned(zero, new Angle(0))).toBeTrue();
        expect(axesAligned(new Angle(1), new Angle(1))).toBeTrue();
    });

    it('accepts anti-parallel axes (exactly opposite)', () => {
        expect(axesAligned(zero, new Angle(Math.PI))).toBeTrue();
        expect(axesAligned(new Angle(0.5), new Angle(0.5 + Math.PI)))
            .toBeTrue();
    });

    it('accepts within tolerance of parallel and anti-parallel', () => {
        const inside = AXIS_ALIGN_TOLERANCE_RAD * 0.9;
        expect(axesAligned(zero, new Angle(inside))).toBeTrue();
        expect(axesAligned(zero, new Angle(-inside))).toBeTrue();
        expect(axesAligned(zero, new Angle(Math.PI - inside))).toBeTrue();
    });

    it('rejects perpendicular axes', () => {
        expect(axesAligned(zero, new Angle(Math.PI / 2))).toBeFalse();
        expect(axesAligned(zero, new Angle(-Math.PI / 2))).toBeFalse();
    });

    it('rejects just outside the tolerance', () => {
        const outside = AXIS_ALIGN_TOLERANCE_RAD * 1.1;
        expect(axesAligned(zero, new Angle(outside))).toBeFalse();
        expect(axesAligned(zero, new Angle(Math.PI - outside))).toBeFalse();
    });
});

describe('boardingBlockedReason', () => {
    const ok = {
        hasTarget: true,
        targetDisabled: true,
        targetCrew: 2,
        distanceSquared: BOARD_DISTANCE_SQUARED - 1,
        relSpeedSquared: BOARD_REL_SPEED_SQUARED - 1,
        aligned: true,
    };

    it('allows a valid board', () => {
        expect(boardingBlockedReason(ok)).toBeNull();
    });

    it('reports reasons in priority order', () => {
        expect(boardingBlockedReason({ ...ok, hasTarget: false }))
            .toEqual('noTarget');
        expect(boardingBlockedReason({ ...ok, targetDisabled: false }))
            .toEqual('notDisabled');
        expect(boardingBlockedReason({ ...ok, targetCrew: 0 }))
            .toEqual('noCrew');
        expect(boardingBlockedReason({
            ...ok, distanceSquared: BOARD_DISTANCE_SQUARED,
        })).toEqual('tooFar');
        expect(boardingBlockedReason({
            ...ok, relSpeedSquared: BOARD_REL_SPEED_SQUARED,
        })).toEqual('tooFast');
        expect(boardingBlockedReason({ ...ok, aligned: false }))
            .toEqual('notAligned');
    });
});

describe('captureChance', () => {
    it('is a share of total crew, clamped', () => {
        expect(captureChance(10, 10)).toBeCloseTo(0.5, 9);
        expect(captureChance(30, 10)).toBeCloseTo(0.75, 9);
    });

    it('clamps to the min/max band', () => {
        expect(captureChance(1, 1000)).toEqual(CAPTURE_CHANCE_MIN);
        expect(captureChance(1000, 1)).toEqual(CAPTURE_CHANCE_MAX);
    });

    it('is zero for a crewless boarder (Bible: cannot capture)', () => {
        expect(captureChance(0, 5)).toEqual(0);
    });

    it('is deterministic for the same crew counts', () => {
        expect(captureChance(7, 3)).toEqual(captureChance(7, 3));
    });
});

describe('booty math', () => {
    it('derives money booty from purchase price', () => {
        expect(creditBooty(10_000))
            .toEqual(Math.floor(10_000 * CREDIT_BOOTY_FRACTION));
        expect(creditBooty(0)).toEqual(0);
        expect(creditBooty(-5)).toEqual(0);
    });

    it('transfers fuel clamped by victim tank and boarder headroom', () => {
        // Boarder headroom (max - current) is the binding limit.
        expect(fuelTransferAmount(500, 80, 100)).toEqual(20);
        // Victim tank is the binding limit.
        expect(fuelTransferAmount(15, 0, 100)).toEqual(15);
        // Already full.
        expect(fuelTransferAmount(500, 100, 100)).toEqual(0);
        // Never negative.
        expect(fuelTransferAmount(0, 120, 100)).toEqual(0);
    });

    it('plans a cargo plunder capped by free space, in sorted order', () => {
        const cargo = new Map([['cargo:2', 5], ['cargo:0', 4], ['junk:9', 3]]);
        // Free space 6: fills sorted keys cargo:0 (4), then cargo:2 (2).
        expect(planCargoPlunder(cargo, 6)).toEqual([['cargo:0', 4],
            ['cargo:2', 2]]);
        // Free space beyond the load takes all, still sorted.
        expect(planCargoPlunder(cargo, 100)).toEqual([['cargo:0', 4],
            ['cargo:2', 5], ['junk:9', 3]]);
        // No free space takes nothing.
        expect(planCargoPlunder(cargo, 0)).toEqual([]);
    });
});
