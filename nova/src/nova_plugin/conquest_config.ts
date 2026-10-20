import * as t from 'io-ts';
import { Component } from 'nova_ecs/component';
import { excludeFromStateHash, replicationPolicies } from 'nova_ecs/plugins/multiplayer_plugin';
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
    'nova:187', // Fed Scout Ship
    'nova:144', // Fed Viper
    'nova:135', // Lightning
    'nova:145', // Fed Anaconda
    'nova:137', // Valkyrie
    'nova:142', // Fed Patrol Boat
    'nova:172', // RAGE Gunboat
    'nova:140', // IDA Frigate
    'nova:141', // Fed Destroyer
    'nova:143', // Fed Carrier
] as const;

export const AURORAN_UPGRADE_TIERS = [
    'nova:155', // Firebird
    'nova:156', // Phoenix
    'nova:138', // Argosy
    'nova:152', // Abomination
    'nova:154', // Aurora Cruiser
    'nova:153', // Aurora Carrier
] as const;

/**
 * Permanent Homeworld Defense Garrison tier indices for Sol (Federation):
 * - Tier 9: Fed Carrier (`nova:143`)
 * - Tier 8: Fed Destroyer (`nova:141`)
 * - Tier 6: RAGE Gunboat (`nova:172`)
 * - Tier 5: Fed Patrol Boat (`nova:142`)
 */
export const FEDERATION_GARRISON_TIERS = [9, 8, 6, 5] as const;

/**
 * Permanent Homeworld Defense Garrison tier indices for Aurora (Auroran Empire):
 * - Tier 5: Aurora Carrier (`nova:153`)
 * - Tier 4: Aurora Cruiser (`nova:154`)
 * - Tier 3: Abomination (`nova:152`)
 * - Tier 2: Argosy (`nova:138`)
 */
export const AURORAN_GARRISON_TIERS = [5, 4, 3, 2] as const;

export const FEDERATION_PILOT_NAMES = [
    'Capt. Vance',
    'Cmdr. Sterling',
    'Lt. Mercer',
    'Maj. Thorne',
    'Capt. Rostova',
    'Lt. Kaelen Vos',
    'Cmdr. Hale',
    'Capt. Aria Chen',
    'Maj. Dorian Webb',
    'Lt. Tessa Lin',
    'Cmdr. Cross',
    'Capt. Reyes',
    'Lt. Lindqvist',
    'Maj. Moreau',
    'Capt. Hawkes',
    'Lt. Callen',
] as const;

export const AURORAN_PILOT_NAMES = [
    "Kar'Vosh",
    "Thran'ek",
    "Drek'Nar",
    "Vael'Kor",
    "Zor'Kahn",
    "Mal'Drak",
    "Krel'Vane",
    "Syra'Keth",
    "Tor'Gath",
    "Rul'Vek",
    "Nyx'Talon",
    "Brenn'Dar",
    "Kaz'Vor",
    "Vorn'ash",
    "Jor'Tek",
    "Drak'thul",
] as const;

let fallbackCallsignCounter = 1;

export function pickUniqueConquestCallsign(
    govt: number,
    usedCallsigns: ReadonlySet<string>,
): string {
    const pool = govt === AURORAN_GOVT
        ? AURORAN_PILOT_NAMES
        : FEDERATION_PILOT_NAMES;
    const available = pool.filter(name => !usedCallsigns.has(name));
    if (available.length > 0) {
        return available[Math.floor(Math.random() * available.length)];
    }
    const base = pool[Math.floor(Math.random() * pool.length)];
    return `${base} ${++fallbackCallsignCounter}`;
}

export const ConquestBotStateCodec = t.intersection([
    t.type({
        callsign: t.string,
        mode: t.union([
            t.literal('gather'),
            t.literal('attack'),
            t.literal('raid'),
        ]),
        factionGovt: t.number,
        homeSystem: t.string,
        tier: t.number,
        gatheredCredits: t.number,
        lastModeSwitchAt: t.number,
        upgradePending: t.boolean,
    }),
    t.partial({
        squadId: t.string,
        squadLeaderUuid: t.string,
        garrison: t.boolean,
    }),
]);

export type ConquestBotState = t.TypeOf<typeof ConquestBotStateCodec>;

export const ConquestBotComponent =
    new Component<ConquestBotState>('ConquestBotComponent');

replicationPolicies.register(ConquestBotComponent, {
    codec: ConquestBotStateCodec,
    authority: 'server',
});
excludeFromStateHash(ConquestBotComponent.name);

export interface ConquestBotTransfer {
    from: string;
    to: string;
    departurePosition: [number, number];
    botState: ConquestBotState;
}

const pendingTransfersBySystem = new Map<string, ConquestBotTransfer[]>();

export function enqueueConquestBotTransfer(transfer: ConquestBotTransfer): void {
    let queue = pendingTransfersBySystem.get(transfer.to);
    if (!queue) {
        queue = [];
        pendingTransfersBySystem.set(transfer.to, queue);
    }
    if (queue.length < 16) {
        queue.push({
            ...transfer,
            departurePosition: [
                transfer.departurePosition[0],
                transfer.departurePosition[1],
            ],
            botState: { ...transfer.botState },
        });
    }
}

export function drainConquestBotTransfers(systemId: string): ConquestBotTransfer[] {
    const queue = pendingTransfersBySystem.get(systemId);
    if (!queue || queue.length === 0) {
        return [];
    }
    pendingTransfersBySystem.delete(systemId);
    return queue;
}

export function clearConquestBotTransfers(): void {
    pendingTransfersBySystem.clear();
}

/**
 * Default collector pull radius in Conquest mode: small enough that shattered
 * asteroid packages scatter outward and the player flies into them to scoop,
 * while buying the Magnetic Ore Attractor (`conquest:mining_tractor`) or
 * Asteroid Scoop expands the tractor field to 380 units.
 */
export const CONQUEST_BASE_MAGNET_RADIUS = 95;
export const CONQUEST_UPGRADED_MAGNET_RADIUS = 380;
export const CONQUEST_MAGNET_ACCEL = 220;
export const CONQUEST_ORE_SCATTER_DELAY_MS = 650;
export const CONQUEST_MIN_ASTEROID_DENSITY = 15;
export const CONQUEST_ASTEROID_RESPAWN_MS = 2_500;
export const MAX_CONQUEST_BOTS_PER_SYSTEM = 9;
export const CONQUEST_BOT_SPAWN_INTERVAL_MS = 3_500;
export const CONQUEST_BOT_GATHER_CREDIT_RATE_PER_SEC = 1_100;
export const CONQUEST_BOT_UPGRADE_BASE_COST = 10_000;
export const CONQUEST_BOT_RAID_IDLE_MS = 4_000;

const AURORAN_HULL_SET = new Set<string>([
    ...AURORAN_UPGRADE_TIERS,
    'nova:139', // Enterprise
    'nova:157', // Thunderhead
]);

/**
 * Determines which faction a player belongs to in Galactic Conquest:
 * - Players who fly Auroran hulls or last landed on Aurora belong to AURORAN_GOVT (129).
 * - Players who spawned/landed on Sol (Earth) or fly Federation/Vell-os hulls belong to FEDERATION_GOVT (128).
 */
export function playerConquestFaction(
    state: Pick<PlayerState, 'lastLandedSystem' | 'lastLandedPlanet' | 'shipId'> | undefined,
    shipId?: string,
): number {
    const hull = shipId ?? state?.shipId ?? '';
    if (AURORAN_HULL_SET.has(hull)) {
        return AURORAN_GOVT;
    }
    if (state?.lastLandedSystem === CONQUEST_AURORA_SYSTEM) {
        return AURORAN_GOVT;
    }
    return FEDERATION_GOVT;
}

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
