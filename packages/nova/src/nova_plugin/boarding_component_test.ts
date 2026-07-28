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
    planAmmoPlunder,
    AmmoOutfitInfo,
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

describe('planAmmoPlunder', () => {
    // Two ammo outfits feed weapon w1 (capacity 10), one feeds w2 (cap 4),
    // and one is ammo for a weapon the boarder doesn't mount (undefined).
    const info = (id: string): AmmoOutfitInfo | undefined => ({
        'ammo:a': { ammoFor: 'w1', capacity: 10 },
        'ammo:b': { ammoFor: 'w1', capacity: 10 },
        'ammo:c': { ammoFor: 'w2', capacity: 4 },
    }[id]);

    it('takes compatible ammo up to remaining capacity, sorted', () => {
        const victim = new Map([['ammo:a', 6], ['ammo:c', 9], ['junk:x', 3]]);
        // Boarder already holds 2 rounds of w1 (cap 10 -> 8 room) and 0 of w2.
        const boarderRounds = new Map([['w1', 2]]);
        expect(planAmmoPlunder(victim, boarderRounds, info))
            // ammo:a: min(6, 10-2)=6; ammo:c: min(9, 4-0)=4; junk:x skipped.
            .toEqual([['ammo:a', 6], ['ammo:c', 4]]);
    });

    it('shares capacity across outfits feeding the same weapon', () => {
        // Both ammo:a and ammo:b feed w1 (cap 10), boarder holds none. First
        // takes 7, leaving only 3 room for the second even though 8 available.
        const victim = new Map([['ammo:a', 7], ['ammo:b', 8]]);
        expect(planAmmoPlunder(victim, new Map(), info))
            .toEqual([['ammo:a', 7], ['ammo:b', 3]]);
    });

    it('takes nothing when the boarder is already full or has no launcher', () => {
        // w1 already full (10/10) and ammo:d has no matching launcher.
        const victim = new Map([['ammo:a', 5], ['ammo:d', 5]]);
        expect(planAmmoPlunder(victim, new Map([['w1', 10]]), info))
            .toEqual([]);
    });
});
