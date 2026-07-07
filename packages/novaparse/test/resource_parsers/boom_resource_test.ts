import "jasmine";
import { readResourceFork, ResourceMap } from "resource_fork";
import { BoomResource } from "../../src/resource_parsers/boom_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { resolveFixture } from "../../test/fixtures.js";
import { ResourceBuilder } from "./resource_builder.js";

describe("BoomResource", () => {
    // Booms don't depend on other resources.
    const idSpace = defaultIDSpace;

    let rf: ResourceMap;
    let firstBoom: BoomResource;
    let silentBoom: BoomResource;
    let slowBoom: BoomResource;

    beforeEach(async () => {
        const dataPath = resolveFixture("resource_examples/boom.ndat");
        rf = await readResourceFork(dataPath, false);
        const booms = rf.bööm;
        firstBoom = new BoomResource(booms[128], idSpace);
        silentBoom = new BoomResource(booms[129], idSpace);
        slowBoom = new BoomResource(booms[130], idSpace);
    });

    it("should parse all inherited properties", () => {
        expect(firstBoom.id).toEqual(128);
    });

    it("should parse animation rate", () => {
        expect(firstBoom.animationRate).toEqual(100);
        expect(silentBoom.animationRate).toEqual(79);
        expect(slowBoom.animationRate).toEqual(23);
    });

    it("should parse sound", () => {
        expect(firstBoom.sound).toEqual(300);
        expect(silentBoom.sound).toEqual(null);
        expect(slowBoom.sound).toEqual(344);

    });

    it("should parse graphic", () => {
        expect(firstBoom.graphic).toEqual(400);
        expect(silentBoom.graphic).toEqual(423);
        expect(slowBoom.graphic).toEqual(412);
    });

    it("throws when the graphic index is missing", () => {
        // A bööm with Graphic set to -1 (or truncated before it) has no
        // sprite to animate, so parsing must fail loudly.
        const b = new ResourceBuilder().int16(100).int16(-1).int16(-1);
        expect(() => new BoomResource(b.resource("bööm", 150), idSpace))
            .toThrowError(/had no graphic/);
    });
});
