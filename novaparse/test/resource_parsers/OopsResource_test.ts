import "jasmine";
import { Resource } from "resource_fork";
import { OopsResource } from "../../src/resource_parsers/OopsResource";
import { defaultIDSpace } from "./DefaultIDSpace";
import { OopsParse } from "../../src/parsers/OopsParse";

describe("OopsResource & OopsParse", () => {
    it("parses binary oops layout", async () => {
        const buffer = new ArrayBuffer(282);
        const view = new DataView(buffer);

        view.setInt16(0, 137); // stellar
        view.setInt16(2, 0);   // commodity (food)
        view.setInt16(4, -15); // priceDelta
        view.setInt16(6, 30);  // duration
        view.setInt16(8, 35);  // freq

        const activateStr = "!b80";
        for (let i = 0; i < activateStr.length; i++) {
            view.setUint8(10 + i, activateStr.charCodeAt(i));
        }

        const res = {
            id: 128,
            name: "An enormous food surplus",
            type: "öops",
            data: view,
        } as Resource;

        const oopsRes = new OopsResource(res, defaultIDSpace);
        oopsRes.globalID = "nova:128";
        oopsRes.prefix = "nova";

        expect(oopsRes.stellar).toBe(137);
        expect(oopsRes.commodity).toBe(0);
        expect(oopsRes.priceDelta).toBe(-15);
        expect(oopsRes.duration).toBe(30);
        expect(oopsRes.freq).toBe(35);
        expect(oopsRes.activateOn).toBe("!b80");

        const data = await OopsParse(oopsRes, () => {});
        expect(data.name).toBe("An enormous food surplus");
        expect(data.priceDelta).toBe(-15);
        expect(data.activateOn).toBe("!b80");
    });
});
