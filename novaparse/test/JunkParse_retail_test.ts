import "jasmine";
import * as path from "path";

describe("retail jünk pipeline", () => {
    it("exposes all retail goods as typed game data", async () => {
        // lamejs assigns these CommonJS globals while NovaParse's sound parser
        // is bundled by the focused-test runner.
        for (const name of [
            "Lame", "Presets", "GainAnalysis", "QuantizePVT", "Quantize",
            "Takehiro", "Reservoir", "MPEGMode", "BitStream",
        ]) {
            (globalThis as Record<string, unknown>)[name] = undefined;
        }
        const { NovaParse } = await import("../NovaParse");
        const parser = new NovaParse(path.join(
            process.env.NOVAJS_ROOT ?? process.cwd(),
            "nova",
            "Nova_Data",
        ), false);
        const ids = await parser.ids;
        const pelts = await parser.data.Junk.get("nova:128");

        expect(ids.Junk?.length).toBe(23);
        expect(pelts.name).toBe("Vrenna Ice Lizard Pelts");
        expect(pelts.soldAt).toEqual(["nova:219", "nova:449"]);
        expect(pelts.boughtAt).toEqual([
            "nova:164",
            "nova:175",
            "nova:207",
            "nova:242",
            "nova:267",
            "nova:345",
        ]);
        expect(pelts.basePrice).toBe(750);
        expect(pelts.scanMask).toBe(0x0800);
        expect(pelts.lcName).toBe("ice-lizard pelts");
        expect(pelts.abbreviation).toBe("Pelts");
    });
});
