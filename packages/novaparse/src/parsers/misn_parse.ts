import { MissionData } from "novadatainterface/mission_data";
import { BaseData } from "novadatainterface/base_data";
import { MisnResource } from "../resource_parsers/misn_resource.js";
import { NovaResources } from "../resource_parsers/resource_holder_base.js";
import { BaseParse } from "./base_parse.js";

/**
 * The dësc id holding a mission's offer text (shown in the mission
 * computer / bar list): 4000 + (mïsn id - 128), per the EVN Bible.
 */
const OFFER_TEXT_DESC_BASE = 4000;
const MISN_ID_BASE = 128;

/** Looks up a dësc's text; "" when the id is -1 or the dësc is absent. */
function descText(idSpace: NovaResources, id: number): string {
    if (id < 0) {
        return "";
    }
    return idSpace.dësc[id]?.text ?? "";
}

/**
 * The global PICT id of a dësc's Graphic field (shown alongside the
 * text in mission dialogs); null when the id is -1, the dësc is absent,
 * the dësc has no graphic, or the PICT can't be resolved.
 */
function descGraphic(idSpace: NovaResources, id: number): string | null {
    if (id < 0) {
        return null;
    }
    const graphic = idSpace.dësc[id]?.graphic ?? -1;
    if (graphic < 0) {
        return null;
    }
    return idSpace.PICT[graphic]?.globalID ?? null;
}

/** spöb ids occupy 128-2175; other values are ranged specials. */
const SPOB_ID_MIN = 128;
const SPOB_ID_MAX = 2175;

/**
 * Resolves a stellar reference to a global spöb id when it is a plain
 * id; null for the special ranges (govt-relative, random, etc.).
 */
function stellarId(idSpace: NovaResources, value: number): string | null {
    if (value < SPOB_ID_MIN || value > SPOB_ID_MAX) {
        return null;
    }
    return idSpace.spöb[value]?.globalID ?? null;
}

/** sÿst ids occupy 128-2175; other values are ranged specials. */
const SYST_ID_MIN = 128;
const SYST_ID_MAX = 2175;

/**
 * Resolves a ShipSyst/AuxShipSyst reference to a global sÿst id when
 * it is a plain id; null for the special ranges (-1..-6 relative,
 * govt-relative, adjacency).
 */
function systemId(idSpace: NovaResources, value: number): string | null {
    if (value < SYST_ID_MIN || value > SYST_ID_MAX) {
        return null;
    }
    return idSpace.sÿst[value]?.globalID ?? null;
}

/** Resolves a ShipDude/AuxShipDude reference to a global düde id. */
function dudeId(idSpace: NovaResources, value: number): string | null {
    if (value < 128) {
        return null;
    }
    return idSpace.düde[value]?.globalID ?? null;
}

/** The strings of a STR# reference; [] when -1 or absent. */
function strList(idSpace: NovaResources, id: number): string[] {
    if (id < 128) {
        return [];
    }
    return idSpace["STR#"][id]?.strings ?? [];
}

/**
 * Maps a parsed mïsn resource onto the MissionData shape served through
 * the data interface. Numeric stellar references stay raw (they encode
 * runtime-relative ranges; see mission_data.ts), while the dësc
 * briefing texts are resolved to strings here so the game never needs
 * a separate dësc data type.
 */
export async function MisnParse(misn: MisnResource,
    notFoundFunction: (m: string) => void): Promise<MissionData> {
    const base: BaseData = await BaseParse(misn, notFoundFunction);

    return {
        ...base,
        availStel: misn.availStel,
        availStelId: stellarId(misn.idSpace, misn.availStel),
        availLoc: misn.availLoc,
        availRecord: misn.availRecord,
        availRating: misn.availRating,
        availRandom: misn.availRandom,
        availBits: misn.availBits,
        availShipType: misn.availShipType,
        require: misn.require.toString(),
        travelStel: misn.travelStel,
        travelStelId: stellarId(misn.idSpace, misn.travelStel),
        returnStel: misn.returnStel,
        returnStelId: stellarId(misn.idSpace, misn.returnStel),
        cargoType: misn.cargoType,
        cargoQty: misn.cargoQty,
        pickupMode: misn.pickupMode,
        dropOffMode: misn.dropoffMode,
        scanMask: misn.scanMask,
        payVal: misn.payVal,
        compGovt: misn.compGovt,
        compReward: misn.compReward,
        timeLimit: misn.timeLimit,
        canAbort: Boolean(misn.canAbort),
        datePostInc: misn.datePostInc,
        dispWeight: misn.dispWeight,
        shipCount: misn.shipCount,
        shipSyst: misn.shipSyst,
        shipSystId: systemId(misn.idSpace, misn.shipSyst),
        shipDude: misn.shipDude,
        shipDudeId: dudeId(misn.idSpace, misn.shipDude),
        shipGoal: misn.shipGoal,
        shipBehav: misn.shipBehav,
        shipStart: misn.shipStart,
        shipNames: strList(misn.idSpace, misn.shipNameID),
        shipSubtitles: strList(misn.idSpace, misn.shipSubtitle),
        auxShipCount: misn.auxShipCount,
        auxShipDude: misn.auxShipDude,
        auxShipDudeId: dudeId(misn.idSpace, misn.auxShipDude),
        auxShipSyst: misn.auxShipSyst,
        auxShipSystId: systemId(misn.idSpace, misn.auxShipSyst),
        flags: {
            autoAbort: misn.autoAbort,
            hideDestArrows: misn.hideDestArrows,
            cantRefuse: misn.cantRefuse,
            remove100FuelOnAutoAbort: misn.remove100FuelOnAutoAbort,
            infiniteAuxShips: misn.infiniteAuxShips,
            failIfScanned: misn.failIfScanned,
            lose5xCompRewardOnAbort: misn.lose5xCompRewardOnAbort,
            jettisonPenalty: misn.jettisonPenalty,
            showGreenArrowInBriefing: misn.showGreenArrowInBriefing,
            showArrowForShipSyst: misn.showArrowForShipSyst,
            invisible: misn.invisible,
            freezeShipTypesAtStart: misn.freezeShipTypesAtStart,
            notForCargoShips: misn.notForCargoShips,
            notForWarships: misn.notForWarships,
            failIfBoardedByPirates: misn.failIfBoardedByPirates,
            notOfferedIfInsufficientCargoSpace:
                misn.notOfferedIfInsufficientCargoSpace,
            applyPayOnAutoAbort: misn.applyPayOnAutoAbort,
            failIfPlayerDisabledOrDestroyed:
                misn.failIfPlayerDisabledOrDestroyed,
        },
        onAccept: misn.onAccept,
        onRefuse: misn.onRefuse,
        onSuccess: misn.onSuccess,
        onFailure: misn.onFailure,
        onAbort: misn.onAbort,
        onShipDone: misn.onShipDone,
        offerText: descText(misn.idSpace,
            OFFER_TEXT_DESC_BASE + (misn.id - MISN_ID_BASE)),
        briefText: descText(misn.idSpace, misn.briefText),
        quickBrief: descText(misn.idSpace, misn.quickBrief),
        loadCargoText: descText(misn.idSpace, misn.loadCargText),
        dropOffCargoText: descText(misn.idSpace, misn.dropCargText),
        completionText: descText(misn.idSpace, misn.compText),
        failText: descText(misn.idSpace, misn.failText),
        refuseText: descText(misn.idSpace, misn.refuseText),
        shipDoneText: descText(misn.idSpace, misn.shipDoneText),
        acceptButton: misn.acceptButton,
        refuseButton: misn.refuseButton,
        offerPict: descGraphic(misn.idSpace,
            OFFER_TEXT_DESC_BASE + (misn.id - MISN_ID_BASE)),
        briefPict: descGraphic(misn.idSpace, misn.briefText),
        quickBriefPict: descGraphic(misn.idSpace, misn.quickBrief),
        loadCargoPict: descGraphic(misn.idSpace, misn.loadCargText),
        dropOffCargoPict: descGraphic(misn.idSpace, misn.dropCargText),
        completionPict: descGraphic(misn.idSpace, misn.compText),
        failPict: descGraphic(misn.idSpace, misn.failText),
        refusePict: descGraphic(misn.idSpace, misn.refuseText),
        shipDonePict: descGraphic(misn.idSpace, misn.shipDoneText),
    };
}
