import { OutfitData } from "novadatainterface/OutiftData";
import { PlanetData } from "novadatainterface/PlanetData";
import { ShipData } from "novadatainterface/ShipData";
import { evaluateTestExpression } from "../nova_plugin/ncb";
import { ncbTestContext } from "../nova_plugin/ncb_runtime";
import type { PlayerState } from "../nova_plugin/player_state";

type PurchaseData = Pick<ShipData | OutfitData, "techLevel" | "availabilityNCB">;

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
        const mask = {
            commodity: 0x00000002,
            outfitter: 0x00000004,
            shipyard: 0x00000008,
            bar: 0x00000040,
        }[service];
        return (flags & mask) !== 0;
    }
    return {
        commodity: planet.hasCommodityExchange,
        outfitter: planet.hasOutfitter,
        shipyard: planet.hasShipyard,
        bar: planet.hasBar,
    }[service] !== false;
}
