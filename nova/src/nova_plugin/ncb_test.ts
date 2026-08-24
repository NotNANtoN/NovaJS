import {
    applySetExpression,
    evaluateTestExpression,
    NcbOperation,
    parseSetExpression,
} from './ncb';

describe('NCB test expressions', () => {
    it('evaluates bits, negation, and parentheses', () => {
        const missionBits = new Set([13, 42]);
        expect(evaluateTestExpression(
            'b13 & (b232 | !b42)', { missionBits })).toBe(false);
        expect(evaluateTestExpression(
            'b13 & (b232 | !b43)', { missionBits })).toBe(true);
    });

    it('treats a blank test expression as true', () => {
        expect(evaluateTestExpression('', { missionBits: new Set() })).toBe(true);
    });

    it('uses standard operator precedence', () => {
        const missionBits = new Set([1]);
        expect(evaluateTestExpression('b1 | b2 & b3', { missionBits })).toBe(true);
        expect(evaluateTestExpression('(b1 | b2) & b3', { missionBits })).toBe(false);
    });

    it('supports the other Bible test operands', () => {
        const context = {
            missionBits: new Set<number>(),
            registered: false,
            daysSinceRegistration: 4,
            gender: 'male' as const,
            outfits: new Set<number>([12]),
            exploredSystems: new Set<number>([130]),
        };
        expect(evaluateTestExpression('p5 & g & o12 & e130', context)).toBe(true);
        expect(evaluateTestExpression('p4', context)).toBe(false);
    });

    it('rejects malformed test expressions', () => {
        expect(() => evaluateTestExpression('b10000', {
            missionBits: new Set(),
        })).toThrow();
        expect(() => evaluateTestExpression('b1 &', {
            missionBits: new Set(),
        })).toThrow();
    });
});

describe('NCB set expressions', () => {
    it('sets, clears, and toggles bits', () => {
        const missionBits = new Set([2, 4]);
        applySetExpression('b1 !b2 ^b4', missionBits);
        expect(missionBits).toEqual(new Set([1]));
    });

    it('applies the same operations to a boolean bit array', () => {
        const missionBits: boolean[] = [];
        applySetExpression('b13 b232', missionBits);
        expect(missionBits[13]).toBe(true);
        expect(missionBits[232]).toBe(true);
    });

    it('chooses exactly one Bible random branch', () => {
        const firstBits = new Set<number>();
        applySetExpression('b1 R(b2 !b3)', firstBits, { random: () => 0 });
        expect(firstBits).toEqual(new Set([1, 2]));

        const secondBits = new Set<number>();
        applySetExpression('b1 R(b2 !b3)', secondBits, { random: () => 0.99 });
        expect(secondBits).toEqual(new Set([1]));
    });

    it('uses RNNN as a deterministic chance gate', () => {
        const passed = new Set<number>();
        applySetExpression('R50 b1', passed, { random: () => 0.49 });
        expect(passed).toEqual(new Set([1]));

        const failed = new Set<number>();
        applySetExpression('R50 b1', failed, { random: () => 0.5 });
        expect(failed).toEqual(new Set());
    });

    it('returns structured non-bit operations', () => {
        const operations = parseSetExpression(
            'A12 F13 G14 D15 M130 N131 C128 E129 K2 L2 P7 Y8 U9 Q10 T11 X12',
        );
        expect(operations.map(operation => operation.type)).toEqual([
            'abortMission', 'failMission', 'grantOutfit', 'removeOutfit',
            'moveToSystem', 'moveToSystemRelative', 'changeShip', 'changeShip',
            'activateRank', 'deactivateRank', 'playSound', 'destroyStellar',
            'regenerateStellar', 'leaveStellar', 'renameShip', 'exploreSystem',
        ]);
        expect((operations[2] as Extract<NcbOperation, { type: 'grantOutfit' }>).id)
            .toBe(14);
        expect((operations[6] as Extract<NcbOperation, { type: 'changeShip' }>)
            .includeDefaults).toBe(false);
        expect((operations[7] as Extract<NcbOperation, { type: 'changeShip' }>)
            .includeDefaults).toBe(true);
    });

    it('logs rather than throwing for unknown operations', () => {
        const warnings: string[] = [];
        const operations = parseSetExpression('I12 W13 Z14', {
            logger: message => warnings.push(message),
        });
        expect(operations.every(operation => operation.type === 'unknown')).toBe(true);
        expect(warnings.length).toBe(3);
    });

    it('dispatches structured operations through callbacks', () => {
        const missionBits = new Set<number>();
        const handled: NcbOperation[] = [];
        applySetExpression('b1 G12', missionBits, {
            handlers: {
                grantOutfit: operation => handled.push(operation),
            },
        });
        expect(handled).toEqual([{ type: 'grantOutfit', id: 12 }]);
    });
});

