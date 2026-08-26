import { OutfitData } from "novadatainterface/OutiftData";
import { PlanetData } from "novadatainterface/PlanetData";
import { ShipData } from "novadatainterface/ShipData";
import { evaluateTestExpression } from "../nova_plugin/ncb";
import { ncbTestContext } from "../nova_plugin/ncb_runtime";
import type { PlayerState } from "../nova_plugin/player_state";

type PurchaseData = Pick<ShipData | OutfitData, "techLevel" | "availabilityNCB">
    & { readonly displayWeight?: number };

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
        | Pick<PlayerState, 'missionBits' | 'gender' | 'exploredSystems'>
        | ReadonlySet<number>
        | readonly boolean[] = new Set(),
    outfits?: ReadonlyMap<string, unknown>,
): boolean {
    // Retail orders a shipyard by display weight and never stocks an entry
    // whose weight is zero. Those entries are the NPC-only variant hulls.
    if (item.displayWeight !== undefined && item.displayWeight <= 0) {
        return false;
    }
    if (!hasRequiredTechnology(item.techLevel, planet)) {
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
