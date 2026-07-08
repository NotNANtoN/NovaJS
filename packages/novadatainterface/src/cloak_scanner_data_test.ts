import "jasmine";
import { decodeCloakScannerModVal, getDefaultCloakScannerData } from "./cloak_scanner_data.js";

describe("decodeCloakScannerModVal", () => {
    it("marks any decoded value as a cloak scanner", () => {
        expect(decodeCloakScannerModVal(0).isCloakScanner).toBe(true);
    });

    it("decodes each reveal / targeting bit", () => {
        expect(decodeCloakScannerModVal(0x0001).revealsOnRadar).toBe(true);
        expect(decodeCloakScannerModVal(0x0002).revealsOnScreen).toBe(true);
        expect(decodeCloakScannerModVal(0x0004).targetsUntargetable).toBe(true);
        expect(decodeCloakScannerModVal(0x0008).targetsCloaked).toBe(true);
    });

    it("decodes a full scanner (0x000f)", () => {
        const s = decodeCloakScannerModVal(0x000f);
        expect(s.revealsOnRadar).toBe(true);
        expect(s.revealsOnScreen).toBe(true);
        expect(s.targetsUntargetable).toBe(true);
        expect(s.targetsCloaked).toBe(true);
    });

    it("leaves unset bits false", () => {
        const s = decodeCloakScannerModVal(0x0008); // targets cloaked only
        expect(s.targetsCloaked).toBe(true);
        expect(s.revealsOnRadar).toBe(false);
        expect(s.revealsOnScreen).toBe(false);
        expect(s.targetsUntargetable).toBe(false);
    });

    it("default scanner data is not a scanner", () => {
        expect(getDefaultCloakScannerData().isCloakScanner).toBe(false);
    });
});
