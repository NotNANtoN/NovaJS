import { Resource } from "resource_fork";
import { NovaResources } from "./ResourceHolderBase";
import { BaseResource } from "./NovaResourceBase";

const LINK_SYST_OFFSET = 0;
const GOVERNMENT_OFFSET = 2;
const AI_TYPE_OFFSET = 4;
const AGGRESS_OFFSET = 6;
const COWARD_OFFSET = 8;
const SHIP_TYPE_OFFSET = 10;
const WEAPON_TYPES_OFFSET = 12;
const WEAPON_COUNTS_OFFSET = 20;
const AMMO_LOADS_OFFSET = 28;
const WEAPON_SLOT_COUNT = 4;
const CREDITS_OFFSET = 36;
const SHIELD_MOD_OFFSET = 40;
const HAIL_PICT_OFFSET = 42;
const COMM_QUOTE_OFFSET = 44;
const HAIL_QUOTE_OFFSET = 46;
const LINK_MISSION_OFFSET = 48;
const FLAGS_OFFSET = 50;
const ACTIVE_ON_OFFSET = 52;
const ACTIVE_ON_LENGTH = 255;
const GRANT_CLASS_OFFSET = 308;
const GRANT_PROB_OFFSET = 310;
const GRANT_COUNT_OFFSET = 312;
const SHIP_SUBTITLE_OFFSET = 314;
const SHIP_SUBTITLE_LENGTH = 64;
const COLOUR_OFFSET = 378;
const FLAGS2_OFFSET = 382;

function int16Array(
    data: DataView,
    offset: number,
    count: number,
): number[] {
    return Array.from(
        { length: count },
        (_, index) => data.getInt16(offset + index * 2),
    );
}

function fixedCString(
    data: DataView,
    offset: number,
    length: number,
): string {
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

/**
 * Raw `përs` records are 400 bytes in retail Nova. The Bible describes eight
 * weapon slots, but the retail record allocates four slots at offsets 12-34;
 * interpreting eight slots would consume Credits and the following fields.
 */
class PersResource extends BaseResource {
    linkSyst: number;
    government: number;
    aiType: number;
    aggress: number;
    coward: number;
    shipType: number;
    weaponTypes: number[];
    weaponCounts: number[];
    ammoLoads: number[];
    credits: number;
    shieldMod: number;
    hailPict: number;
    commQuote: number;
    hailQuote: number;
    linkMission: number;
    flags: number;
    activeOn: string;
    shipSubtitle: string;
    grantClass: number;
    grantProb: number;
    grantCount: number;
    colour: number;
    flags2: number;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const d = this.data;

        this.linkSyst = d.getInt16(LINK_SYST_OFFSET);
        this.government = d.getInt16(GOVERNMENT_OFFSET);
        this.aiType = d.getInt16(AI_TYPE_OFFSET);
        this.aggress = d.getInt16(AGGRESS_OFFSET);
        this.coward = d.getInt16(COWARD_OFFSET);
        this.shipType = d.getInt16(SHIP_TYPE_OFFSET);
        this.weaponTypes = int16Array(
            d, WEAPON_TYPES_OFFSET, WEAPON_SLOT_COUNT);
        this.weaponCounts = int16Array(
            d, WEAPON_COUNTS_OFFSET, WEAPON_SLOT_COUNT);
        this.ammoLoads = int16Array(
            d, AMMO_LOADS_OFFSET, WEAPON_SLOT_COUNT);
        this.credits = d.getInt32(CREDITS_OFFSET);
        this.shieldMod = d.getInt16(SHIELD_MOD_OFFSET);
        this.hailPict = d.getInt16(HAIL_PICT_OFFSET);
        this.commQuote = d.getInt16(COMM_QUOTE_OFFSET);
        this.hailQuote = d.getInt16(HAIL_QUOTE_OFFSET);
        this.linkMission = d.getInt16(LINK_MISSION_OFFSET);
        this.flags = d.getUint16(FLAGS_OFFSET);
        this.activeOn = fixedCString(
            d, ACTIVE_ON_OFFSET, ACTIVE_ON_LENGTH);
        this.shipSubtitle = fixedCString(
            d, SHIP_SUBTITLE_OFFSET, SHIP_SUBTITLE_LENGTH);
        this.grantClass = d.getInt16(GRANT_CLASS_OFFSET);
        this.grantProb = d.getInt16(GRANT_PROB_OFFSET);
        this.grantCount = d.getInt16(GRANT_COUNT_OFFSET);
        this.colour = d.getUint32(COLOUR_OFFSET);
        this.flags2 = d.getUint16(FLAGS2_OFFSET);
    }
}

export { PersResource };
