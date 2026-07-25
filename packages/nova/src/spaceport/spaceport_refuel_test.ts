import { refuelCost } from './spaceport.js';

describe('refuelCost', function() {
    it('charges 100 credits per missing jump of fuel', function() {
        expect(refuelCost({ current: 0, max: 600 })).toEqual(600);
        expect(refuelCost({ current: 300, max: 600 })).toEqual(300);
        expect(refuelCost({ current: 500, max: 600 })).toEqual(100);
    });

    it('prorates partial jumps, rounding up', function() {
        expect(refuelCost({ current: 550, max: 600 })).toEqual(50);
        expect(refuelCost({ current: 599.5, max: 600 })).toEqual(1);
    });

    it('costs nothing when full', function() {
        expect(refuelCost({ current: 600, max: 600 })).toEqual(0);
    });
});
