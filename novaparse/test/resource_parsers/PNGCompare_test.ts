
import "jasmine";
import { PNG } from "pngjs";
import { fixturePath } from "../../../test/fixture_path";
import { getFrames, getPNG, PNGCustomMatchers } from "./PNGCompare";

declare global {
    namespace jasmine {
        interface Matchers<T> {
            toEqualPNG(expected: unknown): boolean;
        }
    }
}

describe("PNGCompare", () => {
    let starbridgePNG: PNG;
    let starbridgeMask: PNG;

    beforeEach(async () => {
        jasmine.addMatchers(PNGCustomMatchers);
        starbridgePNG = await getPNG(fixturePath(
            "novajs/novaparse/test/resource_parsers/files/rleds/starbridge.png"));
        starbridgeMask = await getPNG(fixturePath(
            "novajs/novaparse/test/resource_parsers/files/rleds/starbridge_mask.png"));
    });

    it("matches the same picture", () => {
        expect(starbridgePNG).toEqualPNG(starbridgePNG);
    });

    it("rejects different pictures", () => {
        expect(starbridgePNG).not.toEqualPNG(starbridgeMask);
    });

    it("extracts frames matching individual fixtures", async () => {
        const starbridgeFrames = getFrames(starbridgePNG, { width: 48, height: 48 });
        const pngs: Array<PNG> = [];
        const promises: Array<Promise<void>> = [];
        for (let i = 0; i < 108; i++) {
            const p = fixturePath("novajs/novaparse/test/resource_parsers/files/rleds/testFrames/starbridge" + i + ".png");
            promises.push((async () => {
                pngs[i] = await getPNG(p);
            })());
        }
        await Promise.all(promises);
        for (let i = 0; i < 108; i++) {
            expect(pngs[i]).toEqualPNG(starbridgeFrames[i]);
        }
    });
});
