/**
 * Cloak-scanner semantics decoded from an oütf resource's ModType 30
 * ("cloak scanner") ModVal bitfield.
 *
 * From the EVN Bible (2006 revision, "oütf" ModType/ModVal table,
 * ModType 30):
 *
 *   0x0001  reveal cloaked ships on radar
 *   0x0002  reveal cloaked ships on the screen
 *   0x0004  allow targeting of untargetable ships
 *   0x0008  allow targeting of cloaked ships
 *
 * "Untargetable" (0x0004) refers to ships flagged untargetable by other
 * means (e.g. certain përs/ship flags); "cloaked" (0x0008) is
 * specifically ships hidden by a cloaking device. Only the cloak-related
 * bits (0x0008 for targeting, 0x0001/0x0002 for visibility) interact with
 * the cloaking-device system implemented here; 0x0004 is decoded for
 * completeness but there is no separate "untargetable" flag yet.
 */
export interface CloakScannerData {
    /** True if the outfit is a cloak scanner (ModType 30 present). */
    isCloakScanner: boolean;
    /** 0x0001 — reveal cloaked ships on the radar. */
    revealsOnRadar: boolean;
    /** 0x0002 — reveal cloaked ships on the screen (display fade-in). */
    revealsOnScreen: boolean;
    /** 0x0004 — allow targeting of otherwise-untargetable ships. */
    targetsUntargetable: boolean;
    /** 0x0008 — allow targeting of cloaked ships. */
    targetsCloaked: boolean;
    /** The raw ModVal, retained for debugging. */
    rawModVal: number;
}

export const CLOAK_SCANNER_RADAR = 0x0001;
export const CLOAK_SCANNER_SCREEN = 0x0002;
export const CLOAK_SCANNER_TARGET_UNTARGETABLE = 0x0004;
export const CLOAK_SCANNER_TARGET_CLOAKED = 0x0008;

/** Decodes a ModType-30 ModVal into a CloakScannerData. Pure and total. */
export function decodeCloakScannerModVal(modVal: number): CloakScannerData {
    return {
        isCloakScanner: true,
        revealsOnRadar: Boolean(modVal & CLOAK_SCANNER_RADAR),
        revealsOnScreen: Boolean(modVal & CLOAK_SCANNER_SCREEN),
        targetsUntargetable: Boolean(modVal & CLOAK_SCANNER_TARGET_UNTARGETABLE),
        targetsCloaked: Boolean(modVal & CLOAK_SCANNER_TARGET_CLOAKED),
        rawModVal: modVal,
    };
}

export function getDefaultCloakScannerData(): CloakScannerData {
    return {
        isCloakScanner: false,
        revealsOnRadar: false,
        revealsOnScreen: false,
        targetsUntargetable: false,
        targetsCloaked: false,
        rawModVal: 0,
    };
}
