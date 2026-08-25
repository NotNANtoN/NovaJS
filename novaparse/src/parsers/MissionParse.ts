import { MissionData, MissionOfferLocation } from "novadatainterface/MissionData";
import { BaseData } from "novadatainterface/BaseData";
import { BaseParse } from "./BaseParse";
import { MisnResource } from "../resource_parsers/MisnResource";

export const standardCargoNames = [
    "food",
    "industrial goods",
    "medical supplies",
    "luxury goods",
    "metal",
    "equipment",
];

function getStringList(resource: MisnResource): string[] {
    var stringResource = resource.idSpace.STRH[4001];
    if (!stringResource || stringResource.data.byteLength < 2) {
        return standardCargoNames;
    }

    var d = stringResource.data;
    var count = d.getUint16(0);
    var offset = 2;
    var strings: string[] = [];
    for (var i = 0; i < count && offset < d.byteLength; i++) {
        var length = d.getUint8(offset++);
        var value = "";
        for (var j = 0; j < length && offset < d.byteLength; j++) {
            value += String.fromCharCode(d.getUint8(offset++));
        }
        strings.push(value);
    }
    return strings.length > 0 ? strings : standardCargoNames;
}

function parseCargo(resource: MisnResource): string | null {
    if (resource.cargoType < 0) {
        return null;
    }
    if (resource.cargoType === 1000) {
        return "random standard cargo";
    }
    return getStringList(resource)[resource.cargoType] || null;
}

function getDescription(resource: MisnResource, id: number,
    notFoundFunction: (message: string) => void, reportMissing = true) {
    if (id < 128) {
        return undefined;
    }
    var description = resource.idSpace.dësc[id];
    if (!description) {
        if (reportMissing) {
            notFoundFunction("No matching dësc " + id + " for mïsn " + resource.id);
        }
        return undefined;
    }
    return description;
}

function parseDescription(resource: MisnResource, id: number,
    notFoundFunction: (message: string) => void, reportMissing = true): string {
    return getDescription(
        resource, id, notFoundFunction, reportMissing)?.text ?? "";
}

export async function MissionParse(mission: MisnResource,
    notFoundFunction: (message: string) => void): Promise<MissionData> {
    var base: BaseData = await BaseParse(mission, notFoundFunction);

    // Nova creates the initial offer text from this mission-indexed range.
    // Explicit briefing fields below refer directly to dësc resources.
    var offerTextID = 4000 + mission.id - 128;
    var offerText = parseDescription(mission, offerTextID, notFoundFunction, false);
    var briefDescription = getDescription(
        mission, mission.briefText, notFoundFunction, false);

    return {
        ...base,
        availStel: mission.availStel,
        availLoc: mission.availLoc as MissionOfferLocation,
        availRecord: mission.availRecord,
        availRating: mission.availRating,
        availRandom: mission.availRandom,
        travelStel: mission.travelStel,
        returnStel: mission.returnStel,
        destination: mission.travelStel,
        returnDestination: mission.returnStel,
        cargoType: mission.cargoType,
        cargoQty: mission.cargoQty,
        cargo: parseCargo(mission),
        pickupMode: mission.pickupMode,
        dropOffMode: mission.dropOffMode,
        scanMask: mission.scanMask,
        payVal: mission.payVal,
        pay: mission.payVal,
        shipCount: mission.shipCount,
        shipSyst: mission.shipSyst,
        shipDude: mission.shipDude,
        shipGoal: mission.shipGoal,
        shipBehav: mission.shipBehav,
        shipNameID: mission.shipNameID,
        shipStart: mission.shipStart,
        compGovt: mission.compGovt,
        compReward: mission.compReward,
        shipSubtitle: mission.shipSubtitle,
        briefTextID: mission.briefText,
        briefGraphic: briefDescription?.graphic,
        briefMovieFile: briefDescription?.movieFile,
        briefFlags: briefDescription?.flags,
        quickBriefID: mission.quickBrief,
        loadCargTextID: mission.loadCargText,
        dumpCargoTextID: mission.dumpCargoText,
        compTextID: mission.compText,
        failTextID: mission.failText,
        shipDoneTextID: mission.shipDoneText,
        refuseTextID: mission.refuseText,
        offerText,
        briefText: parseDescription(mission, mission.briefText, notFoundFunction),
        quickBrief: parseDescription(mission, mission.quickBrief, notFoundFunction),
        loadCargText: parseDescription(mission, mission.loadCargText, notFoundFunction),
        dumpCargoText: parseDescription(mission, mission.dumpCargoText, notFoundFunction),
        compText: parseDescription(mission, mission.compText, notFoundFunction),
        failText: parseDescription(mission, mission.failText, notFoundFunction),
        shipDoneText: parseDescription(mission, mission.shipDoneText, notFoundFunction),
        refuseText: parseDescription(mission, mission.refuseText, notFoundFunction),
        timeLimit: mission.timeLimit,
        canAbort: mission.canAbort !== 0,
        auxShipCount: mission.auxShipCount,
        auxShipDude: mission.auxShipDude,
        auxShipSyst: mission.auxShipSyst,
        flags: mission.flags,
        flags2: mission.flags2,
        availShipType: mission.availShipType,
        availBits: mission.availBits,
        onAccept: mission.onAccept,
        onRefuse: mission.onRefuse,
        onSuccess: mission.onSuccess,
        onFailure: mission.onFailure,
        onAbort: mission.onAbort,
        onShipDone: mission.onShipDone,
        require: mission.require,
        datePostInc: mission.datePostInc,
        acceptButton: mission.acceptButton,
        refuseButton: mission.refuseButton,
        displayWeight: mission.displayWeight,
    };
}
