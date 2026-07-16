//
// MIT License
//
// Copyright (c) 2016 Tom Hancocks, 2018 Matthew Soulanille
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//

// (1) Adapted from https://github.com/dmaulikr/OpenNova/blob/master/ResourceKit/ResourceFork/Parsers/RKPictureResourceParser.m

// (2) Also see http://mirrors.apple2.org.za/apple.cabi.net/Graphics/PICT.and_QT.INFO/PICT.file.format.TI.txt


import { PNG } from "pngjs";
import { decodeUncompressedTiff } from "./tiff_decode.js";

const wordSize = 2; // 2 bytes

// Opcodes                      // Data Size and format (bytes)
const noop = 0x0000;            // 0
const clipRegion = 0x0001;      // region size (??)
const bitsRect = 0x0090;        // unpacked indexed pixmap
const bitsRgn = 0x0091;         // unpacked indexed pixmap + mask region
const packBitsRect = 0x0098;    // packed indexed pixmap
const packBitsRgn = 0x0099;     // packed indexed pixmap + mask region
const directBitsRect = 0x009A;  // direct pixmap
const directBitsRgn = 0x009B;   // direct pixmap + mask region
const eof = 0x00FF;             // 2?
const defaultHilite = 0x001E;   // 0?
const longComment = 0x00A1;     // kind, size = 4 + data
const extendedHeader = 0x0C00;  // 24
// QuickTime-embedded image (e.g. "TIFF (Uncompressed)"); QuickDraw-only
// readers fall through to a "QuickTime needed" text banner drawn after it.
const compressedQuickTime = 0x8200;
const uncompressedQuickTime = 0x8201;

// Mac Rectangles are structs of this form:
//  int16_t y1
//  int16_t x1
//  int16_t y2
//  int16_t x2


class PICTParse {
    PNG: PNG;
    yRatio: number;
    xRatio: number;
    pos: number;
    d: DataView;
    constructor(dataView: DataView) {
        this.d = dataView;
        this.pos = 0;

        // first two bytes are unused
        this.pos += 2;

        // Frame of pict
        var frame = this.readQDRect();

        // Version of the PICT. Only version 2 is supported.
        var vers = this.reaDWord();

        if (vers !== 0x1102ff) {
            throw new Error("Wrong PICT version. Must be version 2");
        }

        // Expect an extended header
        var opcode = this.readOpcode();

        if (opcode !== extendedHeader) {
            throw new Error("PICT did not have extended header.");
        }

        // Nova uses two header versions
        var headerVersion = this.reaDWord();

        // Note that js bitwise operators first convert the number into int32_t
        if ((headerVersion >>> 16) !== 0xFFFE) {
            // Standard Header Version

            // Determine image resolution
            this.log(this.pos);
            var y2 = this.readFixedPoint();
            var x2 = this.readFixedPoint();
            var w2 = this.readFixedPoint();
            var h2 = this.readFixedPoint();

            this.log(frame);
            this.log([y2, x2, w2, h2]);

            this.xRatio = (frame.x2 - frame.x1) / (w2 - x2);
            this.yRatio = (frame.y2 - frame.y1) / (h2 - y2);
        }
        else {
            this.pos += 4 * 2; // 2 * uint32
            var rect = this.readQDRect();
            this.xRatio = (frame.x2 - frame.x1) / (rect.x2 - rect.x1);
            this.yRatio = (frame.y2 - frame.y1) / (rect.y2 - rect.y1);
        }

        // Verify ratio is valid
        if (this.xRatio <= 0 || this.yRatio <= 0) {
            throw new Error("Got invalid ratio: " + this.xRatio + ", " + this.yRatio);
        }

        this.PNG = this.runOpcodes();
    }

    runOpcodes() {
        while (this.pos < this.d.byteLength) {
            var op = this.readOpcode();

            if (op == eof) {
                break;
            }
            switch (op) {
                case clipRegion:
                    this.log("Got Opcode clipRegion");
                    this.readRegionWithRect();
                    break;
                case directBitsRect:
                    this.log("Got Opcode directBitsRect");
                    return this.parseDirectBitsRect(false);
                case directBitsRgn:
                    this.log("Got Opcode directBitsRgn");
                    return this.parseDirectBitsRect(true);
                case bitsRect:
                    this.log("Got Opcode bitsRect");
                    return this.parseIndirectBitsRect(false, false);
                case bitsRgn:
                    this.log("Got Opcode bitsRgn");
                    return this.parseIndirectBitsRect(false, true);
                case packBitsRect:
                    this.log("Got Opcode packBitsRect");
                    return this.parseIndirectBitsRect(true, false);
                case packBitsRgn:
                    this.log("Got Opcode packBitsRgn");
                    return this.parseIndirectBitsRect(true, true);
                case compressedQuickTime:
                    this.log("Got Opcode compressedQuickTime");
                    return this.parseCompressedQuickTime();
                case uncompressedQuickTime: {
                    // Only carries an optional matte; the image itself
                    // follows as a normal (direct)Bits opcode.
                    this.log("Got Opcode uncompressedQuickTime");
                    // NOT `this.pos += this.reaDWord()`: += reads this.pos
                    // BEFORE reaDWord advances it, losing the size field's
                    // own 4 bytes.
                    const qtSize = this.reaDWord();
                    this.pos += qtSize;
                    break;
                }
                case longComment:
                    this.log("Got Opcode longComment");
                    this.parseLongComment();
                    break;
                case noop:
                    this.log("Got Opcode noop");
                    break;
                case extendedHeader:
                    this.log("Got Opcode extendedHandler");
                    break;
                case defaultHilite:
                    this.log("Got Opcode defaultHilite");
                    break;
                default:
                    // Graphics-state, shape, text, and reserved opcodes
                    // don't affect the bitmap we extract; skip per the
                    // QuickDraw v2 size table.
                    this.skipOpcode(op);
            }
        }
        throw new Error("Did not get a picture");
    }

    /**
     * Skips a non-image opcode using the PICT v2 data-size table (Inside
     * Macintosh: Imaging With QuickDraw, appendix A; see also (2)).
     * Throws on opcodes whose size is unknowable.
     */
    skipOpcode(op: number) {
        // Zero-data opcodes: hiliteMode, frame/paint/erase/invert/fill
        // SameRect/SameRRect/SameOval/SamePoly/SameRgn.
        if (op === 0x001C || (op >= 0x0038 && op <= 0x003C)
            || (op >= 0x0048 && op <= 0x004C) || (op >= 0x0058 && op <= 0x005C)
            || (op >= 0x0078 && op <= 0x007C) || (op >= 0x0088 && op <= 0x008C)) {
            return;
        }
        // Fixed-size state and shape opcodes.
        const fixedSizes: { [op: number]: number } = {
            0x0003: 2, // textFont
            0x0004: 1, // textFace
            0x0005: 2, // textMode
            0x0007: 4, // penSize
            0x0008: 2, // penMode
            0x0009: 8, // penPattern
            0x000A: 8, // fillPattern
            0x000B: 4, // ovalSize
            0x000C: 4, // origin
            0x000D: 2, // textSize
            0x000E: 4, // foreColor
            0x000F: 4, // backColor
            0x0010: 8, // txRatio
            0x0011: 1, // versionOp
            0x0015: 2, // pnLocHFrac
            0x0016: 2, // chExtra
            0x001A: 6, // rgbFgColor
            0x001B: 6, // rgbBkColor
            0x001D: 6, // hiliteColor
            0x001F: 6, // opColor
            0x0020: 8, // line
            0x0021: 4, // lineFrom
            0x0022: 6, // shortLine
            0x0023: 2, // shortLineFrom
            0x00A0: 2, // shortComment
        };
        if (fixedSizes[op] !== undefined) {
            this.pos += fixedSizes[op];
            return;
        }
        // frame/paint/erase/invert/fill Rect, RRect, Oval: an 8-byte rect.
        if ((op >= 0x0030 && op <= 0x0034) || (op >= 0x0040 && op <= 0x0044)
            || (op >= 0x0050 && op <= 0x0054)) {
            this.pos += 8;
            return;
        }
        // Arcs: rect + 2 angles; SameArc: 2 angles.
        if (op >= 0x0060 && op <= 0x0064) {
            this.pos += 12;
            return;
        }
        if (op >= 0x0068 && op <= 0x006C) {
            this.pos += 4;
            return;
        }
        // NOTE: sized skips below read the length into a variable first.
        // `this.pos += this.readWord()` would be wrong: += reads this.pos
        // BEFORE readWord advances it, silently dropping the length
        // field's own bytes from the skip.

        // Polygons and regions are size-prefixed (size includes itself).
        if ((op >= 0x0070 && op <= 0x0074) || (op >= 0x0080 && op <= 0x0084)) {
            this.skipRegion();
            return;
        }
        // Text: longText has a 4-byte point, dh/dvText a 1-byte offset,
        // dhdvText two; all followed by a length-prefixed string.
        if (op === 0x0028 || op === 0x0029 || op === 0x002A || op === 0x002B) {
            this.pos += op === 0x0028 ? 4 : op === 0x002B ? 2 : 1;
            const textLength = this.readByte();
            this.pos += textLength;
            return;
        }
        // fontName, lineJustify, glyphState: 2-byte length + data.
        if (op >= 0x002C && op <= 0x002E) {
            const dataLength = this.readWord();
            this.pos += dataLength;
            return;
        }
        // Reserved ranges from the spec's table.
        if ((op >= 0x0092 && op <= 0x0097) || (op >= 0x00A2 && op <= 0x00AF)) {
            const dataLength = this.readWord();
            this.pos += dataLength;
            return;
        }
        if (op >= 0x00B0 && op <= 0x00CF) {
            return;
        }
        if (op >= 0x00D0 && op <= 0x00FE) {
            const dataLength = this.reaDWord();
            this.pos += dataLength;
            return;
        }
        if (op >= 0x0100 && op <= 0x01FF) {
            this.pos += 2;
            return;
        }
        if (op >= 0x0200 && op <= 0x02FE) {
            this.pos += 4;
            return;
        }
        if (op >= 0x8000 && op <= 0x80FF) {
            return;
        }
        if (op >= 0x8100 && op <= 0xFFFF) {
            const dataLength = this.reaDWord();
            this.pos += dataLength;
            return;
        }
        // Remaining ops (e.g. 0x12-0x14 pixel patterns) have data sizes
        // that depend on their contents; misparsing would corrupt the
        // rest of the stream, so fail loudly instead.
        throw new Error("Unsupported Opcode: 0x" + op.toString(16) + " at position " + this.pos);
    }

    readDataUint8(len: number) {
        var data = Array(len);
        for (var i = 0; i < len; i++) {
            data[i] = this.readByte();
        }

        return data;
    };
    readData(len: number): DataView {
        var data = new DataView(this.d.buffer, this.d.byteOffset + this.pos, len);
        this.pos += len;
        return data;
    };

    packBitsDecode(valueSize: number, data: DataView) {
        // valueSize is in bytes, byteLength is how many bytes to read
        var result: Array<number> = []; // uint8_t
        var pos = 0;
        var length = data.byteLength;
        if (valueSize > 4) {
            throw new Error("valueSize too large. Must be <= 4 but got " + valueSize);
        }

        var run;
        while (pos < length) {
            var count = data.getUint8(pos);
            pos++;
            this.log("count: " + count);

            if (count < 128) {
                run = (1 + count) * valueSize;
                for (let i = 0; i < run; i++) {
                    result.push(data.getUint8(pos + i));
                }
                pos += run;
            }

            else {
                // Expand the repeat compression
                run = 256 - count;
                var val = [];
                for (let i = 0; i < valueSize; i++) {
                    val.push(data.getUint8(pos + i));
                }
                pos += valueSize;
                for (let i = 0; i <= run; i++) {
                    result = result.concat(val);
                }
            }

        }

        return result;
    };

    parseDirectBitsRect(withMaskRegion: boolean): PNG {
        var px = this.parsePixMap();
        var sourceRect = this.readWHRect();
        var destinationRect = this.readWHRect();

        // The next 2 bytes represent the "mode" for the direct bits packing. However
        // this doesn't seem to be required with the images included in EV Nova.
        this.pos += 2;

        if (withMaskRegion) {
            this.skipRegion();
        }

        var raw, pxArray, pxShortArray: Array<number>;

        if (px.packType === 3) {
            raw = Array(px.rowBytes);
            //pxShortArray = Array(sourceRect.height * (px.rowBytes + 1));
        }
        else if (px.packType === 4) {
            raw = Array(Math.floor(px.cmpCount * px.rowBytes / 4));
            //pxArray = Array(Math.floor(sourceRect.height * (px.rowBytes + 3) / 4));
        }
        else {
            throw new Error("Unsupported pack type: " + px.packType);
        }
        pxShortArray = Array(sourceRect.height * (px.rowBytes + 1));
        pxArray = Array(Math.floor(sourceRect.height * (px.rowBytes + 3) / 4));

        var pxBufOffset = 0;
        var packedBytesCount = 0;
        this.log(px);
        for (let scanline = 0; scanline < sourceRect.height; scanline++) {
            // Narrow pictures don't use the pack bits compression. 
            // See (2) Table 5
            // Below 8 bits, it is uncompressed.
            if (px.rowBytes < 8) {
                // gets px.rowBytes number of bytes from d
                // Then, puts sourceRect.width * 2 of them in 'raw'
                var data = this.readDataUint8(px.rowBytes);
                raw = data.slice(0, sourceRect.width * 2);
            }
            else { // Pack bits compression
                if (px.rowBytes > 250) {
                    packedBytesCount = this.readWord();
                }
                else {
                    packedBytesCount = this.readByte();
                }

                var encodedScanLine = this.readData(packedBytesCount);
                var decodedScanLine = [];
                if (px.packType === 3) {
                    decodedScanLine = this.packBitsDecode(2, encodedScanLine);
                    raw = decodedScanLine.slice(0, sourceRect.width * 2);
                }
                else {
                    // packType 4 scanlines are planar: cmpCount planes of
                    // bounds.width bytes each (AAA...RRR...GGG...BBB or
                    // RRR...GGG...BBB). Truncating to width * 2 like packType 3
                    // kept only the first two planes, which is why 32-bit PICTs
                    // rendered yellow (RGB: blue lost) or red (ARGB: green and
                    // blue lost).
                    decodedScanLine = this.packBitsDecode(1, encodedScanLine);
                    raw = decodedScanLine.slice(0, px.cmpCount * px.bounds.width);
                }
            }

            if (px.packType === 3) {
                // Store decoded pixel data
                for (let i = 0; i < sourceRect.width; i++) {
                    pxShortArray[pxBufOffset + i] = ((((0xFF & raw[2 * i]) << 8) >>> 0)
                        | ((0xFF & raw[2 * i + 1]) >>> 0)) >>> 0;
                }
            }
            else {
                // RGB planes at stride bounds.width. When cmpCount is 4 the
                // first plane is alpha, which QuickDraw ignores (it is often
                // garbage in the wild) — skip it and force opaque, matching
                // ResForge.
                // >>> 0 so javascript interprets it as unsigned
                // https://stackoverflow.com/questions/6798111/bitwise-operations-on-32-bit-unsigned-ints
                const skip = px.cmpCount === 4 ? px.bounds.width : 0;
                for (let i = 0; i < sourceRect.width; i++) {
                    pxArray[pxBufOffset + i] = (0xFF000000
                        | ((raw[skip + i] & 0xFF) << 16)
                        | ((raw[skip + px.bounds.width + i] & 0xFF) << 8)
                        | (raw[skip + 2 * px.bounds.width + i] & 0xFF)) >>> 0;
                }
            }

            pxBufOffset += sourceRect.width;
        } // Matches for (let scanline...

        // Finally we need to unpack all of the pixel data. This is due to the pixels being
        // stored in an RGB 555 format. CoreGraphics does not expose a way of cleanly/publically
        // parsing this type of encoding so we need to convert it to a more modern
        // representation, such as RGBA 8888

        var sourceLength = destinationRect.width * destinationRect.height;
        var rgbCount = sourceLength * 4;
        var rgbRaw = Array(rgbCount);

        if (px.packType === 3) {
            for (let p = 0, i = 0; i < sourceLength; i++) {
                rgbRaw[p++] = (((pxShortArray[i] & 0x7c00) >>> 10) << 3) >>> 0;
                rgbRaw[p++] = (((pxShortArray[i] & 0x03e0) >>> 5) << 3) >>> 0;
                rgbRaw[p++] = ((pxShortArray[i] & 0x001f) << 3) >>> 0;
                rgbRaw[p++] = 0xFF; // UINT8_MAX
            }
        }
        else {
            for (let p = 0, i = 0; i < sourceLength; i++) {
                rgbRaw[p++] = ((pxArray[i] & 0xFF0000) >>> 16);
                rgbRaw[p++] = (pxArray[i] & 0xFF00) >>> 8;
                rgbRaw[p++] = (pxArray[i] & 0xFF) >>> 0;
                rgbRaw[p++] = (pxArray[i] & 0xFF000000) >>> 24;
            }
        }


        var png = new PNG({ width: sourceRect.width, height: sourceRect.height });
        for (var y = 0; y < png.height; y++) {
            for (var x = 0; x < png.width; x++) {
                var idx = (png.width * y + x) << 2;
                png.data[idx] = rgbRaw[idx];
                png.data[idx + 1] = rgbRaw[idx + 1];
                png.data[idx + 2] = rgbRaw[idx + 2];
                png.data[idx + 3] = rgbRaw[idx + 3];
            }
        }
        return png;

    }

    /**
     * Indexed-color pixmaps ((pack)BitsRect/Rgn): pixel data is a color
     * table index per pixel, one row per scanline, packbits-compressed for
     * the packed opcodes. The mask region of the Rgn variants is skipped,
     * like ResForge does.
     */
    parseIndirectBitsRect(packed: boolean, withMaskRegion: boolean): PNG {
        // Unlike directBits, the pixmap here has no baseAddress field.
        const rowBytesAndFlags = this.readWord();
        const rowBytes = rowBytesAndFlags & 0x3FFF;
        const isPixmap = (rowBytesAndFlags & 0x8000) !== 0;
        const bounds = this.readWHRect();

        let pixelSize = 1;
        // 1-bit BitMaps have no color table; 1 is black, 0 is white.
        let colorTable = [0xFFFFFFFF, 0xFF000000];
        if (isPixmap) {
            this.pos += 2 + 2 + 4 + 4 + 4 + 2; // pmVersion..pixelType
            pixelSize = this.readWord();
            this.pos += 2 + 2 + 4 + 4 + 4; // cmpCount..pmReserved
            colorTable = this.readColorTable();
        }
        if (pixelSize !== 1 && pixelSize !== 2 && pixelSize !== 4 && pixelSize !== 8) {
            throw new Error("Unsupported indexed pixel size: " + pixelSize);
        }

        const sourceRect = this.readWHRect();
        this.readWHRect(); // destination rect
        this.pos += 2; // transfer mode
        if (withMaskRegion) {
            this.skipRegion();
        }

        const png = new PNG({ width: sourceRect.width, height: sourceRect.height });
        const pixelsPerByte = 8 / pixelSize;
        const mask = (1 << pixelSize) - 1;
        for (let y = 0; y < sourceRect.height; y++) {
            let row: number[];
            if (!packed || rowBytes < 8) {
                row = this.readDataUint8(rowBytes);
            } else {
                const packedBytesCount = rowBytes > 250 ? this.readWord() : this.readByte();
                row = this.packBitsDecode(1, this.readData(packedBytesCount));
            }
            for (let x = 0; x < sourceRect.width; x++) {
                const byte = row[Math.floor(x / pixelsPerByte)] ?? 0;
                const shift = (pixelsPerByte - 1 - (x % pixelsPerByte)) * pixelSize;
                const color = colorTable[(byte >> shift) & mask] ?? 0xFF000000;
                const idx = (y * sourceRect.width + x) * 4;
                png.data[idx] = (color >>> 16) & 0xFF;
                png.data[idx + 1] = (color >>> 8) & 0xFF;
                png.data[idx + 2] = color & 0xFF;
                png.data[idx + 3] = 0xFF;
            }
        }
        return png;
    }

    /**
     * Reads a QuickDraw ColorTable and returns 0xAARRGGBB entries indexed
     * by pixel value.
     */
    readColorTable(): number[] {
        this.pos += 4; // ctSeed
        const ctFlags = this.readWord();
        const ctSize = this.readWord();
        const table: number[] = [];
        for (let i = 0; i <= ctSize; i++) {
            const value = this.readWord();
            const r = this.readWord() >> 8;
            const g = this.readWord() >> 8;
            const b = this.readWord() >> 8;
            // With the high flag set (a "device" table) the value field is
            // meaningless and entries are in index order.
            const index = (ctFlags & 0x8000) ? i : value & 0xFF;
            table[index] = (0xFF000000 | (r << 16) | (g << 8) | b) >>> 0;
        }
        return table;
    }

    /**
     * A QuickTime-embedded image (see QuickTime 1993 developer guide). The
     * wrapper carries an optional matte and mask, then an ImageDescription
     * naming the compressor, then the compressed data. Nova plug-ins use
     * the "TIFF (Uncompressed)" codec, which we can decode; anything else
     * throws (QuickDraw itself just draws a "QuickTime needed" banner).
     */
    parseCompressedQuickTime(): PNG {
        const size = this.reaDWord();
        const end = this.pos + size;
        this.pos += 2 + 36; // version, transform matrix
        const matteSize = this.reaDWord();
        this.pos += 8; // matte rect
        this.pos += 2 + 8 + 4; // transfer mode, source rect, accuracy
        const maskSize = this.reaDWord();
        this.pos += matteSize + maskSize;

        // ImageDescription
        const descStart = this.pos;
        const descSize = this.reaDWord();
        const compressor = String.fromCharCode(this.readByte(), this.readByte(),
            this.readByte(), this.readByte());
        if (compressor !== 'tiff') {
            throw new Error("Unsupported QuickTime compressor '" + compressor + "'");
        }
        this.pos = descStart + 44;
        const dataSize = this.reaDWord();
        this.pos = descStart + descSize;

        const png = decodeUncompressedTiff(this.readData(dataSize));
        this.pos = end;
        return png;
    }

    /** Skips a size-prefixed QuickDraw region (size includes itself). */
    skipRegion() {
        const size = this.readWord();
        this.pos += size - 2;
    }

    readRegionWithRect() {
        var size = this.readWord();
        var regionRect = {
            x: this.readWord() / this.xRatio,
            y: this.readWord() / this.yRatio,
            width: (this.readWord() / this.xRatio),
            height: (this.readWord() / this.yRatio)
        };
        regionRect.width -= regionRect.x;
        regionRect.height -= regionRect.y;
        var points = (size - 10) / 4;
        this.pos += 2 * 2 * points;
        return regionRect;
    }
    parsePixMap() {
        return {
            baseAddress: this.reaDWord(),
            rowBytes: (this.readWord() & 0x7FFF) >>> 0,

            bounds: this.readWHRect(),

            pmVersion: this.readWord(),
            packType: this.readWord(),
            packSize: this.reaDWord(),

            hRes: this.readFixedPoint(),
            vRes: this.readFixedPoint(),

            pixelType: this.readWord(),
            pixelSize: this.readWord(),
            cmpCount: this.readWord(),
            cmpSize: this.readWord(),

            planeBytes: this.reaDWord(),
            pmTable: this.reaDWord(),
            pmReserved: this.reaDWord()
        };
    };

    readQDRect() {
        var rect = {
            y1: this.d.getUint16(this.pos),
            x1: this.d.getUint16(this.pos + wordSize),
            y2: this.d.getUint16(this.pos + 2 * wordSize),
            x2: this.d.getUint16(this.pos + 3 * wordSize)
        };
        this.pos += wordSize * 4;
        return rect;
    }
    readWHRect() {
        var r = this.readQDRect();
        return {
            x: r.x1,
            y: r.y1,
            width: r.x2 - r.x1,
            height: r.y2 - r.y1
        };
    };
    readFixedPoint() {
        var point = this.d.getUint32(this.pos) / (1 << 16);
        this.pos += 4;
        return point;
    };
    readByte() {
        var byte = this.d.getUint8(this.pos);
        this.pos++;
        return byte;
    };
    reaDWord() {
        var word = this.d.getUint32(this.pos);
        this.pos += 4;
        return word;
    };
    readWord() {
        var word = this.d.getUint16(this.pos);
        this.pos += 2;
        return word;
    };
    readOpcode() {
        this.pos += this.pos % 2;
        return this.readWord();
    };
    parseLongComment() {
        var kind = this.readWord();
        var length = this.readWord();
        this.pos += length;
    }
    log(_thing: any) {
        //console.log(text);
    }
};


export { PICTParse };

