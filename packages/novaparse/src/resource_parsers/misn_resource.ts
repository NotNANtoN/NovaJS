import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";
import { NovaResources } from "./resource_holder_base.js";

/**
 * A mission: the crown jewel and largest resource in a Nova datafile. Each
 * mïsn describes a single mission the player can undertake, including where and
 * when it is available, where the player must travel, any special or auxiliary
 * ships, the dësc briefings shown at each stage, and the NCB (Nova Control Bit)
 * test/set expressions run at each stage.
 *
 * Field layout follows ResForge's mïsn template (1970 bytes), documented in the
 * EVN Bible pp. 33-40. NCB expressions (AvailBits, OnAccept, etc.) are kept as
 * raw MacRoman strings; Nova evaluates them at runtime and they are never
 * parsed here.
 */
class MisnResource extends BaseResource {
    /**
     * Which stellar objects (planets) offer this mission (AvailStel):
     * -1 any inhabited stellar; 128-2175 a specific spöb; 5000-7047 a stellar
     * in a system adjacent to system id (val-5000+128); 9999 independent
     * stellars; 10000-10255 a specific govt's stellar; 15000-15255 a govt
     * ally's stellar; 20000-20255 not this govt's stellar; 25000-25255 a govt
     * enemy's stellar; 30000-30255 govt-or-classmate's stellar; 31000-31255
     * neither this govt nor a classmate's stellar.
     */
    availStel: number;

    /**
     * Where on a planet this mission is available (AvailLoc / "Offered From"):
     * 0 mission computer; 1 bar; 2 offered from a ship (needs a matching përs);
     * 3 main spaceport; 4 trade centre; 5 shipyard; 6 outfitter.
     */
    availLoc: number;

    /**
     * Legal record required in this system for the mission to appear
     * (AvailRecord): 0 ignored; positive - record must be at least this high;
     * negative - record must be at least this low; -32000 player has dominated
     * the stellar in question; -32001 player has dominated at least one stellar.
     */
    availRecord: number;

    /** Combat rating required for the mission to appear; -1 ignored, else min. */
    availRating: number;

    /**
     * Randomization factor recomputed on each warp: 100 always available,
     * 1-99 available this percent of the time.
     */
    availRandom: number;

    /**
     * Stellar the player must travel to during the mission (TravelStel):
     * -1 none; -2 a random inhabited stellar; -3 a random uninhabited planet;
     * 128-2175 a specific spöb; and the same govt ranges as availStel
     * (9999/10000+/15000+/20000+/25000+/30000+/31000+).
     */
    travelStel: number;

    /**
     * Stellar the player must return to for payment (ReturnStel): as TravelStel
     * plus -4 the initial stellar where the mission was accepted.
     */
    returnStel: number;

    /**
     * Cargo type carried (CargoType): -1 none; 0-255 a specific cargo type
     * (0-5 are the standard STR# 4001 types); 1000 a random basic type (0-5).
     */
    cargoType: number;

    /**
     * Amount of cargo (CargoQty): -1 ignored; 0 and up an exact number of tons;
     * -2 and below abs(value) tons +/- 50%.
     */
    cargoQty: number;

    /**
     * Where cargo is picked up (PickupMode): -1 ignored; 0 at mission start;
     * 1 at TravelStel; 2 when boarding the special ship.
     */
    pickupMode: number;

    /**
     * Where cargo is dropped off (DropOffMode): -1 ignored; 0 at TravelStel;
     * 1 at mission end (ReturnStel).
     */
    dropoffMode: number;

    /**
     * Bitmask of the cargo's "illegality": if any bit matches a govt's ScanMask
     * that govt considers the mission cargo illegal. 0 if unused.
     */
    scanMask: number;

    /**
     * Reward on success and returning to ReturnStel (PayVal): 0 or -1 no pay;
     * 1 and up credits; -10128..-10383 clean legal record with govt (val);
     * -20128..-20383 clean record with govt and its allies; -30128..-30383
     * clean record with govt and its classmates; -40001..-40099 remove that
     * percent of the player's cash; -50000 and down remove that many credits at
     * mission start (-50000 = 0, -50001 = 1, ...).
     */
    payVal: number;

    /** Number of special ships (ShipCount): -1 none; 0-31 this many. */
    shipCount: number;

    /**
     * System the special ships appear in (ShipSyst): -1 initial system;
     * -2 any random system; -3 TravelStel's system; -4 ReturnStel's system;
     * -5 system adjacent to initial; -6 whatever system the player is in;
     * 128-2175 a specific system; plus the govt ranges (9999/10000+/...).
     */
    shipSyst: number;

    /** dude resource id defining the special ships' types (ShipDude); -1 none. */
    shipDude: number;

    /**
     * Mission goal for the special ships (ShipGoal): -1 none; 0 destroy;
     * 1 disable but don't destroy; 2 board; 3 escort; 4 observe; 5 rescue
     * (they start disabled); 6 chase off.
     */
    shipGoal: number;

    /**
     * Special actions for the ships (ShipBehav): -1 ignored (standard AI);
     * 0 always attack the player; 1 protect the player; 2 destroy enemy
     * stellars.
     */
    shipBehav: number;

    /** STR# id naming the special ships (ShipNameID); -1 normal names. */
    shipNameID: number;

    /**
     * Where in the system the special ships start (ShipStart): -4..-1 on top of
     * nav default 4..1; 0 randomly in the system; 1 jump in from hyperspace;
     * 2 randomly, cloaked.
     */
    shipStart: number;

    /** Govt whose record changes on completion (CompGovt); -1 none. */
    compGovt: number;

    /**
     * How much to change the record with CompGovt (CompReward). On failure the
     * govt decreases the record by half this amount.
     */
    compReward: number;

    /** STR# id giving the special ships' subtitle (ShipSubtitle); -1 normal. */
    shipSubtitle: number;

    /** dësc id shown when the mission is accepted (BriefText); -1 none. */
    briefText: number;
    /** dësc id shown on the "Mission Briefing" (I) key (QuickBrief); -1 none. */
    quickBrief: number;
    /** dësc id shown when mission cargo is loaded (LoadCargText); -1 none. */
    loadCargText: number;
    /** dësc id shown when mission cargo is offloaded (DumpCargoText); -1 none. */
    dropCargText: number;
    /** dësc id shown on successful return to ReturnStel (CompText); -1 none. */
    compText: number;
    /** dësc id shown on failed return to ReturnStel (FailText); -1 none. */
    failText: number;

    /** Time limit in days (TimeLimit): -1 or 0 no limit; 1 and up this many. */
    timeLimit: number;

    /**
     * Whether the mission can be aborted (CanAbort): 0 cannot be aborted;
     * 1 can be aborted (aborting disables the failure text).
     */
    canAbort: number;

    /** dësc id shown when the special ship goal is completed (ShipDoneText). */
    shipDoneText: number;

    /** Auxiliary ships to place for atmosphere (AuxShipCount): -1 none; 1-31. */
    auxShipCount: number;

    /** dude resource id used to set up the auxiliary ships (AuxShipDude). */
    auxShipDude: number;

    /**
     * Systems to place the auxiliary ships in (AuxShipSyst): -1 any system the
     * player is in; -2 TravelStel's system; -3 ReturnStel's system; 128-2175 a
     * specific system; 5000-7047 that system or any adjacent; plus the govt
     * ranges (9999/10000+/...).
     */
    auxShipSyst: number;

    flags: number;
    autoAbort: boolean;
    hideDestArrows: boolean;
    cantRefuse: boolean;
    remove100FuelOnAutoAbort: boolean;
    infiniteAuxShips: boolean;
    failIfScanned: boolean;
    lose5xCompRewardOnAbort: boolean;
    /** Global penalty when jettisoning cargo in space; currently ignored. */
    jettisonPenalty: boolean;
    showGreenArrowInBriefing: boolean;
    showArrowForShipSyst: boolean;
    invisible: boolean;
    freezeShipTypesAtStart: boolean;
    notForCargoShips: boolean;
    notForWarships: boolean;
    failIfBoardedByPirates: boolean;

    flags2: number;
    notOfferedIfInsufficientCargoSpace: boolean;
    applyPayOnAutoAbort: boolean;
    failIfPlayerDisabledOrDestroyed: boolean;

    /** dësc id shown when a bar/ship mission offer is refused (RefuseText). */
    refuseText: number;

    /**
     * Ship class required to fly to receive the mission (AvailShipType):
     * 0 or -1 ignored; 128-255 must be flying this shïp type; 1128-1255 must
     * not be flying this shïp type; 2128-2255 must be flying a shïp of this
     * govt; 3128-3255 must not be flying a shïp of this govt.
     */
    availShipType: number;

    /** NCB test expression gating availability (AvailBits); raw string. */
    availBits: string;
    /** NCB set expression run when the mission is accepted (OnAccept). */
    onAccept: string;
    /** NCB set expression run when the mission is refused (OnRefuse). */
    onRefuse: string;
    /** NCB set expression run when the mission succeeds (OnSuccess). */
    onSuccess: string;
    /** NCB set expression run when the mission fails (OnFailure). */
    onFailure: string;
    /** NCB set expression run when the mission is aborted (OnAbort). */
    onAbort: string;
    /** NCB set expression run when the special ship goal completes (OnShipDone). */
    onShipDone: string;

    /** 64-bit flag set and'ed against the player's Contribute bits (Require). */
    require: bigint;

    /** Days the game date advances after success/auto-abort (DatePostInc). */
    datePostInc: number;

    /** Label for the Accept button in the briefing dialog (AcceptButton). */
    acceptButton: string;
    /** Label for the Refuse button in the briefing dialog (RefuseButton). */
    refuseButton: string;

    /**
     * Ordering weight in the bar/BBS mission list (DispWeight): higher weights
     * are presented first.
     */
    dispWeight: number;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        this.availStel = r.int16(-1);
        r.skip(2);                      // unused
        this.availLoc = r.int16();
        this.availRecord = r.int16();
        this.availRating = r.int16();
        this.availRandom = r.int16();
        this.travelStel = r.int16(-1);
        this.returnStel = r.int16(-1);
        this.cargoType = r.int16(-1);
        this.cargoQty = r.int16();
        this.pickupMode = r.int16(-1);
        this.dropoffMode = r.int16(-1);
        this.scanMask = r.uint16();
        r.skip(2);                      // unused
        this.payVal = r.int32();
        this.shipCount = r.int16();
        this.shipSyst = r.int16(-1);
        this.shipDude = r.int16(-1);
        this.shipGoal = r.int16(-1);
        this.shipBehav = r.int16(-1);
        this.shipNameID = r.int16(-1);
        this.shipStart = r.int16();
        this.compGovt = r.int16(-1);
        this.compReward = r.int16();
        this.shipSubtitle = r.int16(-1);
        this.briefText = r.int16(-1);
        this.quickBrief = r.int16(-1);
        this.loadCargText = r.int16(-1);
        this.dropCargText = r.int16(-1);
        this.compText = r.int16(-1);
        this.failText = r.int16(-1);
        this.timeLimit = r.int16();
        this.canAbort = r.uint16();
        this.shipDoneText = r.int16(-1);
        r.skip(2);                      // unused
        this.auxShipCount = r.int16();
        this.auxShipDude = r.int16(-1);
        this.auxShipSyst = r.int16(-1);
        r.skip(2);                      // unused

        this.flags = r.uint16();
        this.autoAbort = Boolean(this.flags & 0x0001);
        this.hideDestArrows = Boolean(this.flags & 0x0002);
        this.cantRefuse = Boolean(this.flags & 0x0004);
        this.remove100FuelOnAutoAbort = Boolean(this.flags & 0x0008);
        this.infiniteAuxShips = Boolean(this.flags & 0x0010);
        this.failIfScanned = Boolean(this.flags & 0x0020);
        this.lose5xCompRewardOnAbort = Boolean(this.flags & 0x0040);
        this.jettisonPenalty = Boolean(this.flags & 0x0080);
        this.showGreenArrowInBriefing = Boolean(this.flags & 0x0100);
        this.showArrowForShipSyst = Boolean(this.flags & 0x0200);
        this.invisible = Boolean(this.flags & 0x0400);
        this.freezeShipTypesAtStart = Boolean(this.flags & 0x0800);
        this.notForCargoShips = Boolean(this.flags & 0x2000);
        this.notForWarships = Boolean(this.flags & 0x4000);
        this.failIfBoardedByPirates = Boolean(this.flags & 0x8000);

        this.flags2 = r.uint16();
        this.notOfferedIfInsufficientCargoSpace = Boolean(this.flags2 & 0x0001);
        this.applyPayOnAutoAbort = Boolean(this.flags2 & 0x0002);
        this.failIfPlayerDisabledOrDestroyed = Boolean(this.flags2 & 0x0004);

        r.skip(2);                      // unused
        r.skip(2);                      // unused
        this.refuseText = r.int16(-1);
        this.availShipType = r.int16(-1);

        this.availBits = r.string(0xFF);
        this.onAccept = r.string(0xFF);
        this.onRefuse = r.string(0xFF);
        this.onSuccess = r.string(0xFF);
        this.onFailure = r.string(0xFF);
        this.onAbort = r.string(0xFF);
        this.require = r.uint64();
        this.datePostInc = r.int16();
        this.onShipDone = r.string(0xFF);
        this.acceptButton = r.string(0x20);
        this.refuseButton = r.string(0x21);
        this.dispWeight = r.int16();
        r.skip(0x10);                   // unused
    }
}

export { MisnResource };
