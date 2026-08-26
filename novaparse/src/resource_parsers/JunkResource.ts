import { Resource } from "resource_fork";
import { NovaResources } from "./ResourceHolderBase";
import { BaseResource } from "./NovaResourceBase";

const SOLD_AT_OFFSET = 0;
const BOUGHT_AT_OFFSET = 16;
const BASE_PRICE_OFFSET = 32;
const FLAGS_OFFSET = 34;
const SCAN_MASK_OFFSET = 36;
const LC_NAME_OFFSET = 38;
const ABBREVIATION_OFFSET = 102;
const BUY_ON_OFFSET = 166;
const SELL_ON_OFFSET = 421;

function int16Array(data: DataView, offset: number, count: number): number[] {
    return Array.from(
        { length: count },
        (_, index) => data.getInt16(offset + index * 2),
    );
}

function fixedCString(data: DataView, offset: number, length: number): string {
    const end = Math.min(data.byteLength, offset + length);
    let terminator = end;
    for (let index = offset; index < end; index++) {
        if (data.getUint8(index) === 0) {
            terminator = index;
            break;
        }
    }
    const bytes = new Uint8Array(
        data.buffer,
        data.byteOffset + offset,
        Math.max(0, terminator - offset),
    );
    return new TextDecoder("macintosh").decode(bytes);
}

class JunkResource extends BaseResource {
    soldAt: number[];
    boughtAt: number[];
    basePrice: number;
    flags: number;
    scanMask: number;
    lcName: string;
    abbreviation: string;
    buyOn: string;
    sellOn: string;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const d = this.data;

        // Bible, jünk: "SoldAt1-8 ID number of the stellar object where the
        // commodity is sold" and "BoughtAt1-8 ID number of the stellar object
        // where the commodity is purchased." Retail records are 676 bytes.
        this.soldAt = int16Array(d, SOLD_AT_OFFSET, 8);
        this.boughtAt = int16Array(d, BOUGHT_AT_OFFSET, 8);
        // Bible: "BasePrice The average price of the commodity".
        this.basePrice = d.getInt16(BASE_PRICE_OFFSET);
        this.flags = d.getUint16(FLAGS_OFFSET);
        this.scanMask = d.getUint16(SCAN_MASK_OFFSET);
        this.lcName = fixedCString(d, LC_NAME_OFFSET, 64);
        this.abbreviation = fixedCString(d, ABBREVIATION_OFFSET, 64);
        // Bible: "This jünk will only be available to be bought when this
        // expression evaluates true"; SellOn applies the equivalent sell gate.
        this.buyOn = fixedCString(d, BUY_ON_OFFSET, 255);
        this.sellOn = fixedCString(d, SELL_ON_OFFSET, 255);
    }
}

export { JunkResource };
