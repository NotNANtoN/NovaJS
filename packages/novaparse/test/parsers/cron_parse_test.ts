import "jasmine";
import { CronResource } from "../../src/resource_parsers/cron_resource.js";
import { CronParse } from "../../src/parsers/cron_parse.js";
import { defaultIDSpace } from "../resource_parsers/default_id_space.js";
import { ResourceBuilder } from "../resource_parsers/resource_builder.js";

/**
 * A crön resource with every field set to a distinct, recognizable
 * value. Mirrors cron_resource_test.ts; this test focuses on the
 * projection onto CronData.
 */
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
        .string("b100", 0xff)                   // enableOn
        .string("b101 b102", 0xff)              // onStart
        .string("!b101", 0x100)                 // onEnd
        .uint64(0x0000000100000002n)            // contribute
        .uint64(0x0000000300000004n)            // require
        .array([200, 201, -1, -1], v => b.int16(v))    // govt ids x4
        .array([8001, 8002, -1, -1], v => b.int16(v)); // STR# ids x4
    return b;
}

function parseCron() {
    const resource = new CronResource(
        buildCron().resource("crön", 128, "Test Cron"), defaultIDSpace);
    resource.globalID = "nova:128";
    resource.prefix = "nova";
    return CronParse(resource, () => { });
}

describe("CronParse", () => {
    it("carries the BaseData fields", async () => {
        const cron = await parseCron();
        expect(cron.id).toBe("nova:128");
        expect(cron.name).toBe("Test Cron");
        expect(cron.prefix).toBe("nova");
    });

    it("projects the date range and timing fields", async () => {
        const cron = await parseCron();
        expect(cron.firstDay).toBe(3);
        expect(cron.firstMonth).toBe(4);
        expect(cron.firstYear).toBe(1177);
        expect(cron.lastDay).toBe(28);
        expect(cron.lastMonth).toBe(11);
        expect(cron.lastYear).toBe(1200);
        expect(cron.random).toBe(75);
        expect(cron.duration).toBe(30);
        expect(cron.preHoldoff).toBe(5);
        expect(cron.postHoldoff).toBe(10);
    });

    it("decodes the loop flags", async () => {
        const cron = await parseCron();
        expect(cron.loopOnStart).toBe(true);
        expect(cron.loopOnEnd).toBe(true);
    });

    it("projects the NCB expressions verbatim", async () => {
        const cron = await parseCron();
        expect(cron.enableOn).toBe("b100");
        expect(cron.onStart).toBe("b101 b102");
        expect(cron.onEnd).toBe("!b101");
    });

    it("serializes contribute/require as decimal strings", async () => {
        const cron = await parseCron();
        expect(cron.contribute).toBe(0x0000000100000002n.toString());
        expect(cron.require).toBe(0x0000000300000004n.toString());
        expect(() => JSON.stringify(cron)).not.toThrow();
    });
});
