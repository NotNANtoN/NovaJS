import 'jasmine';
import { Resource } from 'resource_fork';
import {
    FLET_MEANINGFUL_BYTES,
    FletResource,
} from './FletResource';
import { getEmptyNovaResources } from './ResourceHolderBase';

function makeResource(bytes: ArrayBuffer, id = 128): FletResource {
    const resource = {
        data: new DataView(bytes),
        id,
        name: `fleet ${id}`,
        type: 'flët',
    } as unknown as Resource;
    return new FletResource(resource, getEmptyNovaResources());
}

/**
 * Exact bytes dumped from retail flët 128 ("Small Federation Fleet") with
 * tools/dump_resource.py. All bytes after the first 30 are zero in this
 * record, including the 16-byte tail padding.
 */
const RETAIL_FLET_128 = new Uint8Array(306);
RETAIL_FLET_128.set([
    0x00, 0x8d, 0x00, 0xdf, 0x00, 0xe0, 0xff, 0xff,
    0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x80, 0x27, 0x10,
]);

describe('FletResource', () => {
    it('parses the retail flët 128 payload at its verified offsets', () => {
        const flet = makeResource(
            RETAIL_FLET_128.slice().buffer as ArrayBuffer,
        );

        expect(flet.data.byteLength).toBe(306);
        expect(FLET_MEANINGFUL_BYTES).toBe(290);
        expect(flet.leadShipType).toBe(141);
        expect(flet.escortTypes).toEqual([223, 224, -1, -1]);
        expect(flet.minEscorts).toEqual([0, 0, 0, 0]);
        expect(flet.maxEscorts).toEqual([1, 1, 0, 0]);
        expect(flet.government).toBe(128);
        expect(flet.linkSyst).toBe(10000);
        expect(flet.appearOn).toBe('');
        expect(flet.quote).toBe(0);
        expect(flet.flags).toBe(0);
    });

    it('keeps all four escort slots and decodes the expression field', () => {
        const bytes = new ArrayBuffer(306);
        const data = new DataView(bytes);
        data.setInt16(0, 141);
        data.setInt16(2, 223);
        data.setInt16(4, 224);
        data.setInt16(6, 225);
        data.setInt16(8, 226);
        data.setInt16(10, 0);
        data.setInt16(12, 1);
        data.setInt16(14, 2);
        data.setInt16(16, 3);
        data.setInt16(18, 1);
        data.setInt16(20, 2);
        data.setInt16(22, 3);
        data.setInt16(24, 4);
        data.setInt16(26, -1);
        data.setInt16(28, -1);
        [...'b1 & !b2'].forEach((character, index) =>
            data.setUint8(30 + index, character.charCodeAt(0)));
        data.setInt16(286, 42);
        data.setUint16(288, 1);

        const flet = makeResource(bytes, 129);
        expect(flet.escortTypes).toEqual([223, 224, 225, 226]);
        expect(flet.minEscorts).toEqual([0, 1, 2, 3]);
        expect(flet.maxEscorts).toEqual([1, 2, 3, 4]);
        expect(flet.government).toBe(-1);
        expect(flet.linkSyst).toBe(-1);
        expect(flet.appearOn).toBe('b1 & !b2');
        expect(flet.quote).toBe(42);
        expect(flet.flags).toBe(1);
    });
});
