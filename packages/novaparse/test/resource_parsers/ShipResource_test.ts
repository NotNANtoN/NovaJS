import "jasmine";
import { readResourceFork, ResourceMap } from "resource_fork";
import { ShipResource } from "../../src/resource_parsers/ShipResource.js";
import { defaultIDSpace } from "./DefaultIDSpace.js";

import { resolveFixture } from "../../test/fixtures.js";

describe("ShipResource", () => {
    // Ships don't depend on other resources.
    const idSpace = defaultIDSpace;

    let rf: ResourceMap;
    let s1: ShipResource;
    beforeEach(async () => {
        const dataPath = resolveFixture("resource_examples/ship.ndat");
        rf = await readResourceFork(dataPath, false);

        var ships = rf.shïp;
        s1 = new ShipResource(ships[128], idSpace);
    });

    it("should parse longName", () => {
        expect(s1.longName).toEqual("a long name of ship");
    });

    it("should parse shortName", () => {
        expect(s1.shortName).toEqual("the short name");
    });

    it("should parse subtitle", () => {
        expect(s1.subtitle).toEqual("the subtitle");
    });

    it("should parse commName", () => {
        expect(s1.commName).toEqual("the comm name");
    });

    it("should parse cost", () => {
        expect(s1.cost).toEqual(1);
    });

    it("should parse deathDelay", () => {
        expect(s1.deathDelay).toEqual(67);
    });

    it("should parse deathDelay", () => {
        expect(s1.deathDelay).toEqual(67);
    });

    it("should parse initialExplosion", () => {
        expect(s1.initialExplosion).toEqual(168);
    });

    it("should parse finalExplosion", () => {
        expect(s1.finalExplosion).toEqual(169);
    });

    it("should parse finalExplosionSparks", () => {
        expect(s1.finalExplosionSparks).toEqual(true);
    });

    it("should parse displayOrder", () => {
        expect(s1.displayOrder).toEqual(3);
    });

    it("should parse mass", () => {
        expect(s1.mass).toEqual(4147);
    });

    it("should parse length", () => {
        expect(s1.length).toEqual(8);
    });

    it("should parse inherentAI", () => {
        expect(s1.inherentAI).toEqual(1);
    });

    it("should parse crew", () => {
        expect(s1.crew).toEqual(16);
    });

    it("should parse strength", () => {
        expect(s1.strength).toEqual(10);
    });

    it("should parse inherentGovt", () => {
        expect(s1.inherentGovt).toEqual(128);
    });

    // it("should parse flags", () => {
    //     // write me
    //     //expect(s1.flags).toEqual(6);
    // });

    it("should parse podCount", () => {
        // escape pods
        expect(s1.podCount).toEqual(9);
    });

    it("should parse techLevel", () => {
        expect(s1.techLevel).toEqual(2);
    });

    it("should parse buyRandom", () => {
        expect(s1.buyRandom).toEqual(4);
    });

    it("should parse hireRandom", () => {
        expect(s1.hireRandom).toEqual(5);
    });

    it("should parse cargoSpace", () => {
        expect(s1.cargoSpace).toEqual(14);
    });

    it("should parse freeSpace", () => {
        expect(s1.freeSpace).toEqual(3841);
    });

    it("should parse acceleration", () => {
        expect(s1.acceleration).toEqual(11);
    });

    it("should parse speed", () => {
        expect(s1.speed).toEqual(12);
    });

    it("should parse turnRate", () => {
        expect(s1.turnRate).toEqual(13);
    });

    it("should parse shield", () => {
        expect(s1.shield).toEqual(17);
    });

    it("should parse shieldRecharge", () => {
        expect(s1.shieldRecharge).toEqual(18);
    });

    it("should parse armor", () => {
        expect(s1.armor).toEqual(19);
    });

    it("should parse armorRecharge", () => {
        expect(s1.armorRecharge).toEqual(20);
    });

    it("should parse energy", () => {
        expect(s1.energy).toEqual(21);
    });

    it("should parse energyRecharge", () => {
        expect(s1.energyRecharge).toEqual(22);
    });

    it("should parse skillVariation", () => {
        expect(s1.skillVariation).toEqual(5);
    });

    it("should parse availabilityNCB", () => {
        expect(s1.availabilityNCB).toEqual("b13");
    });

    it("should parse appearOn", () => {
        expect(s1.appearOn).toEqual("b123 & (b232 | !b42)");
    });

    it("should parse onPurchase", () => {
        expect(s1.onPurchase).toEqual("b1 b2 !b3 ^b4");
    });

    it("should parse deionize", () => {
        expect(s1.deionize).toEqual(24);
    });

    it("should parse ionization", () => {
        expect(s1.ionization).toEqual(23);
    });

    it("should parse keyCarried", () => {
        expect(s1.keyCarried).toEqual(137);
    });

    // I don't know what defaultItems2 is

    it("should parse outfits", () => {
        expect(s1.outfits).toEqual(
            [
                { id: 149, 'count': 50 },
                { id: 151, 'count': 52 },
                { id: 153, 'count': 54 },
                { id: 155, 'count': 56 },
                { id: 157, 'count': 58 },
                { id: 159, 'count': 60 },
                { id: 161, 'count': 62 },
                { id: 163, 'count': 64 }
            ]
        );
    });

    it("should parse weapons", () => {
        expect(s1.weapons).toEqual(
            [
                { id: 225, 'count': 26, 'ammo': 27 },
                { id: 128, 'count': 29, 'ammo': 30 },
                { id: 131, 'count': 32, 'ammo': 33 },
                { id: 134, 'count': 35, 'ammo': 36 },
                { id: 137, 'count': 38, 'ammo': 39 },
                { id: 140, 'count': 41, 'ammo': 42 },
                { id: 143, 'count': 44, 'ammo': 45 },
                { id: 146, 'count': 47, 'ammo': 48 }
            ]
        );
    });

    it("should parse maxGuns", () => {
        expect(s1.maxGuns).toEqual(65);
    });

    it("should parse maxTurrets", () => {
        expect(s1.maxTurrets).toEqual(66);
    });
});
