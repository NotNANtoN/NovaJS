import { BaseData, getDefaultBaseData } from "./base_data.js";

/**
 * A mission ("mïsn"): where and when it is offered, where the player
 * must travel, what cargo is carried, the payment, and the NCB set
 * strings run at each lifecycle event.
 *
 * Field semantics follow the EVN Bible's mïsn section. Stellar
 * references (availStel/travelStel/returnStel/shipSyst/auxShipSyst)
 * are carried as the raw resource-id-space numbers because most of
 * them are not plain ids: the govt-relative ranges (10000+, 15000+,
 * 20000+, 25000+, 30000+, 31000+), the adjacent-system range (5000+),
 * and the special negatives (-1 none, -2 random inhabited, -3 random
 * uninhabited, -4 initial stellar) can only be resolved at runtime
 * against the player's situation. See misn_resource.ts for the full
 * range tables.
 *
 * The dësc briefing texts are resolved to strings at parse time (the
 * ids are useless to the game without the text, and the text is tiny),
 * including the mission's offer text: dësc id 4000 + (mïsn id - 128).
 */
export interface MissionData extends BaseData {
    /** Where the mission is offered (AvailStel); raw ranged value. */
    availStel: number;
    /**
     * When availStel is a plain spöb id (128-2175), its global id
     * (resolved at parse time against the mission's own id space so
     * plug-in prefixes work); null for the special ranges.
     */
    availStelId: string | null;
    /**
     * Where on the stellar the mission is offered (AvailLoc):
     * 0 mission computer; 1 bar; 2 from a ship; 3 main spaceport;
     * 4 trade centre; 5 shipyard; 6 outfitter.
     */
    availLoc: number;
    /** Required legal record (AvailRecord); 0 ignored. */
    availRecord: number;
    /** Required combat rating (AvailRating); -1 ignored. */
    availRating: number;
    /** Percent chance the mission appears, re-rolled per landing. */
    availRandom: number;
    /** NCB test expression gating availability (AvailBits). */
    availBits: string;
    /**
     * Ship type restriction (AvailShipType): 0/-1 ignored; 128-255
     * must fly this shïp; 1128-1255 must not; 2128-2255 must fly this
     * govt's ship; 3128-3255 must not.
     */
    availShipType: number;
    /**
     * 64-bit Require mask and'ed against the player's Contribute bits,
     * as a decimal string (JSON-safe; parse with BigInt()).
     */
    require: string;

    /** Destination stellar (TravelStel); raw ranged value; -1 none. */
    travelStel: number;
    /** Global id when travelStel is a plain spöb id; null otherwise. */
    travelStelId: string | null;
    /** Return-for-payment stellar (ReturnStel); raw ranged value. */
    returnStel: number;
    /** Global id when returnStel is a plain spöb id; null otherwise. */
    returnStelId: string | null;

    /**
     * Cargo type (CargoType): -1 none; 0-255 a cargo type (0-5 the
     * standard types); 1000 a random standard type.
     */
    cargoType: number;
    /** Tons of cargo (CargoQty): -1 none; >=0 exact; <=-2 abs ±50%. */
    cargoQty: number;
    /** -1 ignored; 0 at start; 1 at TravelStel; 2 boarding the ship. */
    pickupMode: number;
    /** -1 ignored; 0 at TravelStel; 1 at mission end (ReturnStel). */
    dropOffMode: number;
    /** Cargo illegality mask matched against govt ScanMask. */
    scanMask: number;

    /**
     * Payment (PayVal): 0/-1 none; >0 credits; various negative ranges
     * encode legal-record cleaning and cash removal (see the Bible).
     */
    payVal: number;
    /** Govt whose legal record changes on completion; -1 none. */
    compGovt: number;
    /** Legal record change with compGovt (halved, negated on failure). */
    compReward: number;

    /** Time limit in days; -1 or 0 no limit. */
    timeLimit: number;
    /** Whether the player may abort the mission. */
    canAbort: boolean;
    /** Days the date advances after success or auto-abort. */
    datePostInc: number;
    /** Bar/BBS ordering weight; higher first. */
    dispWeight: number;

    // --- Special/auxiliary ships (combat objectives). Carried raw;
    // the game does not implement them yet. ---
    shipCount: number;
    shipSyst: number;
    shipDude: number;
    /** -1 none; 0 destroy; 1 disable; 2 board; 3 escort; 4 observe;
     * 5 rescue; 6 chase off. */
    shipGoal: number;
    shipBehav: number;
    shipStart: number;
    auxShipCount: number;
    auxShipDude: number;
    auxShipSyst: number;

    flags: MissionFlags;

    // --- NCB set strings ---
    onAccept: string;
    onRefuse: string;
    onSuccess: string;
    onFailure: string;
    onAbort: string;
    onShipDone: string;

    // --- Briefing texts, resolved from dësc resources at parse time.
    // Empty string when the mission doesn't define one. ---
    /** The offer text shown in the mission computer / bar (dësc
     * 4000 + (id - 128)). */
    offerText: string;
    briefText: string;
    quickBrief: string;
    loadCargoText: string;
    dropOffCargoText: string;
    completionText: string;
    failText: string;
    refuseText: string;
    shipDoneText: string;

    /** Accept-button label; "" = use the default. */
    acceptButton: string;
    /** Refuse-button label; "" = use the default. */
    refuseButton: string;
}

/** mïsn Flags/Flags2 decoded to named booleans. */
export interface MissionFlags {
    /** Auto-aborts after being accepted (one-shot set-string missions). */
    autoAbort: boolean;
    /** Don't show hyperspace destination arrows. */
    hideDestArrows: boolean;
    /** The offer can't be refused. */
    cantRefuse: boolean;
    /** Mission takes away 100 units of fuel on auto-abort. */
    remove100FuelOnAutoAbort: boolean;
    infiniteAuxShips: boolean;
    /** Mission fails if the player is scanned. */
    failIfScanned: boolean;
    lose5xCompRewardOnAbort: boolean;
    /** Global penalty when jettisoning mission cargo in space. */
    jettisonPenalty: boolean;
    showGreenArrowInBriefing: boolean;
    showArrowForShipSyst: boolean;
    /** Invisible: never shown in the mission info dialog. */
    invisible: boolean;
    freezeShipTypesAtStart: boolean;
    notForCargoShips: boolean;
    notForWarships: boolean;
    failIfBoardedByPirates: boolean;
    /** Don't offer when the player lacks the cargo space. */
    notOfferedIfInsufficientCargoSpace: boolean;
    applyPayOnAutoAbort: boolean;
    failIfPlayerDisabledOrDestroyed: boolean;
}

export function getDefaultMissionFlags(): MissionFlags {
    return {
        autoAbort: false,
        hideDestArrows: false,
        cantRefuse: false,
        remove100FuelOnAutoAbort: false,
        infiniteAuxShips: false,
        failIfScanned: false,
        lose5xCompRewardOnAbort: false,
        jettisonPenalty: false,
        showGreenArrowInBriefing: false,
        showArrowForShipSyst: false,
        invisible: false,
        freezeShipTypesAtStart: false,
        notForCargoShips: false,
        notForWarships: false,
        failIfBoardedByPirates: false,
        notOfferedIfInsufficientCargoSpace: false,
        applyPayOnAutoAbort: false,
        failIfPlayerDisabledOrDestroyed: false,
    };
}

export function getDefaultMissionData(): MissionData {
    return {
        ...getDefaultBaseData(),
        availStel: -1,
        availStelId: null,
        availLoc: 0,
        availRecord: 0,
        availRating: -1,
        availRandom: 100,
        availBits: "",
        availShipType: -1,
        require: "0",
        travelStel: -1,
        travelStelId: null,
        returnStel: -1,
        returnStelId: null,
        cargoType: -1,
        cargoQty: -1,
        pickupMode: -1,
        dropOffMode: -1,
        scanMask: 0,
        payVal: 0,
        compGovt: -1,
        compReward: 0,
        timeLimit: -1,
        canAbort: true,
        datePostInc: 0,
        dispWeight: 0,
        shipCount: -1,
        shipSyst: -1,
        shipDude: -1,
        shipGoal: -1,
        shipBehav: -1,
        shipStart: 0,
        auxShipCount: -1,
        auxShipDude: -1,
        auxShipSyst: -1,
        flags: getDefaultMissionFlags(),
        onAccept: "",
        onRefuse: "",
        onSuccess: "",
        onFailure: "",
        onAbort: "",
        onShipDone: "",
        offerText: "",
        briefText: "",
        quickBrief: "",
        loadCargoText: "",
        dropOffCargoText: "",
        completionText: "",
        failText: "",
        refuseText: "",
        shipDoneText: "",
        acceptButton: "",
        refuseButton: "",
    };
}
