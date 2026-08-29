import { OutfitData } from 'novadatainterface/OutiftData';
import { ShipData, getDefaultShipData } from 'novadatainterface/ShipData';
import { WeaponData } from 'novadatainterface/WeaponData';
import {
    ShipTurnRateConversionFactor,
    ShipVelocityConversionFactor,
} from 'novaparse/src/parsers/Constants';
import { displayName } from 'novaparse/src/parsers/displayName';

export const SHIPYARD_INFO_PICT_MAX = { width: 580, height: 280 } as const;

export function qualitativeRating(raw: number): string {
    if (raw < 150) {
        return 'Feeble';
    }
    if (raw < 250) {
        return 'Poor';
    }
    if (raw < 350) {
        return 'Average';
    }
    if (raw < 450) {
        return 'Good';
    }
    if (raw < 550) {
        return 'Very Good';
    }
    return 'Excellent';
}

export function shipyardInfoTitle(ship: ShipData): string {
    const long = ship.longName?.trim();
    if (long) {
        return displayName(long);
    }
    return ship.name;
}

export function shipyardInfoPictId(ship: ShipData): string {
    return ship.infoPict ?? ship.pict;
}

export function formatMaxSlots(max: number): string {
    return max === 0 ? 'None' : `Maximum of ${max}`;
}

export interface OutfitLookup {
    get(id: string): Promise<OutfitData>;
}

export interface WeaponLookup {
    get(id: string): Promise<WeaponData>;
}

export function shipyardInfoLeftColumn(ship: ShipData): string {
    const rawSpeed = Math.round(ship.physics.speed / ShipVelocityConversionFactor);
    const rawAccel = ship.physics.acceleration / ShipVelocityConversionFactor;
    const rawTurn = ship.physics.turnRate / ShipTurnRateConversionFactor;
    return [
        `Speed: ${rawSpeed}`,
        `Accel: ${qualitativeRating(rawAccel)}`,
        `Turn: ${qualitativeRating(rawTurn)}`,
        `Shields: ${ship.physics.shield}`,
        `Armor: ${ship.physics.armor}`,
        `Guns: ${formatMaxSlots(ship.maxGuns)}`,
        `Turrets: ${formatMaxSlots(ship.maxTurrets)}`,
    ].join('\n');
}

export function shipyardInfoMiddleColumn(ship: ShipData): string {
    return [
        `Space: ${ship.freeSpace} tons`,
        `Cargo: ${ship.physics.freeCargo} tons`,
        `Energy: ${Math.floor(ship.fuelCapacity / 100)} jumps`,
        `Length: ${ship.length} metres`,
        `Mass: ${ship.physics.mass} tons`,
        `Crew: ${ship.crew}`,
    ].join('\n');
}

export async function standardWeaponsLines(
    outfits: Readonly<Record<string, number>>,
    outfitLookup: OutfitLookup,
    weaponLookup: WeaponLookup,
): Promise<string[]> {
    const lines: string[] = [];
    const sortedIds = Object.keys(outfits ?? {}).sort();
    for (const id of sortedIds) {
        const count = outfits[id];
        try {
            const outfit = await outfitLookup.get(id);
            if (!outfit) {
                continue;
            }
            const weapons = outfit.weapons ?? {};
            if (Object.keys(weapons).length > 0) {
                for (const [weaponId, weaponCount] of Object.entries(weapons)) {
                    try {
                        const weapon = await weaponLookup.get(weaponId);
                        const total = count * weaponCount;
                        lines.push(total > 1 ? `${total}x ${weapon?.name ?? 'Weapon'}` : (weapon?.name ?? 'Weapon'));
                    } catch {
                        lines.push(count > 1 ? `${count}x ${outfit.name}` : outfit.name);
                    }
                }
            } else if (outfit.name) {
                lines.push(count > 1 ? `${count}x ${outfit.name}` : outfit.name);
            }
        } catch {
            // Ignore missing outfit
        }
    }
    return lines;
}

export async function shipyardInfoWeaponsColumn(
    ship: ShipData,
    outfitLookup: OutfitLookup,
    weaponLookup: WeaponLookup,
): Promise<string> {
    const lines = await standardWeaponsLines(
        ship.outfits, outfitLookup, weaponLookup);
    if (lines.length === 0) {
        return 'Standard Weapons\n\nNone';
    }
    return ['Standard Weapons', '', ...lines].join('\n');
}

/** Scale down large art to fit; never upscale smaller art. */
export function pictDisplayScale(
    width: number,
    height: number,
    maxWidth = SHIPYARD_INFO_PICT_MAX.width,
    maxHeight = SHIPYARD_INFO_PICT_MAX.height,
): number {
    if (width <= 0 || height <= 0) {
        return 1;
    }
    return Math.min(maxWidth / width, maxHeight / height, 1);
}

export function sampleShipForInfoTests(
    overrides: Partial<ShipData> = {},
): ShipData {
    return {
        ...getDefaultShipData(),
        id: 'nova:128',
        name: 'Shuttle',
        longName: 'Shuttle;economy at work',
        infoPict: 'nova:9001',
        pict: 'nova:5000',
        length: 12,
        crew: 2,
        freeSpace: 40,
        maxGuns: 2,
        maxTurrets: 0,
        fuelCapacity: 500,
        physics: {
            ...getDefaultShipData().physics,
            speed: 90,
            acceleration: 60,
            turnRate: ShipTurnRateConversionFactor * 200,
            shield: 100,
            armor: 50,
            freeCargo: 20,
            mass: 15,
        },
        ...overrides,
    };
}
