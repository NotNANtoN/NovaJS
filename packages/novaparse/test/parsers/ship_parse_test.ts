import "jasmine";
import { interfaceGovtId } from "../../src/parsers/ship_parse.js";

/**
 * shïp InherentGovt, as the status bar reads it. The EVN Bible gives the
 * field four cases (shïp section):
 *
 *   -1          no inherent combat govt or attributes govt
 *   128-383     inherently of that govt for BOTH combat and attributes
 *   1128-1383   an attributes govt of (id - 1000), no combat govt
 *   2128-2383   a combat govt of (id - 2000), no attributes govt
 *
 * and the gövt Interface rule fires on EITHER association, so all three
 * populated ranges collapse to one government id for status-bar purposes.
 */
describe("interfaceGovtId", () => {
    it("passes through the both-associations range unchanged", () => {
        expect(interfaceGovtId(128)).toBe(128);
        expect(interfaceGovtId(147)).toBe(147);
        expect(interfaceGovtId(383)).toBe(383);
    });

    it("strips the 1000 offset of an attributes-only govt", () => {
        // The encoding most stock player-flyable ships use, e.g. the Fed
        // Viper's 1128 -> gövt 128 (Federation).
        expect(interfaceGovtId(1128)).toBe(128);
        expect(interfaceGovtId(1137)).toBe(137);
        expect(interfaceGovtId(1383)).toBe(383);
    });

    it("strips the 2000 offset of a combat-only govt", () => {
        expect(interfaceGovtId(2128)).toBe(128);
        expect(interfaceGovtId(2383)).toBe(383);
    });

    it("is null when the class has no inherent government", () => {
        expect(interfaceGovtId(-1)).toBeNull();
        expect(interfaceGovtId(0)).toBeNull();
        expect(interfaceGovtId(127)).toBeNull();
    });

    it("is null outside the documented ranges", () => {
        expect(interfaceGovtId(384)).toBeNull();
        expect(interfaceGovtId(1127)).toBeNull();
        expect(interfaceGovtId(3128)).toBeNull();
    });
});
