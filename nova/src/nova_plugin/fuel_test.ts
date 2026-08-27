import 'jasmine';
import {
    canJump,
    clampFuel,
    refuelCost,
    refuelsOnLanding,
    buyFuel,
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

describe('where fuel can be bought', () => {
    it('sells at an inhabited stellar but not a bare rock', () => {
        expect(refuelsOnLanding({ inhabited: true })).toBeTrue();
        expect(refuelsOnLanding({ inhabited: false })).toBeFalse();
        expect(refuelsOnLanding({})).toBeTrue();
    });
});

describe('buying fuel at 100 credits a jump', () => {
    it('costs nothing when the tank is already full', () => {
        expect(refuelCost(300, 300)).toBe(0);
        expect(buyFuel(300, 300, 1000).purchased).toBe(0);
    });

    it('charges a whole jump for a part-used one', () => {
        expect(refuelCost(250, 300)).toBe(100);
        expect(refuelCost(0, 300)).toBe(300);
    });

    it('fills the tank when the pilot can afford it', () => {
        const result = buyFuel(0, 300, 10_000);
        expect(result.fuel).toBe(300);
        expect(result.credits).toBe(9_700);
        expect(result.purchased).toBe(3);
    });

    it('buys only the jumps the pilot can pay for', () => {
        const result = buyFuel(0, 800, 250);
        expect(result.purchased).toBe(2);
        expect(result.fuel).toBe(200);
        expect(result.credits).toBe(50);
    });

    it('buys nothing for a pilot who cannot afford one jump', () => {
        const result = buyFuel(0, 300, 99);
        expect(result.purchased).toBe(0);
        expect(result.fuel).toBe(0);
        expect(result.credits).toBe(99);
    });

    it('never overfills a partly used tank', () => {
        expect(buyFuel(250, 300, 10_000).fuel).toBe(300);
    });
});
