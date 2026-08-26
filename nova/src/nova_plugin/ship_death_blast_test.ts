import 'jasmine';
import {
    shipExplosionBlastRadius,
    shipExplosionBlastStrength,
} from './ship_death_blast';

describe('ship death blast scale', () => {
    it('grows with mass', () => {
        expect(shipExplosionBlastStrength(500)).toBeCloseTo(10, 8);
        expect(shipExplosionBlastRadius(500)).toBeCloseTo(10, 8);
    });

    it('caps the reach of the heaviest hulls', () => {
        // The Leviathan is mass 10,000; an uncapped radius would reach
        // further than the visible screen.
        expect(shipExplosionBlastRadius(10_000)).toEqual(200);
    });

    it('ignores a missing or nonsense mass', () => {
        expect(shipExplosionBlastStrength(0)).toEqual(0);
        expect(shipExplosionBlastRadius(Number.NaN)).toEqual(0);
    });
});
