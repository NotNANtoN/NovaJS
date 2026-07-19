import "jasmine";
import { OutfResource } from "../src/resource_parsers/outf_resource.js";
import { OutfitParse } from "../src/parsers/outfit_parse.js";

function fakeOutf(functions: Array<[string, number | boolean]>): OutfResource {
    return {
        globalID: "nova:128",
        name: "Test Outfit",
        prefix: "nova",
        functions,
        mass: 5,
        cost: 100,
        displayWeight: 1,
        max: 1,
        pictID: 0,
        descID: 0,
        availability: "",
        onPurchase: "",
        onSell: "",
        contribute: 0n,
        require: 0n,
        flags: 0,
        idSpace: { PICT: {}, dësc: {}, wëap: {}, oütf: {} },
    } as unknown as OutfResource;
}

describe("OutfitParse", () => {
    it("parses the hyperspace dist mod into jumpDistanceMod", async () => {
        const outfit = await OutfitParse(
            fakeOutf([["hyperspace dist mod", -300]]), () => { });
        expect(outfit.physics.jumpDistanceMod).toEqual(-300);
    });

    it("parses fast jump into canJumpWithoutSlowing", async () => {
        const outfit = await OutfitParse(
            fakeOutf([["fast jump", true]]), () => { });
        expect(outfit.physics.canJumpWithoutSlowing).toEqual(true);
    });

    it("parses the inertial damper into inertialess", async () => {
        const outfit = await OutfitParse(
            fakeOutf([["inertial damper", true]]), () => { });
        expect(outfit.physics.inertialess).toEqual(true);
    });

    it("omits jump properties from outfits without them", async () => {
        const outfit = await OutfitParse(fakeOutf([["shield", 55]]), () => { });
        expect(outfit.physics.jumpDistanceMod).toBeUndefined();
        expect(outfit.physics.canJumpWithoutSlowing).toBeUndefined();
        expect(outfit.physics.shield).toEqual(55);
    });

    it("negates the murk modifier ModVal into murkClear", async () => {
        // A Sensor Boost (nova:203) carries murk modifier -3, which the Bible
        // defines as adding -3 to system murkiness, i.e. clearing 3 murk.
        const outfit = await OutfitParse(
            fakeOutf([["murk modifier", -3]]), () => { });
        expect(outfit.murkClear).toEqual(3);
    });

    it("passes the interference mod ModVal through as a reduction", async () => {
        const outfit = await OutfitParse(
            fakeOutf([["interference mod", 20]]), () => { });
        expect(outfit.interferenceReduction).toEqual(20);
    });

    it("sums murk and interference across mod pairs", async () => {
        const outfit = await OutfitParse(fakeOutf([
            ["murk modifier", -3], ["murk modifier", -2],
            ["interference mod", 20], ["interference mod", 5],
        ]), () => { });
        expect(outfit.murkClear).toEqual(5);
        expect(outfit.interferenceReduction).toEqual(25);
    });

    it("parses IFF into the iff flag", async () => {
        const outfit = await OutfitParse(fakeOutf([["IFF", true]]), () => { });
        expect(outfit.iff).toBe(true);
    });

    it("parses auto refuel and multi-jump", async () => {
        const outfit = await OutfitParse(fakeOutf([
            ["auto refuel", true], ["multi-jump", 10],
        ]), () => { });
        expect(outfit.autoRefuel).toBe(true);
        expect(outfit.multiJump).toEqual(10);
    });

    it("parses the stubbed passive ModTypes into typed fields", async () => {
        const outfit = await OutfitParse(fakeOutf([
            ["density scanner", true], ["map", 3], ["marines", 25],
            ["repair system", true], ["escape pod", true],
            ["auto eject", true], ["clean legal record", -1],
            ["iff scrambler", 5], ["reinforcement inhibitor", -1],
            ["paint", 0x1234], ["bomb", -1], ["nonlethal bomb", 200],
        ]), () => { });
        expect(outfit.densityScanner).toBe(true);
        expect(outfit.map).toEqual(3);
        expect(outfit.marines).toEqual(25);
        expect(outfit.repairSystem).toBe(true);
        expect(outfit.escapePod).toBe(true);
        expect(outfit.autoEject).toBe(true);
        expect(outfit.cleanLegalRecord).toEqual(-1);
        expect(outfit.iffScramblerClass).toEqual(5);
        expect(outfit.reinforcementInhibitorClass).toEqual(-1);
        expect(outfit.paintColor).toEqual(0x1234);
        expect(outfit.bomb).toEqual(-1);
        expect(outfit.nonlethalBomb).toEqual(200);
    });

    it("leaves passive fields at their defaults for unrelated outfits", async () => {
        const outfit = await OutfitParse(fakeOutf([["shield", 55]]), () => { });
        expect(outfit.murkClear).toEqual(0);
        expect(outfit.interferenceReduction).toEqual(0);
        expect(outfit.iff).toBe(false);
        expect(outfit.autoRefuel).toBe(false);
        expect(outfit.multiJump).toEqual(0);
        expect(outfit.map).toBeNull();
        expect(outfit.iffScramblerClass).toBeNull();
    });
});
