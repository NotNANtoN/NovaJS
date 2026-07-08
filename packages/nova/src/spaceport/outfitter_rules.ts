/**
 * The rules for buying and selling outfits in the outfitter, per the
 * EVN Bible's oütf documentation: free mass, gun/turret hardpoints,
 * the Max count (as multiplied by increase-maximum items), the
 * Availability control bit test, Contribute/Require flag coverage,
 * and launcher-restricted ammunition.
 *
 * Pure logic; the Outfitter menu supplies the context. Note that Gxxx
 * control-bit grants intentionally bypass all of these checks (see
 * makeControlBitHooks in ../nova_plugin/ncb.ts).
 */
import { OutfitData } from 'novadatainterface/outfit_data';
import { ShipData } from 'novadatainterface/ship_data';
import { WeaponData } from 'novadatainterface/weapon_data';
import { evaluateNCBTest, NCBParseError } from '../nova_plugin/ncb.js';

export interface OutfitterContext {
    shipData: ShipData;
    /** The player's current outfits: global outfit id -> count. */
    outfits: ReadonlyMap<string, number>;
    /** Already-loaded game data. Unloaded ids may return undefined. */
    getOutfit(id: string): OutfitData | undefined;
    getWeapon(id: string): WeaponData | undefined;
    /** The player's control bits. */
    bits: ReadonlySet<number>;
    /** Maps resource ids in NCB expressions (e.g. O142) to global ids. */
    resolveId?(id: number): string;
}

export type BuyDenialReason =
    | 'availability'
    | 'require'
    | 'maxCount'
    | 'needsLauncher'
    | 'gunHardpoints'
    | 'turretHardpoints'
    | 'mass'
    | 'cargo';

export type SellDenialReason = 'notOwned' | 'cantSell';

export type OutfitterCheck<Reason> =
    | { allowed: true }
    | { allowed: false, reason: Reason, message: string };

function denied<Reason>(reason: Reason, message: string):
    OutfitterCheck<Reason> {
    return { allowed: false, reason, message };
}

function* ownedOutfits(context: OutfitterContext):
    Iterable<[OutfitData, number]> {
    for (const [id, count] of context.outfits) {
        const outfit = context.getOutfit(id);
        if (outfit && count > 0) {
            yield [outfit, count];
        }
    }
}

/** The ship's remaining outfit space in tons. */
export function freeMass(context: OutfitterContext): number {
    let free = context.shipData.physics.freeMass;
    for (const [outfit, count] of ownedOutfits(context)) {
        free -= outfit.physics.freeMass * count;
    }
    return free;
}

/**
 * The ship's cargo capacity after outfit modifications. Carried cargo
 * is not modeled yet (there's no trading), so this only keeps
 * cargo-consuming outfits from driving the capacity negative.
 */
export function freeCargo(context: OutfitterContext): number {
    let free = context.shipData.physics.freeCargo;
    for (const [outfit, count] of ownedOutfits(context)) {
        free += (outfit.physics.freeCargo ?? 0) * count;
    }
    return free;
}

function hardpoints(context: OutfitterContext,
    kind: 'gun' | 'turret'): { max: number, used: number } {
    const physicsKey = kind === 'gun' ? 'maxGuns' : 'maxTurrets';
    const outfitKey = kind === 'gun' ? 'fixedGun' : 'turret';
    let max = context.shipData.physics[physicsKey];
    let used = 0;
    for (const [outfit, count] of ownedOutfits(context)) {
        max += (outfit.physics[physicsKey] ?? 0) * count;
        if (outfit[outfitKey]) {
            used += count;
        }
    }
    return { max, used };
}

/**
 * The union of the Contribute flag sets of the player's ship and all
 * owned outfits.
 */
export function playerContribute(context: OutfitterContext): bigint {
    let contribute = BigInt(context.shipData.contribute ?? '0x0');
    for (const [outfit, count] of ownedOutfits(context)) {
        if (count > 0) {
            contribute |= BigInt(outfit.contribute ?? '0x0');
        }
    }
    return contribute;
}

/**
 * The most of this outfit the player may own: the Max field times the
 * number of owned increase-maximum items that point at it. Max <= 0
 * means unlimited.
 */
export function effectiveMax(outfit: OutfitData,
    context: OutfitterContext): number {
    if (outfit.max <= 0) {
        return Infinity;
    }
    let multiplier = 0;
    for (const [owned, count] of ownedOutfits(context)) {
        if (owned.increasesMax === outfit.id) {
            multiplier += count;
        }
    }
    return outfit.max * Math.max(1, multiplier);
}

/**
 * The maximum units of ammunition the player's launchers support, or
 * undefined if this outfit is not launcher-restricted. Per the EVN
 * Bible's MaxAmmo docs, ammo whose weapon has MaxAmmo <= 0 is
 * constrained by the outfit's Max field alone (freely buyable); ammo
 * whose weapon has MaxAmmo > 0 is capped at MaxAmmo per owned
 * launcher instance, so with no launcher none can be bought.
 */
export function ammoCapacity(outfit: OutfitData,
    context: OutfitterContext): number | undefined {
    if (!outfit.ammoFor) {
        return undefined;
    }
    const suppliedWeapon = context.getWeapon(outfit.ammoFor);
    if (!suppliedWeapon || suppliedWeapon.maxAmmo <= 0) {
        return undefined;
    }
    let capacity = 0;
    for (const [owned, outfitCount] of ownedOutfits(context)) {
        for (const [weaponId, weaponCount] of Object.entries(owned.weapons)) {
            const launcher = context.getWeapon(weaponId);
            if (!launcher || launcher.ammoType === 'unlimited'
                || launcher.ammoType[0] !== 'weapon'
                || launcher.ammoType[1] !== outfit.ammoFor) {
                continue;
            }
            if (launcher.maxAmmo <= 0) {
                // This launcher defers to the outfit's Max field.
                return undefined;
            }
            capacity += launcher.maxAmmo * weaponCount * outfitCount;
        }
    }
    return capacity;
}

/** The total owned ammo units drawing from the same weapon's supply. */
function ownedAmmoCount(ammoFor: string, context: OutfitterContext): number {
    let owned = 0;
    for (const [outfit, count] of ownedOutfits(context)) {
        if (outfit.ammoFor === ammoFor) {
            owned += count;
        }
    }
    return owned;
}

/**
 * Whether the outfit's Availability control bit test passes.
 * Malformed expressions log and count as available, matching the
 * blank-expression default.
 */
export function availabilityTest(outfit: OutfitData,
    context: OutfitterContext): boolean {
    const resolveId = context.resolveId ?? (id => `nova:${id}`);
    try {
        return evaluateNCBTest(outfit.availability ?? '', {
            getBit: bit => context.bits.has(bit),
            hasOutfit: id => (context.outfits.get(resolveId(id)) ?? 0) > 0,
        });
    } catch (error) {
        if (error instanceof NCBParseError) {
            console.warn(`Bad Availability for outfit ${outfit.id}:`, error);
            return true;
        }
        throw error;
    }
}

/** Checks every purchase requirement for buying one of this outfit. */
export function canBuyOutfit(outfit: OutfitData,
    context: OutfitterContext): OutfitterCheck<BuyDenialReason> {
    if (!availabilityTest(outfit, context)) {
        return denied('availability', 'Not available.');
    }

    const require = BigInt(outfit.require ?? '0x0');
    if ((require & playerContribute(context)) !== require) {
        return denied('require', 'You lack something this requires.');
    }

    const owned = context.outfits.get(outfit.id) ?? 0;
    if (owned >= effectiveMax(outfit, context)) {
        return denied('maxCount', 'You can\'t carry any more of these.');
    }

    if (outfit.ammoFor) {
        const capacity = ammoCapacity(outfit, context);
        if (capacity !== undefined
            && ownedAmmoCount(outfit.ammoFor, context) >= capacity) {
            return denied('needsLauncher', capacity === 0
                ? 'You need a launcher for this ammunition.'
                : 'Your launchers can\'t hold any more ammunition.');
        }
    }

    if (outfit.fixedGun) {
        const { max, used } = hardpoints(context, 'gun');
        if (used >= max) {
            return denied('gunHardpoints', 'You have no free gun hardpoint.');
        }
    }
    if (outfit.turret) {
        const { max, used } = hardpoints(context, 'turret');
        if (used >= max) {
            return denied('turretHardpoints',
                'You have no free turret hardpoint.');
        }
    }

    if (outfit.physics.freeMass > freeMass(context)) {
        return denied('mass', 'You don\'t have enough free mass.');
    }

    const cargoUse = outfit.physics.freeCargo ?? 0;
    if (cargoUse < 0 && freeCargo(context) + cargoUse < 0) {
        return denied('cargo', 'You don\'t have enough cargo space.');
    }

    return { allowed: true };
}

/** Checks whether the player may sell one of this outfit. */
export function canSellOutfit(outfit: OutfitData,
    context: OutfitterContext): OutfitterCheck<SellDenialReason> {
    if ((context.outfits.get(outfit.id) ?? 0) <= 0) {
        return denied('notOwned', 'You don\'t have any of these.');
    }
    if (outfit.cantSell) {
        return denied('cantSell', 'This can\'t be sold.');
    }
    return { allowed: true };
}
