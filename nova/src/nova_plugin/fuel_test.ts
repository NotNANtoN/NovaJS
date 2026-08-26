import 'jasmine';
import {
    canJump,
    clampFuel,
    refuelOnLanding,
    refuelsOnLanding,
    FUEL_PER_JUMP,
    fuelJumpBlocks,
    jumpsFromFuel,
    spendJumpFuel,
} from './fuel';

describe('jump fuel', () => {
    it('counts whole jumps only', () => {
        expect(jumpsFromFuel(0)).toBe(0);
        expect(jumpsFromFuel(99)).toBe(0);
        expect(jumpsFromFuel(100)).toBe(1);
        expect(jumpsFromFuel(350)).toBe(3);
    });

    it('needs a full jump in the tank to leave', () => {
        expect(canJump(99)).toBeFalse();
        expect(canJump(100)).toBeTrue();
    });

    it('spends one jump at a time and never goes negative', () => {
        expect(spendJumpFuel(300)).toBe(200);
        expect(spendJumpFuel(50)).toBe(0);
    });

    it('caps fuel at the tank it is poured into', () => {
        expect(clampFuel(900, 300)).toBe(300);
        expect(clampFuel(-5, 300)).toBe(0);
        expect(clampFuel(200, 300)).toBe(200);
    });
});

describe('the fuel gauge', () => {
    it('draws one block per jump the tank holds', () => {
        expect(fuelJumpBlocks({ fuel: 300, capacity: 300 }))
            .toEqual({ total: 3, full: 3, partial: 0 });
    });

    it('dims the partly spent jump', () => {
        const blocks = fuelJumpBlocks({ fuel: 250, capacity: 300 });
        expect(blocks.full).toBe(2);
        expect(blocks.partial).toBeCloseTo(0.5, 5);
    });

    it('shows an empty tank as no blocks lit', () => {
        const blocks = fuelJumpBlocks({ fuel: 0, capacity: 500 });
        expect(blocks.total).toBe(5);
        expect(blocks.full).toBe(0);
        expect(blocks.partial).toBe(0);
    });

    it('has nothing to draw without a tank', () => {
        expect(fuelJumpBlocks({ fuel: 0, capacity: 0 }).total).toBe(0);
    });
});

describe('refuelling on landing', () => {
    it('fills the tank at an inhabited stellar', () => {
        expect(refuelOnLanding(50, 300, { inhabited: true })).toBe(300);
    });

    it('leaves the tank alone at an uninhabited rock', () => {
        expect(refuelsOnLanding({ inhabited: false })).toBeFalse();
        expect(refuelOnLanding(50, 300, { inhabited: false })).toBe(50);
    });

    it('treats a stellar of unknown habitation as inhabited', () => {
        expect(refuelsOnLanding({})).toBeTrue();
        expect(refuelOnLanding(0, 300, {})).toBe(300);
    });

    it('never leaves more fuel than the tank holds', () => {
        expect(refuelOnLanding(900, 300, { inhabited: false })).toBe(300);
    });
});
