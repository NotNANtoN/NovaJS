import { WeaponDamage } from 'novadatainterface/WeaponData';

/**
 * Collision layer for EV Nova "planet-type" damage (wëap Flags2 0x0400:
 * "can only hit planet-type ships or destroyable stellars"). Normal weapons
 * never carry it and planets are vulnerable to nothing else, so the two
 * layers cannot hit each other.
 */
export const PLANET_BUSTER = 'planetBuster';

interface HitTypeWeapon {
    guidance: string;
    planetType?: boolean;
}

/** The single collision hit type a weapon's shots use. */
export function weaponHitType(weapon: HitTypeWeapon): string {
    if (weapon.planetType) {
        return PLANET_BUSTER;
    }
    if (weapon.guidance === 'pointDefense'
        || weapon.guidance === 'pointDefenseBeam') {
        return 'pointDefense';
    }
    return 'normal';
}

export function weaponHitTypes(weapon: HitTypeWeapon): Set<string> {
    return new Set([weaponHitType(weapon)]);
}

/**
 * shïp Flags2 0x0400: a planet-type ship "can only be hit by planet-type
 * weapons".
 */
export function shipHitLayer(ship: { planetTypeShip?: boolean } | undefined): string {
    return ship?.planetTypeShip ? PLANET_BUSTER : 'normal';
}

/** Destroyable stellars (Strength > 0) take planet-type hits only. */
export function planetVulnerableTo(
    planet: { strength?: number } | undefined,
): Set<string> | undefined {
    return (planet?.strength ?? 0) > 0 ? new Set([PLANET_BUSTER]) : undefined;
}

/**
 * spöb Strength counts "combined mass and energy damage". wëap MassDmg is
 * parsed as armor damage and EnergyDmg as shield damage.
 */
export function stellarDamageAmount(damage: WeaponDamage, scale = 1): number {
    const amount = (Math.max(0, damage.armor) + Math.max(0, damage.shield)) * scale;
    return Number.isFinite(amount) ? amount : 0;
}
