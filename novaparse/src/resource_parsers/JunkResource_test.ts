import "jasmine";
import { Resource } from "resource_fork";
import { JunkParse } from "../parsers/JunkParse";
import { getEmptyNovaResources } from "./ResourceHolderBase";
import { JunkResource } from "./JunkResource";

function writeText(
    data: DataView,
    offset: number,
    length: number,
    value: string,
) {
    for (let index = 0; index < Math.min(length, value.length); index++) {
        data.setUint8(offset + index, value.charCodeAt(index));
    }
}

function retailShapedJunk(
    id: number,
    name: string,
    soldAt: readonly number[],
    boughtAt: readonly number[],
    basePrice: number,
    buyOn = "",
): Resource {
    const data = new DataView(new ArrayBuffer(676));
    for (let index = 0; index < 8; index++) {
        data.setInt16(index * 2, soldAt[index] ?? -1);
        data.setInt16(16 + index * 2, boughtAt[index] ?? -1);
    }
    data.setInt16(32, basePrice);
    data.setUint16(34, 0);
    data.setUint16(36, 0x0800);
    writeText(data, 38, 64, "ice-lizard pelts");
    writeText(data, 102, 64, "Pelts");
    writeText(data, 166, 255, buyOn);
    return { id, name, data } as Resource;
}

describe("JunkResource", () => {
    it("parses the verified 676-byte retail layout", () => {
        const resource = retailShapedJunk(
            128,
            "Vrenna Ice Lizard Pelts",
            [219, 449],
            [164, 175, 207, 242, 267, 345],
            750,
        );
        const junk = new JunkResource(resource, getEmptyNovaResources());

        expect(junk.soldAt).toEqual([219, 449, -1, -1, -1, -1, -1, -1]);
        expect(junk.boughtAt).toEqual(
            [164, 175, 207, 242, 267, 345, -1, -1]);
        expect(junk.basePrice).toBe(750);
        expect(junk.flags).toBe(0);
        expect(junk.scanMask).toBe(0x0800);
        expect(junk.lcName).toBe("ice-lizard pelts");
        expect(junk.abbreviation).toBe("Pelts");
        expect(junk.buyOn).toBe("");
        expect(junk.sellOn).toBe("");
    });

    it("reads the retail-shaped BuyOn field at offset 166", () => {
        const resource = retailShapedJunk(
            149, "Durknen Girns", [], [311, 314, 327, 355], 3000, "b43");
        const junk = new JunkResource(resource, getEmptyNovaResources());

        expect(junk.soldAt).toEqual(new Array(8).fill(-1));
        expect(junk.basePrice).toBe(3000);
        expect(junk.buyOn).toBe("b43");
    });

    it("resolves active stellar references to game-data ids", async () => {
        const idSpace = getEmptyNovaResources();
        idSpace.spöb[219] = { globalID: "nova:219" } as any;
        idSpace.spöb[164] = { globalID: "nova:164" } as any;
        const junk = new JunkResource(retailShapedJunk(
            128, "Vrenna Ice Lizard Pelts", [219], [164], 750), idSpace);
        junk.globalID = "nova:128";
        junk.prefix = "nova";

        const parsed = await JunkParse(junk, fail);

        expect(parsed.soldAt).toEqual(["nova:219"]);
        expect(parsed.boughtAt).toEqual(["nova:164"]);
        expect(parsed.basePrice).toBe(750);
    });
});
