import "jasmine";
import { MisnResource } from "../../src/resource_parsers/misn_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/** A mïsn resource with every field set to a distinct, recognizable value. */
function buildMisn(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(130)                        // availStel (offset 0)
        .skip(2)                        // unused (2)
        .int16(1)                       // availLoc - bar (4)
        .int16(-50)                     // availRecord (6)
        .int16(100)                     // availRating (8)
        .int16(75)                      // availRandom (10)
        .int16(200)                     // travelStel (12)
        .int16(-4)                      // returnStel - initial stellar (14)
        .int16(2)                       // cargoType - medical supplies (16)
        .int16(-2)                      // cargoQty (18)
        .int16(0)                       // pickupMode - at start (20)
        .int16(1)                       // dropoffMode - at return (22)
        .uint16(0x00ff)                 // scanMask (24)
        .skip(2)                        // unused (26)
        .int32(50000)                   // payVal (28)
        .int16(3)                       // shipCount (32)
        .int16(-1)                      // shipSyst - initial system (34)
        .int16(200)                     // shipDude (36)
        .int16(0)                       // shipGoal - destroy (38)
        .int16(1)                       // shipBehav - protect player (40)
        .int16(300)                     // shipNameID (42)
        .int16(1)                       // shipStart - jump in (44)
        .int16(140)                     // compGovt (46)
        .int16(25)                      // compReward (48)
        .int16(301)                     // shipSubtitle (50)
        .int16(5000)                    // briefText (52)
        .int16(5001)                    // quickBrief (54)
        .int16(5002)                    // loadCargText (56)
        .int16(5003)                    // dropCargText (58)
        .int16(5004)                    // compText (60)
        .int16(5005)                    // failText (62)
        .int16(30)                      // timeLimit (64)
        .uint16(1)                      // canAbort (66)
        .int16(5006)                    // shipDoneText (68)
        .skip(2)                        // unused (70)
        .int16(2)                       // auxShipCount (72)
        .int16(210)                     // auxShipDude (74)
        .int16(128)                     // auxShipSyst (76)
        .skip(2)                        // unused (78)
        .uint16(0x8025)                 // flags (80)
        .uint16(0x0005)                 // flags2 (82)
        .skip(2)                        // unused (84)
        .skip(2)                        // unused (86)
        .int16(5007)                    // refuseText (88)
        .int16(150)                     // availShipType (90)
        .string("b !128", 0xFF)         // availBits / AvailableOn (92)
        .string("a128", 0xFF)           // onAccept (347)
        .string("a129", 0xFF)           // onRefuse (602)
        .string("s130 s131", 0xFF)      // onSuccess (857)
        .string("f132", 0xFF)           // onFailure (1112)
        .string("c133", 0xFF)           // onAbort (1367)
        .uint64(0x0000000100000002n)    // require (1622)
        .int16(7)                       // datePostInc (1630)
        .string("d134", 0xFF)           // onShipDone (1632)
        .string("Accept", 0x20)         // acceptButton (1887)
        .string("Decline", 0x21)        // refuseButton (1919)
        .int16(500)                     // dispWeight (1952)
        .skip(0x10);                    // unused (1954)
    return b;
}

describe("MisnResource", () => {
    // Missions don't depend on other resources for parsing.
    const idSpace = defaultIDSpace;

    let misn: MisnResource;

    beforeEach(() => {
        misn = new MisnResource(
            buildMisn().resource("mïsn", 128, "Test Mission"), idSpace);
    });

    it("builds a full-size resource", () => {
        // 1970 bytes is the size of every mïsn in Nova's own data files.
        expect(buildMisn().byteLength).toBe(1970);
    });

    it("parses availability fields", () => {
        expect(misn.availStel).toBe(130);
        expect(misn.availLoc).toBe(1);
        expect(misn.availRecord).toBe(-50);
        expect(misn.availRating).toBe(100);
        expect(misn.availRandom).toBe(75);
    });

    it("parses travel and return stellars", () => {
        expect(misn.travelStel).toBe(200);
        expect(misn.returnStel).toBe(-4);
    });

    it("parses cargo fields", () => {
        expect(misn.cargoType).toBe(2);
        expect(misn.cargoQty).toBe(-2);
        expect(misn.pickupMode).toBe(0);
        expect(misn.dropoffMode).toBe(1);
    });

    it("parses scanMask and payVal", () => {
        expect(misn.scanMask).toBe(0x00ff);
        expect(misn.payVal).toBe(50000);
    });

    it("parses special ship fields", () => {
        expect(misn.shipCount).toBe(3);
        expect(misn.shipSyst).toBe(-1);
        expect(misn.shipDude).toBe(200);
        expect(misn.shipGoal).toBe(0);
        expect(misn.shipBehav).toBe(1);
        expect(misn.shipNameID).toBe(300);
        expect(misn.shipStart).toBe(1);
        expect(misn.shipSubtitle).toBe(301);
    });

    it("parses compGovt and compReward", () => {
        expect(misn.compGovt).toBe(140);
        expect(misn.compReward).toBe(25);
    });

    it("parses briefing dësc ids", () => {
        expect(misn.briefText).toBe(5000);
        expect(misn.quickBrief).toBe(5001);
        expect(misn.loadCargText).toBe(5002);
        expect(misn.dropCargText).toBe(5003);
        expect(misn.compText).toBe(5004);
        expect(misn.failText).toBe(5005);
        expect(misn.shipDoneText).toBe(5006);
        expect(misn.refuseText).toBe(5007);
    });

    it("parses timeLimit and canAbort", () => {
        expect(misn.timeLimit).toBe(30);
        expect(misn.canAbort).toBe(1);
    });

    it("parses auxiliary ship fields", () => {
        expect(misn.auxShipCount).toBe(2);
        expect(misn.auxShipDude).toBe(210);
        expect(misn.auxShipSyst).toBe(128);
    });

    it("parses flags", () => {
        expect(misn.flags).toBe(0x8025);
        // 0x8025 = 0x8000 | 0x0020 | 0x0004 | 0x0001
        expect(misn.autoAbort).toBe(true);
        expect(misn.hideDestArrows).toBe(false);
        expect(misn.cantRefuse).toBe(true);
        expect(misn.remove100FuelOnAutoAbort).toBe(false);
        expect(misn.infiniteAuxShips).toBe(false);
        expect(misn.failIfScanned).toBe(true);
        expect(misn.lose5xCompRewardOnAbort).toBe(false);
        expect(misn.jettisonPenalty).toBe(false);
        expect(misn.showGreenArrowInBriefing).toBe(false);
        expect(misn.showArrowForShipSyst).toBe(false);
        expect(misn.invisible).toBe(false);
        expect(misn.freezeShipTypesAtStart).toBe(false);
        expect(misn.notForCargoShips).toBe(false);
        expect(misn.notForWarships).toBe(false);
        expect(misn.failIfBoardedByPirates).toBe(true);
    });

    it("parses flags2", () => {
        expect(misn.flags2).toBe(0x0005);
        // 0x0005 = 0x0004 | 0x0001
        expect(misn.notOfferedIfInsufficientCargoSpace).toBe(true);
        expect(misn.applyPayOnAutoAbort).toBe(false);
        expect(misn.failIfPlayerDisabledOrDestroyed).toBe(true);
    });

    it("parses availShipType", () => {
        expect(misn.availShipType).toBe(150);
    });

    it("keeps NCB expressions as raw strings", () => {
        expect(misn.availBits).toBe("b !128");
        expect(misn.onAccept).toBe("a128");
        expect(misn.onRefuse).toBe("a129");
        expect(misn.onSuccess).toBe("s130 s131");
        expect(misn.onFailure).toBe("f132");
        expect(misn.onAbort).toBe("c133");
        expect(misn.onShipDone).toBe("d134");
    });

    it("parses require", () => {
        expect(misn.require).toBe(0x0000000100000002n);
    });

    it("parses datePostInc and dispWeight", () => {
        expect(misn.datePostInc).toBe(7);
        expect(misn.dispWeight).toBe(500);
    });

    it("parses button labels", () => {
        expect(misn.acceptButton).toBe("Accept");
        expect(misn.refuseButton).toBe("Decline");
    });

    it("defaults fields past the end of a truncated resource", () => {
        // Cut off immediately after payVal (offset 32).
        const truncated = buildMisn().truncate(32);
        const misn = new MisnResource(
            truncated.resource("mïsn", 129, "Truncated"), idSpace);
        expect(misn.payVal).toBe(50000);
        // Resource-id fields past the end read as "none" (-1).
        expect(misn.shipCount).toBe(0);
        expect(misn.shipDude).toBe(-1);
        expect(misn.briefText).toBe(-1);
        expect(misn.availBits).toBe("");
        expect(misn.require).toBe(0n);
        expect(misn.acceptButton).toBe("");
    });
});
