import "jasmine";
import { MisnResource } from "../../src/resource_parsers/misn_resource.js";
import { DescResource } from "../../src/resource_parsers/desc_resource.js";
import { MisnParse } from "../../src/parsers/misn_parse.js";
import { getEmptyNovaResources, NovaResources } from "../../src/resource_parsers/resource_holder_base.js";
import { ResourceBuilder } from "../resource_parsers/resource_builder.js";

/** Builds a dësc resource holding just the given text. */
function makeDesc(idSpace: NovaResources, id: number, text: string) {
    const b = new ResourceBuilder();
    for (const ch of text) {
        b.uint8(ch.charCodeAt(0));
    }
    b.uint8(0);
    idSpace.dësc[id] = new DescResource(
        b.resource("dësc", id, `desc ${id}`), idSpace);
}

/**
 * A mïsn resource with every field set to a distinct, recognizable
 * value. Mirrors the byte layout exercised in misn_resource_test.ts so
 * this test focuses on the projection onto MissionData.
 */
function buildMisn(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(130)                        // availStel
        .skip(2)                        // unused
        .int16(1)                       // availLoc - bar
        .int16(-50)                     // availRecord
        .int16(100)                     // availRating
        .int16(75)                      // availRandom
        .int16(200)                     // travelStel
        .int16(-4)                      // returnStel - initial stellar
        .int16(2)                       // cargoType
        .int16(-2)                      // cargoQty
        .int16(0)                       // pickupMode - at start
        .int16(1)                       // dropoffMode - at return
        .uint16(0x00ff)                 // scanMask
        .skip(2)                        // unused
        .int32(50000)                   // payVal
        .int16(3)                       // shipCount
        .int16(-1)                      // shipSyst
        .int16(200)                     // shipDude
        .int16(0)                       // shipGoal
        .int16(1)                       // shipBehav
        .int16(300)                     // shipNameID
        .int16(1)                       // shipStart
        .int16(140)                     // compGovt
        .int16(25)                      // compReward
        .int16(301)                     // shipSubtitle
        .int16(5000)                    // briefText
        .int16(5001)                    // quickBrief
        .int16(5002)                    // loadCargText
        .int16(5003)                    // dropCargText
        .int16(5004)                    // compText
        .int16(5005)                    // failText
        .int16(30)                      // timeLimit
        .uint16(1)                      // canAbort
        .int16(5006)                    // shipDoneText
        .skip(2)                        // unused
        .int16(2)                       // auxShipCount
        .int16(210)                     // auxShipDude
        .int16(128)                     // auxShipSyst
        .skip(2)                        // unused
        .uint16(0x8025)                 // flags
        .uint16(0x0005)                 // flags2
        .skip(2)                        // unused
        .skip(2)                        // unused
        .int16(5007)                    // refuseText
        .int16(150)                     // availShipType
        .string("b1 & !b128", 0xFF)     // availBits
        .string("a128", 0xFF)           // onAccept
        .string("a129", 0xFF)           // onRefuse
        .string("s130 s131", 0xFF)      // onSuccess
        .string("f132", 0xFF)           // onFailure
        .string("c133", 0xFF)           // onAbort
        .uint64(0x0000000100000002n)    // require
        .int16(7)                       // datePostInc
        .string("d134", 0xFF)           // onShipDone
        .string("Accept", 0x20)         // acceptButton
        .string("Decline", 0x21)        // refuseButton
        .int16(500)                     // dispWeight
        .skip(0x10);                    // unused
    return b;
}

function parseMisn(id = 130) {
    const idSpace = getEmptyNovaResources();
    makeDesc(idSpace, 4000 + (id - 128), "Deliver the parcel to <DST>.");
    makeDesc(idSpace, 5000, "brief");
    makeDesc(idSpace, 5001, "quick brief");
    makeDesc(idSpace, 5002, "cargo loaded");
    makeDesc(idSpace, 5003, "cargo dropped");
    makeDesc(idSpace, 5004, "mission complete");
    makeDesc(idSpace, 5005, "mission failed");
    // 5006 (shipDoneText) intentionally missing.
    makeDesc(idSpace, 5007, "refused");

    // The parse only reads globalID from referenced spöbs. spöb 130
    // (availStel) is intentionally absent.
    idSpace.spöb[200] = { globalID: "nova:200" } as unknown as never;

    const resource = new MisnResource(
        buildMisn().resource("mïsn", id, "Test Mission"), idSpace);
    resource.globalID = `nova:${id}`;
    resource.prefix = "nova";
    return MisnParse(resource, () => { });
}

describe("MisnParse", () => {
    it("carries the BaseData fields", async () => {
        const misn = await parseMisn();
        expect(misn.id).toBe("nova:130");
        expect(misn.name).toBe("Test Mission");
        expect(misn.prefix).toBe("nova");
    });

    it("projects availability fields", async () => {
        const misn = await parseMisn();
        expect(misn.availStel).toBe(130);
        expect(misn.availLoc).toBe(1);
        expect(misn.availRecord).toBe(-50);
        expect(misn.availRating).toBe(100);
        expect(misn.availRandom).toBe(75);
        expect(misn.availBits).toBe("b1 & !b128");
        expect(misn.availShipType).toBe(150);
    });

    it("resolves plain stellar ids and leaves ranged values null", async () => {
        const misn = await parseMisn();
        // travelStel 200 is a plain spöb id present in the id space.
        expect(misn.travelStelId).toBe("nova:200");
        // availStel 130 is a plain id but the spöb doesn't exist.
        expect(misn.availStelId).toBe(null);
        // returnStel -4 (initial stellar) is a ranged special.
        expect(misn.returnStelId).toBe(null);
    });

    it("projects destination and cargo fields", async () => {
        const misn = await parseMisn();
        expect(misn.travelStel).toBe(200);
        expect(misn.returnStel).toBe(-4);
        expect(misn.cargoType).toBe(2);
        expect(misn.cargoQty).toBe(-2);
        expect(misn.pickupMode).toBe(0);
        expect(misn.dropOffMode).toBe(1);
        expect(misn.scanMask).toBe(0x00ff);
    });

    it("projects payment and completion fields", async () => {
        const misn = await parseMisn();
        expect(misn.payVal).toBe(50000);
        expect(misn.compGovt).toBe(140);
        expect(misn.compReward).toBe(25);
        expect(misn.timeLimit).toBe(30);
        expect(misn.canAbort).toBe(true);
        expect(misn.datePostInc).toBe(7);
        expect(misn.dispWeight).toBe(500);
    });

    it("projects the NCB set strings verbatim", async () => {
        const misn = await parseMisn();
        expect(misn.onAccept).toBe("a128");
        expect(misn.onRefuse).toBe("a129");
        expect(misn.onSuccess).toBe("s130 s131");
        expect(misn.onFailure).toBe("f132");
        expect(misn.onAbort).toBe("c133");
        expect(misn.onShipDone).toBe("d134");
    });

    it("resolves the offer text from dësc 4000 + (id - 128)", async () => {
        const misn = await parseMisn();
        expect(misn.offerText).toBe("Deliver the parcel to <DST>.");
    });

    it("resolves briefing texts, defaulting missing ones to ''", async () => {
        const misn = await parseMisn();
        expect(misn.briefText).toBe("brief");
        expect(misn.quickBrief).toBe("quick brief");
        expect(misn.loadCargoText).toBe("cargo loaded");
        expect(misn.dropOffCargoText).toBe("cargo dropped");
        expect(misn.completionText).toBe("mission complete");
        expect(misn.failText).toBe("mission failed");
        expect(misn.refuseText).toBe("refused");
        // dësc 5006 doesn't exist.
        expect(misn.shipDoneText).toBe("");
    });

    it("projects button labels", async () => {
        const misn = await parseMisn();
        expect(misn.acceptButton).toBe("Accept");
        expect(misn.refuseButton).toBe("Decline");
    });

    it("decodes flags into named booleans", async () => {
        const misn = await parseMisn();
        // 0x8025 = autoAbort | cantRefuse | failIfScanned
        //          | failIfBoardedByPirates
        expect(misn.flags.autoAbort).toBe(true);
        expect(misn.flags.cantRefuse).toBe(true);
        expect(misn.flags.failIfScanned).toBe(true);
        expect(misn.flags.failIfBoardedByPirates).toBe(true);
        expect(misn.flags.hideDestArrows).toBe(false);
        // 0x0005 = notOfferedIfInsufficientCargoSpace
        //          | failIfPlayerDisabledOrDestroyed
        expect(misn.flags.notOfferedIfInsufficientCargoSpace).toBe(true);
        expect(misn.flags.failIfPlayerDisabledOrDestroyed).toBe(true);
        expect(misn.flags.applyPayOnAutoAbort).toBe(false);
    });

    it("serializes require as a decimal string (JSON-safe)", async () => {
        const misn = await parseMisn();
        expect(misn.require).toBe(0x0000000100000002n.toString());
        expect(() => JSON.stringify(misn)).not.toThrow();
    });
});
