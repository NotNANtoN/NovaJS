import "jasmine";
import { Resource } from "resource_fork";
import { getEmptyNovaResources } from "./ResourceHolderBase";
import { NebuResource } from "./NebuResource";

function makeNebu(id: number, fields: number[]): NebuResource {
    // Retail nëbu resources are 534 bytes; only the leading four int16
    // fields are meaningful.
    const data = new DataView(new ArrayBuffer(534));
    fields.forEach((value, index) => data.setInt16(index * 2, value));
    const resource = {
        data, id, name: `nebula ${id}`, type: 'nëbu',
    } as unknown as Resource;
    return new NebuResource(resource, getEmptyNovaResources());
}

describe('NebuResource', () => {
    it('parses the galaxy map rectangle', () => {
        const nebu = makeNebu(128, [430, 45, 251, 298]);
        expect(nebu.xPos).toBe(430);
        expect(nebu.yPos).toBe(45);
        expect(nebu.width).toBe(251);
        expect(nebu.height).toBe(298);
    });

    it('parses negative positions', () => {
        const nebu = makeNebu(131, [-138, -226, 146, 71]);
        expect(nebu.xPos).toBe(-138);
        expect(nebu.yPos).toBe(-226);
    });

    it('derives the three zoom level PICT ids', () => {
        expect(makeNebu(128, [0, 0, 1, 1]).pictIDs)
            .toEqual([9500, 9501, 9502]);
        expect(makeNebu(129, [0, 0, 1, 1]).pictIDs)
            .toEqual([9507, 9508, 9509]);
        expect(makeNebu(131, [0, 0, 1, 1]).pictIDs)
            .toEqual([9521, 9522, 9523]);
    });
});
