import { OutfitData } from "novadatainterface/OutfitData";
import { PlanetData } from "novadatainterface/PlanetData";
import { ShipData } from "novadatainterface/ShipData";
import { evaluateTestExpression } from "../nova_plugin/ncb";
import { ncbTestContext } from "../nova_plugin/ncb_runtime";
import type { PlayerState } from "../nova_plugin/player_state";
import { meetsRequire } from "../nova_plugin/contribute";

type PurchaseData = Pick<ShipData | OutfitData, "techLevel" | "availabilityNCB">
    & {
        readonly id?: string;
        readonly name?: string;
        readonly cost?: number;
        readonly price?: number;
        readonly displayWeight?: number;
        readonly buyRandom?: number;
        readonly flags3?: number;
        readonly require?: readonly number[];
        readonly weapons?: Readonly<Record<string, number>>;
        readonly cargoScoop?: boolean;
        readonly cloak?: boolean;
        readonly repairSystem?: boolean;
        readonly physics?: {
            readonly freeMass?: number;
            readonly freeCargo?: number;
            readonly shield?: number;
            readonly shieldRecharge?: number;
            readonly armor?: number;
            readonly armorRecharge?: number;
            readonly speed?: number;
            readonly acceleration?: number;
            readonly turnRate?: number;
            readonly energy?: number;
            readonly energyRecharge?: number;
        };
    };

export type OutfitCategory = 'all' | 'weapons' | 'defenses' | 'upgrades';

const WEAPON_OR_AMMO_OUTFIT_NUMS = new Set<number>([
    128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141,
    142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155,
    156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169,
    170, 171, 172, 173, 174, 175, 176, 215, 216, 217, 218, 219, 220, 254,
    255, 270, 276, 277, 278, 279, 280, 281, 282, 283, 284, 285, 298, 299,
    328, 329, 330, 345, 346, 435, 436, 438,
]);

const DEFENSE_OUTFIT_NUMS = new Set<number>([
    180, 181, 182, 183, 193, 194, 195, 196, 211, 234, 238, 239, 240, 241,
    242, 243, 244, 245, 246, 247, 248, 250, 262, 268, 269, 347, 437,
]);

export function classifyOutfitCategory(item: PurchaseData): Exclude<OutfitCategory, 'all'> {
    const id = item.id ?? '';
    if (id === 'conquest:shield_overcharger' || id === 'conquest:hull_nanites') {
        return 'defenses';
    }
    if (id.startsWith('conquest:')) {
        return 'upgrades';
    }
    if (item.weapons && Object.keys(item.weapons).length > 0) {
        return 'weapons';
    }
    const bareNum = Number(id.replace(/^.*:/, ''));
    if (Number.isFinite(bareNum)) {
        if (WEAPON_OR_AMMO_OUTFIT_NUMS.has(bareNum)) {
            return 'weapons';
        }
        if (DEFENSE_OUTFIT_NUMS.has(bareNum)) {
            return 'defenses';
        }
    }
    const phys = item.physics;
    if (item.cloak || item.repairSystem
        || (phys?.shield ?? 0) > 0 || (phys?.shieldRecharge ?? 0) > 0
        || (phys?.armor ?? 0) > 0 || (phys?.armorRecharge ?? 0) > 0) {
        return 'defenses';
    }
    return 'upgrades';
}

/**
 * Ships sold on Earth (Sol, `nova:128`) in Galactic Conquest mode:
 * Civilian starters + Federation Military + Vell-os psychic hulls.
 */
const CONQUEST_SOL_SHIPS = new Set<number>([
    // Civilian starters & haulers
    128, // Shuttle
    129, // Heavy Shuttle
    131, // Leviathan
    132, // Pegasus
    133, // Starbridge
    135, // Lightning
    136, // Terrapin
    137, // Valkyrie
    165, // Mod Starbridge
    167, // Viper
    // Federation Military
    140, // IDA Frigate
    141, // Fed Destroyer
    142, // Fed Patrol Boat
    143, // Fed Carrier
    144, // Fed Viper
    145, // Fed Anaconda
    172, // RAGE Gunboat
    187, // Fed Scout Ship
    // Vell-os
    173, // Vell-os Dart
    174, // Vell-os Arrow
    175, // Vell-os Javelin
]);

/**
 * Ships sold on Aurora (`nova:315` / Auroran spaceports) in Galactic Conquest:
 * Civilian starters + Auroran Empire hulls.
 */
const CONQUEST_AURORA_SHIPS = new Set<number>([
    // Civilian starters
    128, // Shuttle
    129, // Heavy Shuttle
    133, // Starbridge
    136, // Terrapin
    // Auroran Empire
    138, // Argosy
    139, // Enterprise
    152, // Abomination
    153, // Aurora Carrier
    154, // Aurora Cruiser
    155, // Firebird
    156, // Phoenix
    157, // Thunderhead
]);

/**
 * Shared civilian/mining outfits stocked at both Sol and Aurora in Conquest mode.
 */
const CONQUEST_SHARED_OUTFITS = new Set<number>([
    128, 129, 130, 131, 132, 133, // Light/Medium/Heavy/Quad Blasters & Turrets
    134, 135, 136, 137,           // IR & Radar Missile Launchers + Ammo
    177, 179, 228, 256,           // Fusion/Fission Reactors, Solar Panels, Battery Pack
    180, 182,                     // Carbon Fiber, Titanium Lattice
    184, 185, 186, 187, 188,      // Sensors, IFF, Auto-recharger, Escape Pod
    189, 190, 191, 192,           // Cargo/Mass Expansion & Retool
    193, 195,                     // Shield Recharger & Shield Buffer
    197, 199, 201, 202,           // Afterburner, Overdrive, Alluvial Dampener, Horizontal Booster
    203, 212, 227,                // Sensor Boost, Marine Platoon
    238, 239, 262,                // Civilian Jammers, Ion Dissipator
    270, 271,                     // Asteroid Mining Laser, Asteroid Scoop
    437,                          // Repair Droids
]);

const CONQUEST_SOL_EXCLUSIVE_OUTFITS = new Set<number>([
    142, 143, 144,                // Raven Rocket Pod, Rocket, Rocket Turret
    145, 146,                     // Stellar Grenade Launcher & Grenade
    157, 158, 159, 160,           // Viper Bay & Anaconda Bay
    165, 166,                     // Thunderhead Bay
    175, 176,                     // EMP Torpedo Tube & Torpedo
    235,                          // Matter/Antimatter Reactor
    240, 241,                     // Military IR & Radar Jammers
]);

const CONQUEST_AURORA_EXCLUSIVE_OUTFITS = new Set<number>([
    149, 150, 216,                // Fusion Pulse Cannon, Turret & Battery
    161, 162, 163, 164,           // Firebird Bay & Phoenix Bay
    169, 170, 215,                // Hail Chaingun, Ammo, Storm Chaingun
    171, 172, 173, 174,           // 100mm / 150mm / 200mm Railguns
    181,                          // Matrix Steel
    242, 243,                     // Auroran IR & Radar Jammers
]);

function isAuroraPlanet(planet: PlanetData): boolean {
    const bareId = Number((planet.id ?? '').replace(/^.*:/, ''));
    const name = (planet.name ?? '').toLowerCase();
    // In retail Nova_Data, Earth is spöb 128 (Sol); Aurora is in system 315.
    if (bareId === 128 || name === 'earth' || name.includes('luna')) {
        return false;
    }
    if (name.includes('aurora') || (planet.techLevel ?? 0) === 17
        || (planet.specialTech ?? []).includes(17)
        || (planet.specialTech ?? []).includes(10)
        || (planet.specialTech ?? []).includes(11)) {
        return true;
    }
    return bareId >= 300;
}

function hasInstalledOutfit(
    outfits: ReadonlyMap<string, unknown> | undefined,
    id: string,
): boolean {
    if (!outfits) return false;
    const entry = outfits.get(id);
    if (typeof entry === 'number') return entry > 0;
    if (entry && typeof entry === 'object' && 'count' in entry) {
        return Number((entry as { count: number }).count) > 0;
    }
    return false;
}

function hasVellosAttunement(
    shipBareNum: number,
    outfits: ReadonlyMap<string, unknown> | undefined,
): boolean {
    const hasT1 = hasInstalledOutfit(outfits, 'conquest:vellos_javelin_license');
    const hasT2 = hasInstalledOutfit(outfits, 'conquest:vellos_arrow_license');
    const hasT3 = hasInstalledOutfit(outfits, 'conquest:vellos_dart_license');
    if (shipBareNum === 175) {
        return hasT1;
    }
    if (shipBareNum === 174) {
        return hasT1 || hasT2;
    }
    if (shipBareNum === 173) {
        return hasT1 || hasT2 || hasT3;
    }
    return true;
}

function isConquestPurchaseAvailable(
    item: PurchaseData,
    planet: PlanetData,
    outfits?: ReadonlyMap<string, unknown>,
): boolean {
    const id = item.id ?? '';
    const onAurora = isAuroraPlanet(planet);
    if (id.startsWith('conquest:vellos_')) {
        return !onAurora;
    }
    if (id.startsWith('conquest:')) {
        return true;
    }
    if (id.startsWith('debug:')) {
        return false;
    }
    if (item.displayWeight !== undefined && item.displayWeight <= 0) {
        return false;
    }
    const isShip = 'cost' in item || item.buyRandom !== undefined;
    const bareNum = Number(id.replace(/^.*:/, ''));

    if (isShip) {
        if (!Number.isFinite(bareNum)) {
            return true;
        }
        if (bareNum === 173 || bareNum === 174 || bareNum === 175) {
            return !onAurora && hasVellosAttunement(bareNum, outfits);
        }
        return onAurora
            ? CONQUEST_AURORA_SHIPS.has(bareNum)
            : CONQUEST_SOL_SHIPS.has(bareNum);
    }

    const price = item.price ?? 0;
    if (price <= 0) {
        return false;
    }
    if (!Number.isFinite(bareNum)) {
        return item.techLevel >= 0 && item.techLevel <= 15;
    }
    if (CONQUEST_SHARED_OUTFITS.has(bareNum)) {
        return true;
    }
    return onAurora
        ? CONQUEST_AURORA_EXCLUSIVE_OUTFITS.has(bareNum)
        : CONQUEST_SOL_EXCLUSIVE_OUTFITS.has(bareNum);
}

/**
 * EV Nova Bible, oütf/shïp Require: every 1 bit of the item's Require must be
 * present in the player's Contribute. Without a Contribute (callers that do
 * not compute one) the check stays permissive.
 */
export function meetsPurchaseRequire(
    item: Pick<PurchaseData, "require">,
    contribute: readonly number[] | undefined,
): boolean {
    return contribute === undefined || meetsRequire(item.require, contribute);
}

export function hashSample(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % 100;
}

export interface AuthoritativePlanetMetadata {
    id: string;
    name?: string;
    flags?: number;
    techLevel?: number;
    specialTech?: number[];
    canLand?: boolean;
    inhabited?: boolean;
}

const SERVICE_MASKS = {
    commodity: 0x00000002,
    outfitter: 0x00000004,
    shipyard: 0x00000008,
    bar: 0x00000040,
} as const;

export function deriveSpaceportServices(flags: number) {
    return {
        hasCommodityExchange: (flags & SERVICE_MASKS.commodity) !== 0,
        hasOutfitter: (flags & SERVICE_MASKS.outfitter) !== 0,
        hasShipyard: (flags & SERVICE_MASKS.shipyard) !== 0,
        hasBar: (flags & SERVICE_MASKS.bar) !== 0,
    };
}

/**
 * Build one stable descriptor for a Spaceport. Replicated fields take
 * precedence, while artwork, descriptions, position, trade data, and legacy
 * id-only peers continue to use the local catalog.
 */
export function resolveSpaceportPlanetData(
    local: PlanetData,
    authoritative: AuthoritativePlanetMetadata,
): PlanetData {
    const flags = authoritative.flags ?? local.flags;
    const services = flags === undefined
        ? {
            hasCommodityExchange: local.hasCommodityExchange === true,
            hasOutfitter: local.hasOutfitter === true,
            hasShipyard: local.hasShipyard === true,
            hasBar: local.hasBar === true,
        }
        : deriveSpaceportServices(flags);
    return {
        ...local,
        name: authoritative.name ?? local.name,
        flags,
        techLevel: authoritative.techLevel ?? local.techLevel ?? -1,
        specialTech: [
            ...(authoritative.specialTech ?? local.specialTech ?? []),
        ],
        canLand: authoritative.canLand
            ?? (flags === undefined ? local.canLand : (flags & 0x1) !== 0),
        inhabited: authoritative.inhabited
            ?? (flags === undefined ? local.inhabited : (flags & 0x20) === 0),
        ...services,
        tradeCommodities: [...(local.tradeCommodities ?? [])],
    };
}

/**
 * EV Nova makes an item available at a spaceport when its tech level is no
 * higher than the port's base level, or when the port explicitly lists that
 * level as special technology.
 */
export function hasRequiredTechnology(
    itemTechLevel: number,
    planet: PlanetData,
): boolean {
    if (planet.techLevel === undefined) {
        return true;
    }
    return itemTechLevel <= planet.techLevel
        || (planet.specialTech ?? []).includes(itemTechLevel);
}

export function isPurchaseAvailable(
    item: PurchaseData,
    planet: PlanetData,
    playerStateOrMissionBits:
        | (Pick<PlayerState, 'missionBits' | 'gender' | 'exploredSystems'> &
            Partial<Pick<PlayerState, 'gameDate' | 'registered' | 'daysSinceRegistration' | 'gameMode'>>)
        | ReadonlySet<number>
        | readonly boolean[] = new Set(),
    outfits?: ReadonlyMap<string, unknown>,
    contribute?: readonly number[],
): boolean {
    const isConquest = Boolean(
        playerStateOrMissionBits
        && typeof playerStateOrMissionBits === 'object'
        && 'gameMode' in playerStateOrMissionBits
        && playerStateOrMissionBits.gameMode === 'conquest',
    );
    if (isConquest) {
        return isConquestPurchaseAvailable(item, planet, outfits);
    }
    if ((item.id ?? '').startsWith('conquest:')) {
        return false;
    }
    // Retail orders a shipyard by display weight and never stocks an entry
    // whose weight is zero. Those entries are the NPC-only variant hulls.
    if (item.displayWeight !== undefined && item.displayWeight <= 0) {
        return false;
    }
    // EV Nova Bible, shïp/BuyRandom: "The percent chance that a ship of this
    // type will be available for purchase on a given day. A BuyRandom of 0
    // means this ship will never be made available for purchase."
    if (item.buyRandom !== undefined && item.buyRandom <= 0) {
        return false;
    }
    if (!hasRequiredTechnology(item.techLevel, planet)) {
        return false;
    }
    if (!meetsPurchaseRequire(item, contribute)) {
        return false;
    }
    // Daily random stock roll: EV Nova Bible specifies BuyRandom is the
    // percent chance (1-100) that this hull is available on a given day.
    if (item.buyRandom !== undefined && item.buyRandom < 100) {
        const gameDate = (playerStateOrMissionBits && typeof playerStateOrMissionBits === 'object' && 'gameDate' in playerStateOrMissionBits)
            ? playerStateOrMissionBits.gameDate
            : undefined;
        if (gameDate !== undefined) {
            const planetId = planet.id ?? '';
            const itemId = item.id ?? '';
            const sample = hashSample(planetId + ":" + Math.floor(gameDate) + ":" + itemId);
            if (sample >= item.buyRandom) {
                return false;
            }
        }
    }
    if (!item.availabilityNCB) {
        return true;
    }
    try {
        const context = Array.isArray(playerStateOrMissionBits)
            || playerStateOrMissionBits instanceof Set
            ? { missionBits: playerStateOrMissionBits }
            : 'missionBits' in playerStateOrMissionBits
                ? ncbTestContext(playerStateOrMissionBits, outfits)
                : { missionBits: playerStateOrMissionBits };
        return evaluateTestExpression(item.availabilityNCB, context);
    } catch (error) {
        console.warn("Ignoring item with invalid Availability expression", error);
        return false;
    }
}

/**
 * Check whether an item or ship is permanently unlocked by tech and NCB,
 * ignoring daily random stock rolls.
 */
export function isPurchaseUnlocked(
    item: PurchaseData,
    planet: PlanetData,
    playerStateOrMissionBits:
        | (Pick<PlayerState, 'missionBits' | 'gender' | 'exploredSystems'> &
            Partial<Pick<PlayerState, 'gameDate' | 'registered' | 'daysSinceRegistration' | 'gameMode'>>)
        | ReadonlySet<number>
        | readonly boolean[] = new Set(),
    outfits?: ReadonlyMap<string, unknown>,
    contribute?: readonly number[],
): boolean {
    const isConquest = Boolean(
        playerStateOrMissionBits
        && typeof playerStateOrMissionBits === 'object'
        && 'gameMode' in playerStateOrMissionBits
        && playerStateOrMissionBits.gameMode === 'conquest',
    );
    if (isConquest) {
        return isConquestPurchaseAvailable(item, planet, outfits);
    }
    if ((item.id ?? '').startsWith('conquest:')) {
        return false;
    }
    if (item.displayWeight !== undefined && item.displayWeight <= 0) {
        return false;
    }
    if (item.buyRandom !== undefined && item.buyRandom <= 0) {
        return false;
    }
    if (!hasRequiredTechnology(item.techLevel, planet)) {
        return false;
    }
    if (!meetsPurchaseRequire(item, contribute)) {
        return false;
    }
    if (!item.availabilityNCB) {
        return true;
    }
    try {
        const context = Array.isArray(playerStateOrMissionBits)
            || playerStateOrMissionBits instanceof Set
            ? { missionBits: playerStateOrMissionBits }
            : 'missionBits' in playerStateOrMissionBits
                ? ncbTestContext(playerStateOrMissionBits, outfits)
                : { missionBits: playerStateOrMissionBits };
        return evaluateTestExpression(item.availabilityNCB, context);
    } catch (error) {
        console.warn("Ignoring item with invalid Availability expression", error);
        return false;
    }
}

export function hasSpaceportService(
    planet: PlanetData,
    service: "commodity" | "outfitter" | "shipyard" | "bar",
): boolean {
    const flags = planet.flags;
    if (flags !== undefined) {
        const mask = SERVICE_MASKS[service];
        return (flags & mask) !== 0;
    }
    return {
        commodity: planet.hasCommodityExchange,
        outfitter: planet.hasOutfitter,
        shipyard: planet.hasShipyard,
        bar: planet.hasBar,
    }[service] === true;
}
