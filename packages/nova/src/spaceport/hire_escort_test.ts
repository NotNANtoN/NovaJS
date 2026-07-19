import 'jasmine';
import { getDefaultPlanetData } from 'novadatainterface/planet_data';
import { getDefaultShipData, ShipData } from 'novadatainterface/ship_data';
import { hirePrice, shipHireable } from './hire_escort.js';

function makeShip(ship: Partial<ShipData>): ShipData {
    return { ...getDefaultShipData(), ...ship };
}

describe('hirePrice', () => {
    it('charges 10% of the ship price', () => {
        // The reference screenshot: a 300,000 cr Thunderhead hires
        // for 30,000 cr.
        expect(hirePrice(makeShip({ price: 300_000 }))).toEqual(30_000);
        expect(hirePrice(makeShip({ price: 17_500 }))).toEqual(1_750);
    });
});

describe('shipHireable', () => {
    const planet = { ...getDefaultPlanetData(), techLevel: 8 };

    it('requires HireRandom, a price, and the stellar tech level', () => {
        expect(shipHireable(makeShip(
            { hireRandom: 25, price: 10_000, techLevel: 5 }), planet))
            .toBeTrue();
        // HireRandom 0 = never for hire (Bible, shïp HireRandom).
        expect(shipHireable(makeShip(
            { hireRandom: 0, price: 10_000, techLevel: 5 }), planet))
            .toBeFalse();
        expect(shipHireable(makeShip(
            { hireRandom: 25, price: 0, techLevel: 5 }), planet))
            .toBeFalse();
        expect(shipHireable(makeShip(
            { hireRandom: 25, price: 10_000, techLevel: 9 }), planet))
            .toBeFalse();
    });
});
