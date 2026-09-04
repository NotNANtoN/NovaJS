import "jasmine";
import { Resource } from "resource_fork";
import { RankResource } from "../../src/resource_parsers/RankResource";
import { defaultIDSpace } from "./DefaultIDSpace";
import { RankParse } from "../../src/parsers/RankParse";

describe("RankResource & RankParse", () => {
    it("parses binary rank layout", async () => {
        const buffer = new ArrayBuffer(152);
        const view = new DataView(buffer);

        view.setInt16(0, 10); // weight
        view.setInt16(2, 128); // government (Federation)
        view.setInt32(4, 500); // salary
        view.setInt32(8, 10000); // salaryCap
        view.setUint32(12, 0x11223344); // contribute 1
        view.setUint32(16, 0x55667788); // contribute 2
        view.setUint32(20, 0x0100); // flags

        const convName = "Commander";
        for (let i = 0; i < convName.length; i++) {
            view.setUint8(24 + i, convName.charCodeAt(i));
        }

        const shortName = "Cmdr";
        for (let i = 0; i < shortName.length; i++) {
            view.setUint8(88 + i, shortName.charCodeAt(i));
        }

        const res = {
            id: 128,
            name: "Federation Commander",
            type: "ränk",
            data: view,
        } as Resource;

        const rankRes = new RankResource(res, defaultIDSpace);
        rankRes.globalID = "nova:128";
        rankRes.prefix = "nova";

        expect(rankRes.weight).toBe(10);
        expect(rankRes.government).toBe(128);
        expect(rankRes.salary).toBe(500);
        expect(rankRes.salaryCap).toBe(10000);
        expect(rankRes.flags).toBe(0x0100);
        expect(rankRes.convName).toBe("Commander");
        expect(rankRes.shortName).toBe("Cmdr");

        const data = await RankParse(rankRes, () => {});
        expect(data.name).toBe("Federation Commander");
        expect(data.convName).toBe("Commander");
        expect(data.shortName).toBe("Cmdr");
        expect(data.salary).toBe(500);
    });
});
