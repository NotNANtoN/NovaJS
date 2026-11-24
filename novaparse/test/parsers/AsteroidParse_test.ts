import 'jasmine';
import { asteroidYieldCommodity } from '../../src/parsers/AsteroidParse';

describe('asteroidYieldCommodity', () => {
    it('names the standard commodities by index', () => {
        // Retail's metal asteroids carry yield type 4.
        expect(asteroidYieldCommodity(4, 'Metal Small')).toBe('metal');
        expect(asteroidYieldCommodity(0, 'Whatever')).toBe('food');
    });

    it('treats a negative yield as worthless', () => {
        // The dust family drops nothing.
        expect(asteroidYieldCommodity(-1, 'Dust Big')).toBeUndefined();
    });

    it('names a junk yield after the asteroid material', () => {
        // jünk resources are not parsed, so ice and crystal asteroids are
        // named for what they are made of.
        expect(asteroidYieldCommodity(1006, 'Ice Huge')).toBe('ice');
        expect(asteroidYieldCommodity(1018, 'Crystal Medium')).toBe('crystal');
    });

    it('resolves jünk resource names when junk table is provided', () => {
        const junks = {
            134: { lcName: 'water', name: 'Water' },
            146: { lcName: 'opals', name: 'Opals' },
        };
        expect(asteroidYieldCommodity(1006, 'Ice Huge', junks)).toBe('water');
        expect(asteroidYieldCommodity(1018, 'Crystal Medium', junks)).toBe('opals');
    });

    it('ignores yield types between the tables', () => {
        expect(asteroidYieldCommodity(500, 'Metal Small')).toBeUndefined();
    });
});
