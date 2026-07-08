/**
 * Cloaking-device semantics decoded from an oütf resource's ModType 17
 * ("cloaking device") ModVal bitfield.
 *
 * The ModVal is a bitfield of cloak qualities. From the EVN Bible (2006
 * revision, "oütf" ModType/ModVal table, ModType 17):
 *
 *   0x0001  Faster fading                (display: quicker fade in/out)
 *   0x0002  Visible on radar             (do NOT hide the ship from radar)
 *   0x0004  Immediately drops shields on activation
 *   0x0008  Cloak deactivates when ship takes damage
 *   0x0010  Use 1 unit of fuel per second
 *   0x0020  Use 2 units of fuel per second
 *   0x0040  Use 4 units of fuel per second
 *   0x0080  Use 8 units of fuel per second
 *   0x0100  Use 1 unit of shield per second
 *   0x0200  Use 2 units of shield per second
 *   0x0400  Use 4 units of shield per second
 *   0x0800  Use 8 units of shield per second
 *   0x1000  Area cloak - ships in formation with a ship carrying this
 *           cloaking device will also be cloaked
 *
 * The fuel/shield drain bits are additive powers of two, so a device can
 * combine them (e.g. 0x0300 = 1 + 2 = 3 shield/sec). ModVal 0 with a
 * ModType-17 outfit is still a working cloak: it hides from radar (bit
 * 0x0002 clear), never drains, and never auto-decloaks.
 *
 * Notes on related resources (not part of THIS bitfield, referenced for
 * completeness):
 *   - Whether a ship can FIRE while cloaked is a per-weapon wëap flag
 *     (0x4000 "Weapon can be fired while cloaked"), not a cloak bit.
 *   - Whether NPCs can SEE/target a cloaked ship is governed by the
 *     "cloak scanner" outfit (ModType 30). By default a cloaked ship is
 *     untargetable and invisible to others; a cloak scanner reveals it.
 *   - When AI ships cloak (running away, hyperspacing, etc.) is a dude/
 *     ship AI-flags concern (flags2 0x0100-0x4000), not a cloak bit.
 *
 * Bit semantics captured here are display/sim rules, decoded once at
 * parse time so the simulation and display layers never re-derive them
 * from a raw number.
 */
export interface CloakData {
    /** True if the outfit is a cloaking device (ModType 17 present). */
    isCloak: boolean;
    /** 0x0001 — display fades faster. */
    fasterFading: boolean;
    /**
     * True when the ship should be HIDDEN from radar while cloaked.
     * This is the INVERSE of the raw 0x0002 "Visible on radar" bit: if
     * 0x0002 is set the ship shows on radar, so hidesFromRadar is false.
     */
    hidesFromRadar: boolean;
    /** 0x0004 — activation immediately zeroes shields. */
    dropsShieldsOnActivate: boolean;
    /** 0x0008 — taking damage forces a decloak. */
    deactivatesWhenHit: boolean;
    /** Fuel drained per second while cloaked (0, 1, 2, 4, 8, or a sum). */
    fuelPerSecond: number;
    /** Shield drained per second while cloaked (0, 1, 2, 4, 8, or a sum). */
    shieldPerSecond: number;
    /** 0x1000 — cloaks formation-mates too (area cloak). NOT YET simulated. */
    areaCloak: boolean;
    /** The raw ModVal, retained for debugging / round-tripping. */
    rawModVal: number;
}

// ModVal bit masks (see the doc comment above).
export const CLOAK_FASTER_FADING = 0x0001;
export const CLOAK_VISIBLE_ON_RADAR = 0x0002;
export const CLOAK_DROPS_SHIELDS = 0x0004;
export const CLOAK_DEACTIVATES_WHEN_HIT = 0x0008;
export const CLOAK_FUEL_1 = 0x0010;
export const CLOAK_FUEL_2 = 0x0020;
export const CLOAK_FUEL_4 = 0x0040;
export const CLOAK_FUEL_8 = 0x0080;
export const CLOAK_SHIELD_1 = 0x0100;
export const CLOAK_SHIELD_2 = 0x0200;
export const CLOAK_SHIELD_4 = 0x0400;
export const CLOAK_SHIELD_8 = 0x0800;
export const CLOAK_AREA = 0x1000;

/**
 * Decodes a ModType-17 ModVal bitfield into a CloakData record. Pure and
 * total: any 16-bit value yields a valid record.
 */
export function decodeCloakModVal(modVal: number): CloakData {
    const fuelPerSecond =
        (modVal & CLOAK_FUEL_1 ? 1 : 0) +
        (modVal & CLOAK_FUEL_2 ? 2 : 0) +
        (modVal & CLOAK_FUEL_4 ? 4 : 0) +
        (modVal & CLOAK_FUEL_8 ? 8 : 0);
    const shieldPerSecond =
        (modVal & CLOAK_SHIELD_1 ? 1 : 0) +
        (modVal & CLOAK_SHIELD_2 ? 2 : 0) +
        (modVal & CLOAK_SHIELD_4 ? 4 : 0) +
        (modVal & CLOAK_SHIELD_8 ? 8 : 0);

    return {
        isCloak: true,
        fasterFading: Boolean(modVal & CLOAK_FASTER_FADING),
        // Inverse of the "visible on radar" bit: hide unless 0x0002 is set.
        hidesFromRadar: !(modVal & CLOAK_VISIBLE_ON_RADAR),
        dropsShieldsOnActivate: Boolean(modVal & CLOAK_DROPS_SHIELDS),
        deactivatesWhenHit: Boolean(modVal & CLOAK_DEACTIVATES_WHEN_HIT),
        fuelPerSecond,
        shieldPerSecond,
        areaCloak: Boolean(modVal & CLOAK_AREA),
        rawModVal: modVal,
    };
}

export function getDefaultCloakData(): CloakData {
    return {
        isCloak: false,
        fasterFading: false,
        hidesFromRadar: false,
        dropsShieldsOnActivate: false,
        deactivatesWhenHit: false,
        fuelPerSecond: 0,
        shieldPerSecond: 0,
        areaCloak: false,
        rawModVal: 0,
    };
}
