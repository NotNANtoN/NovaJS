import 'jasmine';
import { resolveShipInfoPict } from '../../src/parsers/ShipParse';
import { ShipResource } from '../../src/resource_parsers/ShipResource';

describe('resolveShipInfoPict', () => {
    it('maps desc.graphic through the ship PICT table', () => {
        const ship = {
            idSpace: {
                PICT: {
                    4214: { globalID: 'nova:4214' },
                },
            },
        } as unknown as ShipResource;
        expect(resolveShipInfoPict(ship, { graphic: 4214 }))
            .toEqual('nova:4214');
    });

    it('returns null when graphic is unset or missing', () => {
        const ship = {
            idSpace: { PICT: {} },
        } as unknown as ShipResource;
        expect(resolveShipInfoPict(ship, undefined)).toBeNull();
        expect(resolveShipInfoPict(ship, { graphic: 0 })).toBeNull();
        expect(resolveShipInfoPict(ship, { graphic: 99 })).toBeNull();
    });
});
