import "jasmine";
import { decodeCloakModVal, getDefaultCloakData } from "./cloak_data.js";

describe("decodeCloakModVal", () => {
    it("marks any decoded value as a cloak", () => {
        expect(decodeCloakModVal(0).isCloak).toBe(true);
    });

    it("hides from radar unless the visible-on-radar bit (0x0002) is set", () => {
        expect(decodeCloakModVal(0x0000).hidesFromRadar).toBe(true);
        expect(decodeCloakModVal(0x0002).hidesFromRadar).toBe(false);
        // Other bits set but not 0x0002 -> still hidden.
        expect(decodeCloakModVal(0x0009).hidesFromRadar).toBe(true);
    });

    it("decodes fuel drain as additive powers of two", () => {
        expect(decodeCloakModVal(0x0010).fuelPerSecond).toBe(1);
        expect(decodeCloakModVal(0x0020).fuelPerSecond).toBe(2);
        expect(decodeCloakModVal(0x0040).fuelPerSecond).toBe(4);
        expect(decodeCloakModVal(0x0080).fuelPerSecond).toBe(8);
        // 1 + 2 + 4 + 8 = 15
        expect(decodeCloakModVal(0x00f0).fuelPerSecond).toBe(15);
    });

    it("decodes shield drain as additive powers of two", () => {
        expect(decodeCloakModVal(0x0100).shieldPerSecond).toBe(1);
        expect(decodeCloakModVal(0x0200).shieldPerSecond).toBe(2);
        expect(decodeCloakModVal(0x0400).shieldPerSecond).toBe(4);
        expect(decodeCloakModVal(0x0800).shieldPerSecond).toBe(8);
        // 4 + 8 = 12
        expect(decodeCloakModVal(0x0c00).shieldPerSecond).toBe(12);
    });

    it("decodes the boolean quality bits", () => {
        expect(decodeCloakModVal(0x0001).fasterFading).toBe(true);
        expect(decodeCloakModVal(0x0004).dropsShieldsOnActivate).toBe(true);
        expect(decodeCloakModVal(0x0008).deactivatesWhenHit).toBe(true);
        expect(decodeCloakModVal(0x1000).areaCloak).toBe(true);
        const none = decodeCloakModVal(0);
        expect(none.fasterFading).toBe(false);
        expect(none.dropsShieldsOnActivate).toBe(false);
        expect(none.deactivatesWhenHit).toBe(false);
        expect(none.areaCloak).toBe(false);
    });

    // Real Nova data values (from Nova_Data scan).
    it("decodes the Fed Cloaking Device (0x000e)", () => {
        const c = decodeCloakModVal(0x000e);
        // 0x8 deactivates when hit, 0x4 drops shields, 0x2 visible on radar
        expect(c.deactivatesWhenHit).toBe(true);
        expect(c.dropsShieldsOnActivate).toBe(true);
        expect(c.hidesFromRadar).toBe(false);
        expect(c.shieldPerSecond).toBe(0);
        expect(c.fuelPerSecond).toBe(0);
    });

    it("decodes the Polaris Cloaking Organ v1.1 (0x0409)", () => {
        const c = decodeCloakModVal(0x0409);
        // 0x400 use 4 shield/sec, 0x8 deactivates when hit, 0x1 faster fading
        expect(c.shieldPerSecond).toBe(4);
        expect(c.deactivatesWhenHit).toBe(true);
        expect(c.fasterFading).toBe(true);
        expect(c.hidesFromRadar).toBe(true); // 0x2 not set
        expect(c.dropsShieldsOnActivate).toBe(false);
    });

    it("retains the raw ModVal", () => {
        expect(decodeCloakModVal(0x0409).rawModVal).toBe(0x0409);
    });

    it("default cloak data is not a cloak", () => {
        expect(getDefaultCloakData().isCloak).toBe(false);
    });
});
