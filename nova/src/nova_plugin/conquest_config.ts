import type { SystemData } from 'novadatainterface/SystemData';
import type { PlayerState } from './player_state';

/** Sol (Earth, Federation) */
export const CONQUEST_SOL_SYSTEM = 'nova:130';
/** Aurora (Auroran Empire) */
export const CONQUEST_AURORA_SYSTEM = 'nova:315';
/** Earth spöb in Sol */
export const CONQUEST_SOL_PLANET = 'nova:128';

export const CONQUEST_POCKET_SYSTEMS = new Set<string>([
    CONQUEST_SOL_SYSTEM,
    CONQUEST_AURORA_SYSTEM,
]);

export const CONQUEST_SYSTEM_POSITIONS: Readonly<Record<string, [number, number]>> = {
    [CONQUEST_SOL_SYSTEM]: [-45, 0],
    [CONQUEST_AURORA_SYSTEM]: [45, 0],
};

export const FEDERATION_GOVT = 128;
export const AURORAN_GOVT = 129;

export const FEDERATION_UPGRADE_TIERS = [
    'nova:128', // Shuttle
    'nova:142', // Viper
    'nova:143', // Valkyrie
    'nova:130', // Starbridge
    'nova:141', // Fed Patrol Boat
] as const;

export const AURORAN_UPGRADE_TIERS = [
    'nova:152', // Firebird
    'nova:153', // Phoenix
    'nova:154', // Argosy
    'nova:156', // Abomination
] as const;

export const CONQUEST_BASE_MAGNET_RADIUS = 260;
export const CONQUEST_UPGRADED_MAGNET_RADIUS = 420;
export const CONQUEST_MAGNET_ACCEL = 260;
export const CONQUEST_MIN_ASTEROID_DENSITY = 8;
export const MAX_CONQUEST_BOTS_PER_SYSTEM = 4;
export const CONQUEST_BOT_SPAWN_INTERVAL_MS = 8_000;
export const CONQUEST_BOT_GATHER_CREDIT_RATE_PER_SEC = 900;
export const CONQUEST_BOT_UPGRADE_BASE_COST = 12_000;
export const CONQUEST_BOT_RAID_IDLE_MS = 28_000;

export function isConquestMode(
    state: Pick<PlayerState, 'gameMode'> | undefined,
): boolean {
    return state?.gameMode === 'conquest';
}

export function isConquestPocketSystem(systemId: string | undefined): boolean {
    return Boolean(systemId && CONQUEST_POCKET_SYSTEMS.has(systemId));
}

export function oppositeConquestSystem(
    systemId: string,
): string | undefined {
    if (systemId === CONQUEST_SOL_SYSTEM) {
        return CONQUEST_AURORA_SYSTEM;
    }
    if (systemId === CONQUEST_AURORA_SYSTEM) {
        return CONQUEST_SOL_SYSTEM;
    }
    return undefined;
}

/**
 * Normalizes a pilot's starting/current system when entering Galactic Conquest
 * mode so they always spawn inside the Two-System Pocket (Sol <-> Aurora).
 */
export function ensureConquestPocketState(state: PlayerState): void {
    if (!isConquestMode(state)) {
        return;
    }
    if (!isConquestPocketSystem(state.currentSystem)) {
        state.currentSystem = CONQUEST_SOL_SYSTEM;
        state.lastLandedSystem = CONQUEST_SOL_SYSTEM;
        state.lastLandedPlanet = CONQUEST_SOL_PLANET;
        state.lastLandedPosition = [0, 0];
    }
    for (const sysId of CONQUEST_POCKET_SYSTEMS) {
        if (!state.exploredSystems.includes(sysId)) {
            state.exploredSystems.push(sysId);
        }
    }
}

/**
 * Returns the 2-system pocket view of SystemData records when in Conquest mode:
 * Sol (`nova:130`) and Aurora (`nova:315`) placed 1 jump apart with a direct
 * bidirectional hyperlink.
 */
export function applyConquestPocketSystems(
    systems: readonly SystemData[],
    gameMode?: string,
): SystemData[] {
    if (gameMode !== 'conquest') {
        return [...systems];
    }
    const pocket = systems
        .filter(sys => CONQUEST_POCKET_SYSTEMS.has(sys.id))
        .map(sys => {
            const other = oppositeConquestSystem(sys.id);
            const position = CONQUEST_SYSTEM_POSITIONS[sys.id] ?? sys.position;
            return {
                ...sys,
                position: [position[0], position[1]] as [number, number],
                links: other ? [other] : [...sys.links],
                visBit: '',
            };
        });
    return pocket.length === 2 ? pocket : [...systems];
}

/**
 * Compute the direct credit payout when scooping floating asteroid/salvage ore
 * in Galactic Conquest mode.
 */
export function conquestOreCreditValue(
    commodity: string,
    tons: number,
    hasUpgradedScoop = false,
): number {
    const cleanTons = Math.max(1, Math.floor(tons));
    const lower = commodity.toLowerCase();
    let perTon = 1_800;
    if (lower.includes('salvage') || lower.includes('core')) {
        perTon = 4_500;
    } else if (
        lower.includes('crystal')
        || lower.includes('gold')
        || lower.includes('opals')
        || lower.includes('luxury')
        || lower.includes('medical')
    ) {
        perTon = 3_600;
    } else if (lower.includes('metal') || lower.includes('equipment')) {
        perTon = 2_400;
    }
    const multiplier = hasUpgradedScoop ? 1.5 : 1;
    return Math.round(cleanTons * perTon * multiplier);
}

/**
 * Ensure pocket systems in Conquest mode always have a rich asteroid belt even
 * if retail sÿst data had a low density.
 */
export function effectiveAsteroidDensity(
    systemId: string,
    retailDensity: number,
    hasConquestPlayers: boolean,
): number {
    if (hasConquestPlayers && isConquestPocketSystem(systemId)) {
        return Math.max(CONQUEST_MIN_ASTEROID_DENSITY, retailDensity);
    }
    return retailDensity;
}
