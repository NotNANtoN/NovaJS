import { BaseData, getDefaultBaseData } from "./BaseData";

export enum MissionOfferLocation {
    MissionComputer = 0,
    Bar = 1,
    Ship = 2,
    MainSpaceport = 3,
    Trading = 4,
    Shipyard = 5,
    Outfit = 6,
}

export interface MissionData extends BaseData {
    availStel: number;
    availLoc: MissionOfferLocation;
    availRecord: number;
    availRating: number;
    availRandom: number;
    travelStel: number;
    returnStel: number;
    destination: number;
    returnDestination: number;
    cargoType: number;
    cargoQty: number;
    cargo: string | null;
    pickupMode: number;
    dropOffMode: number;
    scanMask: number;
    payVal: number;
    pay: number;
    shipCount: number;
    shipSyst: number;
    shipDude: number;
    shipGoal: number;
    shipBehav: number;
    shipNameID: number;
    shipStart: number;
    compGovt: number;
    compReward: number;
    shipSubtitle: number;
    briefTextID: number;
    briefGraphic?: number;
    briefMovieFile?: string;
    briefFlags?: number;
    quickBriefID: number;
    loadCargTextID: number;
    dumpCargoTextID: number;
    compTextID: number;
    failTextID: number;
    shipDoneTextID: number;
    refuseTextID: number;
    offerText: string;
    briefText: string;
    quickBrief: string;
    loadCargText: string;
    dumpCargoText: string;
    compText: string;
    failText: string;
    shipDoneText: string;
    refuseText: string;
    timeLimit: number;
    canAbort: boolean;
    auxShipCount: number;
    auxShipDude: number;
    auxShipSyst: number;
    flags: number;
    flags2: number;
    availShipType: number;
    availBits: string;
    onAccept: string;
    onRefuse: string;
    onSuccess: string;
    onFailure: string;
    onAbort: string;
    onShipDone: string;
    require: number[];
    datePostInc: number;
    acceptButton: string;
    refuseButton: string;
    displayWeight: number;
}

export function getDefaultMissionData(): MissionData {
    return {
        ...getDefaultBaseData(),
        availStel: -1,
        availLoc: MissionOfferLocation.MissionComputer,
        availRecord: 0,
        availRating: -1,
        availRandom: 100,
        travelStel: -1,
        returnStel: -1,
        destination: -1,
        returnDestination: -1,
        cargoType: -1,
        cargoQty: -1,
        cargo: null,
        pickupMode: -1,
        dropOffMode: -1,
        scanMask: 0,
        payVal: 0,
        pay: 0,
        shipCount: -1,
        shipSyst: -1,
        shipDude: -1,
        shipGoal: -1,
        shipBehav: -1,
        shipNameID: -1,
        shipStart: 0,
        compGovt: -1,
        compReward: 0,
        shipSubtitle: -1,
        briefTextID: -1,
        quickBriefID: -1,
        loadCargTextID: -1,
        dumpCargoTextID: -1,
        compTextID: -1,
        failTextID: -1,
        shipDoneTextID: -1,
        refuseTextID: -1,
        offerText: "",
        briefText: "",
        quickBrief: "",
        loadCargText: "",
        dumpCargoText: "",
        compText: "",
        failText: "",
        shipDoneText: "",
        refuseText: "",
        timeLimit: -1,
        canAbort: true,
        auxShipCount: -1,
        auxShipDude: -1,
        auxShipSyst: -1,
        flags: 0,
        flags2: 0,
        availShipType: -1,
        availBits: "",
        onAccept: "",
        onRefuse: "",
        onSuccess: "",
        onFailure: "",
        onAbort: "",
        onShipDone: "",
        require: [],
        datePostInc: 0,
        acceptButton: "",
        refuseButton: "",
        displayWeight: 0,
    };
}
