import { IntfResource, IntfRect } from "../resource_parsers/intf_resource.js";
import {
    StatusBarData, StatusBarDataArea,
} from "novadatainterface/status_bar_data";
import { BaseParse } from "./base_parse.js";
import { BaseData } from "novadatainterface/base_data";

/** The default civilian status-bar background (PICT 700 / ïntf 128). */
const DEFAULT_STATUS_BKGND = 700;

/**
 * A Mac QuickDraw rectangle (top/left/bottom/right) as the status bar wants
 * it: an [x, y] position and an [width, height] size. A zero-area rectangle
 * (right=left or top=bottom) leaves a zero-size area, which the renderer
 * treats as "don't draw this indicator" (EVN Bible, ïntf section).
 */
function toArea(r: IntfRect): StatusBarDataArea {
    return {
        position: [r.left, r.top],
        size: [r.right - r.left, r.bottom - r.top],
    };
}

/** LCOL colours are stored as 0x00RRGGBB; drop the high byte for PIXI. */
function toColor(lcol: number): number {
    return lcol & 0xFFFFFF;
}

/**
 * Projects a parsed ïntf resource onto the StatusBarData interface the client
 * renders from: the areas become [position, size] rectangles, the LCOL colours
 * are masked to RGB, and StatusBkgnd is resolved to the background PICT's
 * global id. Values less than 128 (or a missing/truncated field) fall back to
 * the default civilian status bar (PICT 700).
 */
export async function StatusBarParse(intf: IntfResource, notFoundFunction: (m: string) => void): Promise<StatusBarData> {
    const base: BaseData = await BaseParse(intf, notFoundFunction);

    const bkgndId = intf.statusBackground >= 128
        ? intf.statusBackground : DEFAULT_STATUS_BKGND;
    const bkgndPict = intf.idSpace.PICT[bkgndId]
        ?? intf.idSpace.PICT[DEFAULT_STATUS_BKGND];
    let image: string;
    if (bkgndPict) {
        image = bkgndPict.globalID;
    } else {
        notFoundFunction(
            `No matching PICT ${bkgndId} for ïntf of id ${base.id}`);
        image = `${base.prefix}:${DEFAULT_STATUS_BKGND}`;
    }

    return {
        ...base,
        image,
        fontSize: intf.statusFontSize > 0 ? intf.statusFontSize : 12,
        subtitleSize: intf.subtitleSize > 0 ? intf.subtitleSize : 10,
        colors: {
            brightText: toColor(intf.brightText),
            dimText: toColor(intf.dimText),
            brightRadar: toColor(intf.brightRadar),
            dimRadar: toColor(intf.dimRadar),
            shield: toColor(intf.shieldColor),
            armor: toColor(intf.armorColor),
            fuelFull: toColor(intf.fuelFull),
            fuelPartial: toColor(intf.fuelPartial),
        },
        dataAreas: {
            radar: toArea(intf.radarArea),
            shield: toArea(intf.shieldArea),
            armor: toArea(intf.armorArea),
            fuel: toArea(intf.fuelArea),
            navigation: toArea(intf.navArea),
            weapons: toArea(intf.weaponArea),
            targeting: toArea(intf.targetArea),
            cargo: toArea(intf.cargoArea),
        },
    };
}
