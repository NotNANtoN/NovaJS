import "jasmine";
import { readResourceFork, ResourceMap } from "resource_fork";
import { BoomResource } from "../../src/resource_parsers/BoomResource.js";
import { defaultIDSpace } from "./DefaultIDSpace.js";
import { resolveFixture } from "../../test/fixtures.js";

describe("BoomResource", function() {
    // Booms don't depend on other resources.
    const idSpace = defaultIDSpace;

    let rf: ResourceMap;
    let firstBoom: BoomResource;
    let silentBoom: BoomResource;
    let slowBoom: BoomResource;

    beforeEach(async function() {
        const dataPath = resolveFixture("resource_examples/boom.ndat");
        rf = await readResourceFork(dataPath, false);
        const booms = rf.bööm;
        firstBoom = new BoomResource(booms[128], idSpace);
        silentBoom = new BoomResource(booms[129], idSpace);
        slowBoom = new BoomResource(booms[130], idSpace);
    });

    it("should parse all inherited properties", function() {
        expect(firstBoom.id).toEqual(128);
    });

    it("should parse animation rate", function() {
        expect(firstBoom.animationRate).toEqual(100);
        expect(silentBoom.animationRate).toEqual(79);
        expect(slowBoom.animationRate).toEqual(23);
    });

    it("should parse sound", function() {
        expect(firstBoom.sound).toEqual(300);
        expect(silentBoom.sound).toEqual(null);
        expect(slowBoom.sound).toEqual(344);

    });

    it("should parse graphic", function() {
        expect(firstBoom.graphic).toEqual(400);
        expect(silentBoom.graphic).toEqual(423);
        expect(slowBoom.graphic).toEqual(412);
    });
});
