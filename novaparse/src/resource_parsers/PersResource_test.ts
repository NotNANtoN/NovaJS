import "jasmine";
import * as path from "path";
import { Resource } from "resource_fork";
import { skipWithoutRetailData } from "../../../test/retail_data";
import { getEmptyNovaResources } from "./ResourceHolderBase";
import { PersResource } from "./PersResource";

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

function shapedPersResource(): Resource {
    const data = new DataView(new ArrayBuffer(400));
    data.setInt16(0, 20007);
    data.setInt16(2, 157);
    data.setInt16(4, 3);
    data.setInt16(6, 2);
    data.setInt16(8, 25);
    data.setInt16(10, 279);
    data.setInt16(12, 133);
    data.setInt16(14, 131);
    data.setInt16(16, 129);
    data.setInt16(18, 135);
    data.setInt16(20, 1);
    data.setInt16(22, 1);
    data.setInt16(24, 1);
    data.setInt16(26, 2);
    data.setInt16(34, 50);
    data.setInt32(36, 250000);
    data.setInt16(40, 200);
    data.setInt16(42, 0);
    data.setInt16(44, 1);
    data.setInt16(46, 1);
    data.setInt16(48, 140);
    data.setUint16(50, 0x080b);
    writeText(data, 52, 255, "b0 & !b8");
    data.setInt16(308, 17);
    data.setInt16(310, 60);
    data.setInt16(312, 4);
    writeText(data, 314, 64, "Night-Master");
    data.setUint32(378, 0x00112233);
    data.setUint16(382, 1);
    return { id: 131, name: "Jack Folstam", data } as Resource;
}

describe("PersResource", () => {
    it("parses the verified 400-byte retail layout", () => {
        const pers = new PersResource(
            shapedPersResource(), getEmptyNovaResources());

        expect(pers.linkSyst).toBe(20007);
        expect(pers.government).toBe(157);
        expect(pers.aiType).toBe(3);
        expect(pers.aggress).toBe(2);
        expect(pers.coward).toBe(25);
        expect(pers.shipType).toBe(279);
        expect(pers.weaponTypes).toEqual([133, 131, 129, 135]);
        expect(pers.weaponCounts).toEqual([1, 1, 1, 2]);
        expect(pers.ammoLoads).toEqual([0, 0, 0, 50]);
        expect(pers.credits).toBe(250000);
        expect(pers.shieldMod).toBe(200);
        expect(pers.commQuote).toBe(1);
        expect(pers.hailQuote).toBe(1);
        expect(pers.linkMission).toBe(140);
        expect(pers.flags).toBe(0x080b);
        expect(pers.activeOn).toBe("b0 & !b8");
        expect(pers.grantClass).toBe(17);
        expect(pers.grantProb).toBe(60);
        expect(pers.grantCount).toBe(4);
        expect(pers.shipSubtitle).toBe("Night-Master");
        expect(pers.colour).toBe(0x00112233);
        expect(pers.flags2).toBe(1);
    });

    it("parses all 516 retail persons through NovaParse", async () => {
        if (skipWithoutRetailData()) {
            return;
        }
        for (const name of [
            "Lame", "Presets", "GainAnalysis", "QuantizePVT", "Quantize",
            "Takehiro", "Reservoir", "MPEGMode", "BitStream",
        ]) {
            (globalThis as Record<string, unknown>)[name] = undefined;
        }
        const { NovaParse } = await import("../../NovaParse");
        const parser = new NovaParse(path.join(
            process.env.NOVAJS_ROOT ?? process.cwd(),
            "nova",
            "Nova_Data",
        ), false);
        const ids = await parser.ids;
        const raw = await parser.idSpace;
        const jack = await parser.data.Pers!.get("nova:131");
        const people = await Promise.all(
            (ids.Pers ?? []).map(id => parser.data.Pers!.get(id)),
        );

        expect(ids.Pers?.length).toBe(516);
        expect(raw instanceof Error).toBeFalse();
        if (raw instanceof Error) {
            return;
        }
        expect(Object.keys(raw.përs).length).toBe(516);
        expect(Object.values(raw.përs)
            .every(resource => resource.data.byteLength === 400)).toBeTrue();
        expect(people.length).toBe(516);
        expect(people.every(person => person.shipType.length > 0)).toBeTrue();
        expect(jack.name).toBe("Jack Folstam");
        expect(jack.linkSyst).toBe("nova:132");
        expect(jack.shipType).toBe("nova:279");
        expect(jack.weaponTypes).toEqual([
            "nova:133",
            "nova:131",
            "nova:129",
            "nova:135",
        ]);
        expect(jack.credits).toBe(250000);
        expect(jack.shieldMod).toBe(200);
        expect(jack.commQuote).toBe(1);
        expect(jack.hailQuote).toBe(1);
        expect(jack.linkMission).toBe("nova:140");
        expect(jack.activeOn).toBe("b0 & !b8");
        expect(jack.shipSubtitle).toBe("Night-Master");
    });
});
