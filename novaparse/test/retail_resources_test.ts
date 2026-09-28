import "jasmine";
import { retailDataPath, skipWithoutRetailData, hasRetailData } from "../../test/retail_data";
import type { NovaParse } from "../NovaParse";

/**
 * Pins retail byte layouts (verified against hex dumps of nova/Nova_Data) for
 * the flag and NCB fields that storyline gating depends on. Everything is
 * checked through the public parsed data, i.e. what the server serves.
 */
describe("retail resource layouts", () => {
    let parser: NovaParse;

    beforeAll(async () => {
        if (!hasRetailData()) return;
        // lamejs assigns these CommonJS globals while NovaParse's sound parser
        // is bundled by the focused-test runner.
        for (const name of [
            "Lame", "Presets", "GainAnalysis", "QuantizePVT", "Quantize",
            "Takehiro", "Reservoir", "MPEGMode", "BitStream",
        ]) {
            (globalThis as Record<string, unknown>)[name] = undefined;
        }
        const { NovaParse } = await import("../NovaParse");
        parser = new NovaParse(retailDataPath(), false);
        await parser.ids;
    });

    const isUint32Pair = (value: unknown) => Array.isArray(value)
        && value.length === 2
        && value.every(v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff);

    const printable = /^[\x20-\x7e]*$/;

    it("parses oütf contribute, require, onPurchase and onSell", async () => {
        if (skipWithoutRetailData()) return;
        const outfit = (id: number) => parser.data.Outfit.get(`nova:${id}`);

        const exotic = await outfit(265);
        expect(exotic.name).toBe("Exotic Ships & Weapons License");
        expect(exotic.contribute).toEqual([0x1ff, 0]);
        expect((await outfit(257)).contribute).toEqual([1, 0]);

        const chromeValk = await outfit(314);
        expect(chromeValk.name).toBe("Chrome Valk Upgrade");
        expect(chromeValk.require).toEqual([0, 0x80000001]);
        expect((await outfit(316)).require).toEqual([0, 0x40000001]);
        expect((await outfit(128)).require).toEqual([0, 1]);

        const reactor = await outfit(358);
        expect(reactor.name).toBe("Cheap Thorium Reactor");
        expect(reactor.onSell).toBe("!b9011");
        expect((await outfit(363)).onPurchase)
            .toBe("S731 D265 D264 D263 D260 D259 D258 D257");
    });

    it("keeps every oütf flag pair and NCB string well formed", async () => {
        if (skipWithoutRetailData()) return;
        const ids = (await parser.ids).Outfit;
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) {
            const outfit = await parser.data.Outfit.get(id);
            expect(isUint32Pair(outfit.contribute)).withContext(`${id} contribute`).toBeTrue();
            expect(isUint32Pair(outfit.require)).withContext(`${id} require`).toBeTrue();
            expect(outfit.onPurchase).withContext(`${id} onPurchase`).toMatch(printable);
            expect(outfit.onSell ?? "").withContext(`${id} onSell`).toMatch(printable);
        }
    });

    it("parses shïp contribute and require", async () => {
        if (skipWithoutRetailData()) return;
        const ship = (id: number) => parser.data.Ship.get(`nova:${id}`);
        const expectations: Array<[number, [number, number]?, [number, number]?]> = [
            [132, [0, 0x21], [0x40, 0]],
            [131, [0, 0x11]],
            [134, [0, 0x41]],
            [133, [0, 0x80000001], [0xb, 0]],
            [137, [0, 0x40010001]],
            [143, undefined, [0xcf, 0]],
            [128, [0, 1], [0, 0]],
            [381, [0, 0]],
        ];
        for (const [id, contribute, require] of expectations) {
            const data = await ship(id);
            if (contribute) {
                expect(data.contribute).withContext(`shïp ${id} contribute`).toEqual(contribute);
            }
            if (require) {
                expect(data.require).withContext(`shïp ${id} require`).toEqual(require);
            }
        }
        expect((await ship(132)).name).toContain("Pegasus");
        expect((await ship(381)).name).toContain("Dart");

        for (const id of (await parser.ids).Ship) {
            const data = await parser.data.Ship.get(id);
            expect(isUint32Pair(data.contribute)).withContext(`${id} contribute`).toBeTrue();
            expect(isUint32Pair(data.require)).withContext(`${id} require`).toBeTrue();
        }
    });

    it("parses mïsn require as [high, low]", async () => {
        if (skipWithoutRetailData()) return;
        const mission = (id: number) => parser.data.Mission.get(`nova:${id}`);
        expect((await mission(557)).require).toEqual([0, 0x10]);
        expect((await mission(561)).require).toEqual([0, 0x20]);
        expect((await mission(569)).require).toEqual([0, 0x40]);
        expect((await mission(128)).require).toEqual([0, 0]);

        const ids = (await parser.ids).Mission ?? [];
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) {
            const data = await parser.data.Mission.get(id);
            expect(isUint32Pair(data.require)).withContext(`${id} require`).toBeTrue();
        }
    });

    it("parses ränk salary, priceMod, contribute and names", async () => {
        if (skipWithoutRetailData()) return;
        const rank = (id: number) => parser.data.Rank!.get(`nova:${id}`);

        const r128 = await rank(128);
        expect(r128.salary).toBe(200);
        expect(r128.salaryCap).toBe(0);
        expect(r128.priceMod).toBe(85);
        expect(r128.contribute).toEqual([0x7b, 0]);
        expect(r128.flags).toBe(0x0b08);
        expect(r128.convName.startsWith("Commander")).toBeTrue();

        const r144 = await rank(144);
        expect(r144.salary).toBe(350);
        expect(r144.salaryCap).toBe(350000);
        expect(r144.priceMod).toBe(75);

        expect((await rank(129)).contribute).toEqual([0x1ff, 0]);

        const ids = (await parser.ids).Rank;
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) {
            const data = await parser.data.Rank!.get(id);
            expect(data.salary).withContext(`${id} salary`).toBeGreaterThanOrEqual(0);
            // Retail stores 0 on ranks that carry no price modifier
            // (couriers, duel protectors, ...); everything else is 1..500.
            if (data.priceMod !== 0) {
                expect(data.priceMod).withContext(`${id} priceMod`).toBeGreaterThanOrEqual(1);
                expect(data.priceMod).withContext(`${id} priceMod`).toBeLessThanOrEqual(500);
            }
            expect(isUint32Pair(data.contribute)).withContext(`${id} contribute`).toBeTrue();
        }
    });

    it("parses spöb dominate/release/destroy/regen expressions", async () => {
        if (skipWithoutRetailData()) return;
        const earth = await parser.data.Planet.get("nova:128");
        expect(earth.name).toBe("Earth");
        expect(earth.onDominate).toBe("b6100");
        expect(earth.onDestroy).toBe("b6200");

        const merrol = await parser.data.Planet.get("nova:171");
        expect(merrol.name).toBe("Merrol");
        expect(merrol.onDominate).toBe("b6101");
        expect(merrol.onDestroy).toBe("b6201");

        const ncb = /^[\sA-Za-z0-9!^&|()]*$/;
        for (const id of (await parser.ids).Planet) {
            const data = await parser.data.Planet.get(id);
            for (const field of ["onDominate", "onRelease", "onDestroy", "onRegen"] as const) {
                expect(data[field] ?? "").withContext(`${id} ${field}`).toMatch(ncb);
            }
        }
    });

    it("parses the chär starting template", async () => {
        if (skipWithoutRetailData()) return;
        const ids = await parser.ids;
        expect(ids.Char).toEqual(["nova:128"]);

        const trader = await parser.data.Char!.get("nova:128");
        expect(trader.name).toBe(".Trader");
        expect(trader.cash).toBe(25000);
        expect(trader.shipType).toBe(128);
        expect(trader.systems).toEqual([128, 136, 170, 184]);
        expect(trader.governments).toEqual([-1, -1, -1, -1]);
        expect(trader.status).toEqual([-1, -1, -1, -1]);
        expect(trader.kills).toBe(0);
        expect(trader.introPicts).toEqual([8200, 8201, 8202, -1]);
        expect(trader.introPictDelays).toEqual([45, 45, 45, -1]);
        expect(trader.introText).toBe(-1);
        expect(trader.onStart).toBe("");
        expect(trader.flags).toBe(1);
        expect(trader.startDay).toBe(23);
        expect(trader.startMonth).toBe(6);
        expect(trader.startYear).toBe(1177);
        expect(trader.datePrefix).toBe("");
        expect(trader.dateSuffix).toBe(" NC");
    });

    it("serves crön and öops gettables", async () => {
        if (skipWithoutRetailData()) return;
        const ids = await parser.ids;
        expect(ids.Cron.length).toBeGreaterThan(0);
        expect(ids.Oops.length).toBeGreaterThan(0);
        const cron = await parser.data.Cron!.get(ids.Cron[0]);
        expect(cron.id).toBe(ids.Cron[0]);
        const oops = await parser.data.Oops!.get(ids.Oops[0]);
        expect(oops.id).toBe(ids.Oops[0]);
    });
});
