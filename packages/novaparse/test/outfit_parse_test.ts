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
        idSpace: { PICT: {}, dësc: {}, wëap: {} },
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
});
