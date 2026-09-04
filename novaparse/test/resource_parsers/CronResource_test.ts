import "jasmine";
import { Resource } from "resource_fork";
import { CronResource } from "../../src/resource_parsers/CronResource";
import { defaultIDSpace } from "./DefaultIDSpace";
import { CronParse } from "../../src/parsers/CronParse";

describe("CronResource & CronParse", () => {
    it("should parse fields from raw binary buffer", async () => {
        const buffer = new ArrayBuffer(822);
        const view = new DataView(buffer);

        view.setInt16(0, 15); // firstDay
        view.setInt16(2, 6);  // firstMonth
        view.setInt16(4, 1180); // firstYear
        view.setInt16(6, 20); // lastDay
        view.setInt16(8, 7);  // lastMonth
        view.setInt16(10, 1185); // lastYear
        view.setInt16(12, 85); // random
        view.setInt16(14, 30); // duration
        view.setInt16(16, 5);  // preHoldoff
        view.setInt16(18, 10); // postHoldoff
        view.setInt16(20, 15020); // indNewsStr
        view.setUint16(22, 1); // flags (continuous iterative entry)

        // Write enableOn at 24
        const enableStr = "b128 & !b129";
        for (let i = 0; i < enableStr.length; i++) {
            view.setUint8(24 + i, enableStr.charCodeAt(i));
        }

        // Write onStart at 279
        const onStartStr = "b129";
        for (let i = 0; i < onStartStr.length; i++) {
            view.setUint8(279 + i, onStartStr.charCodeAt(i));
        }

        // Write onEnd at 534
        const onEndStr = "!b128";
        for (let i = 0; i < onEndStr.length; i++) {
            view.setUint8(534 + i, onEndStr.charCodeAt(i));
        }

        // News govts at 806
        view.setInt16(806, 128);
        view.setInt16(808, 129);
        view.setInt16(814, 15000);
        view.setInt16(816, 15001);

        const res = {
            id: 128,
            name: "Test Cron",
            type: "crön",
            data: view,
        } as Resource;

        const cronRes = new CronResource(res, defaultIDSpace);
        cronRes.globalID = "nova:128";
        cronRes.prefix = "nova";
        expect(cronRes.firstDay).toBe(15);
        expect(cronRes.firstMonth).toBe(6);
        expect(cronRes.firstYear).toBe(1180);
        expect(cronRes.lastYear).toBe(1185);
        expect(cronRes.random).toBe(85);
        expect(cronRes.duration).toBe(30);
        expect(cronRes.preHoldoff).toBe(5);
        expect(cronRes.postHoldoff).toBe(10);
        expect(cronRes.indNewsStr).toBe(15020);
        expect(cronRes.flags).toBe(1);
        expect(cronRes.enableOn).toBe("b128 & !b129");
        expect(cronRes.onStart).toBe("b129");
        expect(cronRes.onEnd).toBe("!b128");
        expect(cronRes.newsGovt[0]).toBe(128);
        expect(cronRes.govtNewsStr[0]).toBe(15000);

        const data = await CronParse(cronRes, () => {});
        expect(data.name).toBe("Test Cron");
        expect(data.firstYear).toBe(1180);
        expect(data.enableOn).toBe("b128 & !b129");
        expect(data.onStart).toBe("b129");
    });
});
