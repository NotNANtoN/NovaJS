import "jasmine";
import { CronResource } from "../../src/resource_parsers/cron_resource.js";
import { defaultIDSpace } from "./default_id_space.js";
import { ResourceBuilder } from "./resource_builder.js";

/** A crön resource with every field set to a distinct, recognizable value. */
function buildCron(): ResourceBuilder {
    const b = new ResourceBuilder();
    b.int16(3)                                  // firstDay
        .int16(4)                               // firstMonth
        .int16(1177)                            // firstYear
        .int16(28)                              // lastDay
        .int16(11)                              // lastMonth
        .int16(1200)                            // lastYear
        .int16(75)                              // random
        .int16(30)                              // duration
        .int16(5)                               // preHoldoff
        .int16(10)                              // postHoldoff
        .int16(9000)                            // indNewsStr
        .uint16(0x0003)                         // flags
        .string("b100", 0xff)                   // enableOn (NCB test)
        .string("b101 b102", 0xff)              // onStart (NCB set)
        .string("!b101", 0x100)                 // onEnd (NCB set)
        .uint64(0x0000000100000002n)            // contribute
        .uint64(0x0000000300000004n)            // require
        .array([200, 201, -1, -1], v => b.int16(v))    // govt ids x4
        .array([8001, 8002, -1, -1], v => b.int16(v)); // STR# ids x4
    return b;
}

describe("CronResource", () => {
    // Crons don't depend on other resources.
    const idSpace = defaultIDSpace;

    let cron: CronResource;

    beforeEach(() => {
        cron = new CronResource(
            buildCron().resource("crön", 128, "Test Cron"), idSpace);
    });

    it("builds a full-size resource", () => {
        // 822 bytes is the size of every crön in Nova's own data files.
        expect(buildCron().byteLength).toBe(822);
    });

    it("parses the date range", () => {
        expect(cron.firstDay).toBe(3);
        expect(cron.firstMonth).toBe(4);
        expect(cron.firstYear).toBe(1177);
        expect(cron.lastDay).toBe(28);
        expect(cron.lastMonth).toBe(11);
        expect(cron.lastYear).toBe(1200);
    });

    it("parses timing fields", () => {
        expect(cron.random).toBe(75);
        expect(cron.duration).toBe(30);
        expect(cron.preHoldoff).toBe(5);
        expect(cron.postHoldoff).toBe(10);
    });

    it("parses indNewsStr", () => {
        expect(cron.indNewsStr).toBe(9000);
    });

    it("parses flags", () => {
        expect(cron.flags).toBe(0x0003);
        expect(cron.loopOnStart).toBe(true);
        expect(cron.loopOnEnd).toBe(true);
    });

    it("parses the NCB expressions", () => {
        expect(cron.enableOn).toBe("b100");
        expect(cron.onStart).toBe("b101 b102");
        expect(cron.onEnd).toBe("!b101");
    });

    it("parses contribute and require", () => {
        expect(cron.contribute).toBe(0x0000000100000002n);
        expect(cron.require).toBe(0x0000000300000004n);
    });

    it("zips govt news, dropping unused entries", () => {
        expect(cron.govtNews).toEqual([
            { govt: 200, newsStr: 8001 },
            { govt: 201, newsStr: 8002 },
        ]);
    });

    it("defaults fields past the end of a truncated resource", () => {
        // Cut off immediately after postHoldoff.
        const truncated = buildCron().truncate(20);
        const cron = new CronResource(
            truncated.resource("crön", 130, "Truncated"), idSpace);
        expect(cron.postHoldoff).toBe(10);
        expect(cron.indNewsStr).toBe(-1);
        expect(cron.flags).toBe(0);
        expect(cron.enableOn).toBe("");
        expect(cron.contribute).toBe(0n);
        expect(cron.govtNews).toEqual([]);
    });
});
