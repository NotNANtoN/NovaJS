import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import {
    colorTableByteLengthChecked, fitsWithin, parseColorTable, readBit,
    readIndexedPixel, RGB,
} from "./quickdraw.js";
import { NovaResources } from "./resource_holder_base.js";

/**
 * A classic Mac colour icon (Inside Macintosh: Imaging With QuickDraw, the
 * IconData record; resource type 'cicn'): a small colour image plus a 1-bit
 * mask. Nova uses them for the reticle "target corner" brackets around a
 * selected target (Nova Graphics 1, ids 10000-10023) and a handful of other
 * UI glyphs; plug-ins ship their own (e.g. weapon-flash cicns).
 *
 * Resource layout (all offsets from the start of the resource data):
 *
 *   PixMap record (50 bytes) — describes the colour image:
 *      0  baseAddr  uint32  (ignored on disk)
 *      4  rowBytes  uint16  bytes per pixel row (top 2 bits are flags)
 *      6  bounds    int16 x4: top, left, bottom, right
 *     32  pixelSize int16   bits per pixel (indexed: 1, 2, 4, or 8)
 *     (pmTable/pmReserved fields present but the on-disk colour table follows
 *      the bitmaps, not at pmTable — see below)
 *
 *   Mask BitMap (14 bytes): baseAddr uint32, rowBytes uint16, bounds int16 x4.
 *   Icon BitMap (14 bytes): same shape (the 1-bit black/white icon).
 *   iconData handle (4 bytes, ignored).
 *
 *   Then the variable-length data, in order:
 *     mask data     maskRowBytes * height   1-bit alpha (1 = opaque)
 *     bitmap data   iconRowBytes * height   1-bit icon (unused here)
 *     ColorTable    8 + 8*(ctSize+1) bytes  value/r/g/b entries
 *     pixel data    pmRowBytes * height     packed indexed colour
 *
 * We decode the colour pixel data through the ColorTable and use the mask
 * bitmap as the alpha channel, yielding straight RGBA.
 */
export class CicnResource extends BaseResource {
    // Assigned by the constructor's decode path or by degrade().
    width!: number;
    height!: number;
    /** Row-major RGBA pixels, 4 bytes per pixel; alpha from the 1-bit mask. */
    pixels!: Uint8ClampedArray;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const d = this.data;

        // The three fixed headers (PixMap 50 + mask BitMap 14 + icon BitMap 14
        // + iconData handle 4) run to offset 82. Guard them before reading any
        // field so a truncated resource degrades instead of throwing.
        if (!fitsWithin(d, 0, 50 + 14 + 14 + 4)) {
            this.degrade("headers truncated");
            return;
        }

        // PixMap (colour image) at offset 0.
        const pmRowBytes = d.getUint16(4) & 0x3fff;
        const top = d.getInt16(6);
        const left = d.getInt16(8);
        const bottom = d.getInt16(10);
        const right = d.getInt16(12);
        const pixelSize = d.getInt16(32);

        this.width = right - left;
        this.height = bottom - top;

        if (this.width <= 0 || this.height <= 0
            || ![1, 2, 4, 8].includes(pixelSize)) {
            // Malformed or exotic (direct-colour) icon. Resources parse
            // eagerly at file load, so degrade to a 1x1 transparent pixel
            // rather than failing the whole file.
            this.degrade(`bounds ${this.width}x${this.height}, `
                + `pixel size ${pixelSize}`);
            return;
        }

        // Mask BitMap at 50, Icon BitMap at 64, iconData handle at 78.
        const maskRowBytes = d.getUint16(50 + 4);
        const iconRowBytes = d.getUint16(64 + 4);

        // Variable-length section starts after the three fixed headers.
        let offset = 50 + 14 + 14 + 4;
        const maskData = offset;
        offset += maskRowBytes * this.height;
        // Skip the 1-bit icon bitmap; the colour PixMap carries the image.
        offset += iconRowBytes * this.height;
        const colorTable = offset;

        // maskRowBytes, iconRowBytes, ctSize and pmRowBytes are all untrusted
        // header fields. Bounds-check every derived range against the resource
        // length before decoding so a corrupt cicn degrades rather than
        // throwing a RangeError that would abort the whole file load.
        if (!fitsWithin(d, maskData, maskRowBytes * this.height)) {
            this.degrade(`mask data (${maskRowBytes}x${this.height}) `
                + `out of range`);
            return;
        }
        const colorTableLength = colorTableByteLengthChecked(d, colorTable);
        if (colorTableLength === null) {
            this.degrade(`colour table at ${colorTable} out of range`);
            return;
        }
        offset += colorTableLength;
        const pixelData = offset;
        if (!fitsWithin(d, pixelData, pmRowBytes * this.height)) {
            this.degrade(`pixel data (${pmRowBytes}x${this.height}) `
                + `out of range`);
            return;
        }

        const colors = parseColorTable(d, colorTable, pixelSize);

        this.pixels = new Uint8ClampedArray(this.width * this.height * 4);
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const color: RGB = readIndexedPixel(d, pixelData, pmRowBytes,
                    x, y, pixelSize, colors);
                // Mask bit set means the pixel is opaque.
                const opaque = readBit(d, maskData, maskRowBytes, x, y);
                const out = (y * this.width + x) * 4;
                this.pixels[out] = color[0];
                this.pixels[out + 1] = color[1];
                this.pixels[out + 2] = color[2];
                this.pixels[out + 3] = opaque ? 255 : 0;
            }
        }
    }

    /**
     * Degrade a malformed/unsupported cicn to a 1x1 transparent pixel,
     * warning loudly with the resource id (matching the id-loading
     * convention) so a corrupt icon can't abort the whole file load.
     */
    private degrade(reason: string): void {
        console.warn(`cicn id ${this.id} is malformed or unsupported `
            + `(${reason}); using a blank icon`);
        this.width = 1;
        this.height = 1;
        this.pixels = new Uint8ClampedArray(4);
    }
}
