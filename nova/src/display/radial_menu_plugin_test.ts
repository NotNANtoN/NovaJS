import 'jasmine';
import {
    computeRadialSelection,
    cycleRadialIndex,
    gamepadRadialSelection,
} from './radial_menu_plugin';

describe('Radial menu pure helpers', () => {
    const NUM_OPTIONS = 8;

    describe('computeRadialSelection', () => {
        it('returns -1 when within deadzone or too far', () => {
            // inside inner deadzone
            expect(computeRadialSelection(0, 0, NUM_OPTIONS, 45, 145)).toBe(-1);
            expect(computeRadialSelection(20, 20, NUM_OPTIONS, 45, 145)).toBe(-1);
            // too far
            expect(computeRadialSelection(300, 300, NUM_OPTIONS, 45, 145)).toBe(-1);
        });

        it('computes correct sector based on angle starting from top', () => {
            // Top (0, -100) -> sector 0
            expect(computeRadialSelection(0, -100, NUM_OPTIONS, 45, 145)).toBe(0);
            // Right (100, 0)
            const rightSector = computeRadialSelection(100, 0, NUM_OPTIONS, 45, 145);
            expect(rightSector).toBeGreaterThan(0);
            expect(rightSector).toBeLessThan(NUM_OPTIONS);
        });
    });

    describe('cycleRadialIndex', () => {
        it('cycles forward and wraps', () => {
            expect(cycleRadialIndex(-1, 1, NUM_OPTIONS)).toBe(0);
            expect(cycleRadialIndex(0, 1, NUM_OPTIONS)).toBe(1);
            expect(cycleRadialIndex(7, 1, NUM_OPTIONS)).toBe(0);
        });

        it('cycles backward and wraps', () => {
            expect(cycleRadialIndex(-1, -1, NUM_OPTIONS)).toBe(7);
            expect(cycleRadialIndex(0, -1, NUM_OPTIONS)).toBe(7);
            expect(cycleRadialIndex(3, -1, NUM_OPTIONS)).toBe(2);
        });
    });

    describe('gamepadRadialSelection', () => {
        it('ignores stick inputs within deadzone threshold', () => {
            expect(gamepadRadialSelection(0, 0, NUM_OPTIONS, 0.4)).toBeUndefined();
            expect(gamepadRadialSelection(0.2, -0.2, NUM_OPTIONS, 0.4)).toBeUndefined();
        });

        it('selects sector when stick pushed past threshold', () => {
            // Pushing up: axisY = -1, axisX = 0 -> sector 0 (top)
            expect(gamepadRadialSelection(0, -0.9, NUM_OPTIONS, 0.4)).toBe(0);
            // Pushing right: axisX = 1, axisY = 0
            const rightSector = gamepadRadialSelection(0.9, 0, NUM_OPTIONS, 0.4);
            expect(rightSector).toBeDefined();
            expect(rightSector).toBeGreaterThan(0);
        });
    });
});
