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

export const CONQUEST_STARTING_SHIP_ID = 'nova:128'; // Shuttle

export const CONQUEST_BOT_ARCHETYPES = [
    'interceptor',
    'gunship',
    'capital',
    'striker',
] as const;

export type ConquestBotArchetype = typeof CONQUEST_BOT_ARCHETYPES[number];

export const FEDERATION_UPGRADE_TIERS = [
    'nova:128', // Tier 0: Shuttle
    'nova:187', // Tier 1: Fed Scout Ship
    'nova:144', // Tier 2: Fed Viper
    'nova:135', // Tier 3: Lightning
    'nova:145', // Tier 4: Fed Anaconda
    'nova:137', // Tier 5: Valkyrie
    'nova:142', // Tier 6: Fed Patrol Boat
    'nova:172', // Tier 7: RAGE Gunboat
    'nova:140', // Tier 8: IDA Frigate
    'nova:141', // Tier 9: Fed Destroyer
    'nova:143', // Tier 10: Fed Carrier
] as const;

export const AURORAN_UPGRADE_TIERS = [
    'nova:128', // Tier 0: Shuttle
    'nova:155', // Tier 1: Firebird
    'nova:156', // Tier 2: Phoenix
    'nova:138', // Tier 3: Argosy
    'nova:152', // Tier 4: Abomination
    'nova:154', // Tier 5: Aurora Cruiser
    'nova:153', // Tier 6: Aurora Carrier
] as const;

/**
 * Branching ship upgrade trees for Federation bots so pilots start in a Tier 0
 * Shuttle (`nova:128`) and diverge into varied hull roles rather than following
 * a single identical progression line.
 */
export const FEDERATION_ARCHETYPE_TREES: Readonly<Record<ConquestBotArchetype, readonly string[]>> = {
    interceptor: [
        'nova:128', // Tier 0: Shuttle
        'nova:187', // Tier 1: Fed Scout Ship
        'nova:144', // Tier 2: Fed Viper
        'nova:135', // Tier 3: Lightning
        'nova:137', // Tier 4: Valkyrie
        'nova:142', // Tier 5: Fed Patrol Boat
        'nova:140', // Tier 6: IDA Frigate
        'nova:141', // Tier 7: Fed Destroyer
    ],
    gunship: [
        'nova:128', // Tier 0: Shuttle
        'nova:129', // Tier 1: Heavy Shuttle
        'nova:145', // Tier 2: Fed Anaconda
        'nova:133', // Tier 3: Starbridge
        'nova:172', // Tier 4: RAGE Gunboat
        'nova:140', // Tier 5: IDA Frigate
        'nova:141', // Tier 6: Fed Destroyer
        'nova:143', // Tier 7: Fed Carrier
    ],
    capital: [
        'nova:128', // Tier 0: Shuttle
        'nova:187', // Tier 1: Fed Scout Ship
        'nova:167', // Tier 2: Viper
        'nova:142', // Tier 3: Fed Patrol Boat
        'nova:172', // Tier 4: RAGE Gunboat
        'nova:140', // Tier 5: IDA Frigate
        'nova:141', // Tier 6: Fed Destroyer
        'nova:143', // Tier 7: Fed Carrier
    ],
    striker: [
        'nova:128', // Tier 0: Shuttle
        'nova:144', // Tier 1: Fed Viper
        'nova:133', // Tier 2: Starbridge
        'nova:165', // Tier 3: Mod Starbridge
        'nova:137', // Tier 4: Valkyrie
        'nova:175', // Tier 5: Vell-os Javelin
        'nova:174', // Tier 6: Vell-os Arrow
        'nova:141', // Tier 7: Fed Destroyer
    ],
};

/**
 * Branching ship upgrade trees for Auroran Empire bots, all starting in a
 * Tier 0 Shuttle (`nova:128`) before specializing.
 */
export const AURORAN_ARCHETYPE_TREES: Readonly<Record<ConquestBotArchetype, readonly string[]>> = {
    interceptor: [
        'nova:128', // Tier 0: Shuttle
        'nova:155', // Tier 1: Firebird
        'nova:156', // Tier 2: Phoenix
        'nova:133', // Tier 3: Starbridge
        'nova:152', // Tier 4: Abomination
        'nova:154', // Tier 5: Aurora Cruiser
        'nova:153', // Tier 6: Aurora Carrier
    ],
    gunship: [
        'nova:128', // Tier 0: Shuttle
        'nova:129', // Tier 1: Heavy Shuttle
        'nova:138', // Tier 2: Argosy
        'nova:156', // Tier 3: Phoenix
        'nova:152', // Tier 4: Abomination
        'nova:154', // Tier 5: Aurora Cruiser
        'nova:153', // Tier 6: Aurora Carrier
    ],
    capital: [
        'nova:128', // Tier 0: Shuttle
        'nova:155', // Tier 1: Firebird
        'nova:138', // Tier 2: Argosy
        'nova:139', // Tier 3: Enterprise
        'nova:152', // Tier 4: Abomination
        'nova:154', // Tier 5: Aurora Cruiser
        'nova:153', // Tier 6: Aurora Carrier
    ],
    striker: [
        'nova:128', // Tier 0: Shuttle
        'nova:157', // Tier 1: Thunderhead
        'nova:155', // Tier 2: Firebird
        'nova:156', // Tier 3: Phoenix
        'nova:138', // Tier 4: Argosy
        'nova:152', // Tier 5: Abomination
        'nova:154', // Tier 6: Aurora Cruiser
    ],
};

export const ALL_CONQUEST_UPGRADE_HULLS: readonly string[] = Array.from(
    new Set<string>([
        ...FEDERATION_UPGRADE_TIERS,
        ...AURORAN_UPGRADE_TIERS,
        ...Object.values(FEDERATION_ARCHETYPE_TREES).flat(),
        ...Object.values(AURORAN_ARCHETYPE_TREES).flat(),
    ]),
);

export function pickConquestArchetype(callsign: string): ConquestBotArchetype {
    let hash = 2166136261;
    for (let i = 0; i < callsign.length; i++) {
        hash ^= callsign.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return CONQUEST_BOT_ARCHETYPES[(hash >>> 0) % CONQUEST_BOT_ARCHETYPES.length];
}

export function hullTiersForBot(
    factionGovt: number,
    archetype?: ConquestBotArchetype,
): readonly string[] {
    if (archetype) {
        const trees = factionGovt === AURORAN_GOVT
            ? AURORAN_ARCHETYPE_TREES
            : FEDERATION_ARCHETYPE_TREES;
        const branch = trees[archetype];
        if (branch) {
            return branch;
        }
    }
    return factionGovt === AURORAN_GOVT
        ? AURORAN_UPGRADE_TIERS
        : FEDERATION_UPGRADE_TIERS;
}

/**
 * High-tier capital defense hull tier indices in `FEDERATION_UPGRADE_TIERS`:
 * - Tier 10: Fed Carrier (`nova:143`)
 * - Tier 9: Fed Destroyer (`nova:141`)
 * - Tier 7: RAGE Gunboat (`nova:172`)
 * - Tier 6: Fed Patrol Boat (`nova:142`)
 */
export const FEDERATION_GARRISON_TIERS = [10, 9, 7, 6] as const;

/**
 * High-tier capital defense hull tier indices in `AURORAN_UPGRADE_TIERS`:
 * - Tier 6: Aurora Carrier (`nova:153`)
 * - Tier 5: Aurora Cruiser (`nova:154`)
 * - Tier 4: Abomination (`nova:152`)
 * - Tier 3: Argosy (`nova:138`)
 */
export const AURORAN_GARRISON_TIERS = [6, 5, 4, 3] as const;

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

export const ConquestBotArchetypeCodec = t.union([
    t.literal('interceptor'),
    t.literal('gunship'),
    t.literal('capital'),
    t.literal('striker'),
]);

export const ConquestBotStateCodec = t.intersection([
    t.type({
        callsign: t.string,
        mode: t.union([
            t.literal('gather'),
            t.literal('attack'),
            t.literal('raid'),
            t.literal('retreat'),
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
        archetype: ConquestBotArchetypeCodec,
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
export const CONQUEST_EARLY_PEACE_DURATION_MS = 45_000;
export const CONQUEST_RETREAT_POWER_RATIO = 1.65;
export const CONQUEST_RETREAT_CRITICAL_HP_RATIO = 0.35;
export const CONQUEST_TACTICAL_AWARENESS_RADIUS = 2_200;

const SHIP_COMBAT_TIER_BY_ID: Readonly<Record<string, number>> = {
    'nova:128': 0, // Shuttle
    'nova:129': 1, // Heavy Shuttle
    'nova:136': 1, // Terrapin
    'nova:187': 1, // Fed Scout Ship
    'nova:155': 1, // Firebird
    'nova:157': 1, // Thunderhead
    'nova:144': 2, // Fed Viper
    'nova:167': 2, // Viper
    'nova:145': 2, // Fed Anaconda
    'nova:156': 2, // Phoenix
    'nova:138': 2, // Argosy
    'nova:132': 2, // Pegasus
    'nova:133': 3, // Starbridge
    'nova:135': 3, // Lightning
    'nova:165': 3, // Mod Starbridge
    'nova:139': 3, // Enterprise
    'nova:131': 3, // Leviathan
    'nova:137': 4, // Valkyrie
    'nova:142': 4, // Fed Patrol Boat
    'nova:172': 4, // RAGE Gunboat
    'nova:152': 4, // Abomination
    'nova:175': 5, // Vell-os Javelin
    'nova:140': 5, // IDA Frigate
    'nova:154': 5, // Aurora Cruiser
    'nova:174': 6, // Vell-os Arrow
    'nova:141': 6, // Fed Destroyer
    'nova:143': 7, // Fed Carrier
    'nova:153': 7, // Aurora Carrier
    'nova:173': 7, // Vell-os Dart
};

/**
 * Fast O(1) lookup of a ship's effective combat tier from its hull ID and/or
 * Conquest bot upgrade tier.
 */
export function estimateHullCombatTier(
    shipId: string | undefined,
    botTier?: number,
): number {
    const hullTier = shipId ? (SHIP_COMBAT_TIER_BY_ID[shipId] ?? 0) : 0;
    if (botTier !== undefined) {
        return Math.max(0, botTier, hullTier);
    }
    return hullTier;
}

/**
 * Pure, zero-allocation combat power score for Lanchester force balance
 * assessment at 60 Hz. Combines hull tier scaling with structural hitpoints
 * and current shield+armor health ratio.
 */
export function evaluateShipCombatPower(
    tier: number,
    healthRatio = 1,
    totalHitpoints = 0,
): number {
    const cleanTier = Math.max(0, tier);
    const tierPower = 1 + cleanTier * 0.95 + cleanTier * cleanTier * 0.32;
    const durabilityBonus = totalHitpoints > 0
        ? Math.min(8, totalHitpoints / 400)
        : 0;
    const clampedHealth = Math.max(0.15, Math.min(1, healthRatio));
    return (tierPower + durabilityBonus) * clampedHealth;
}

/**
 * Tactical Utility AI check: determines whether a bot should disengage and
 * retreat (either back to its home planet for repairs/cover, or back across
 * the hyperjump link if raiding a superior enemy system).
 */
export function shouldBotRetreat(params: {
    selfTier: number;
    selfHealthRatio: number;
    friendlyPower: number;
    enemyPower: number;
    maxEnemyTier: number;
    isGarrison?: boolean;
}): boolean {
    const {
        selfTier,
        selfHealthRatio,
        friendlyPower,
        enemyPower,
        maxEnemyTier,
        isGarrison,
    } = params;
    if (enemyPower <= 0) {
        return false;
    }
    if (isGarrison) {
        return selfHealthRatio < 0.22 && enemyPower > friendlyPower * 1.25;
    }
    // 1. Critical damage (< 35% HP) while any enemy threat is present
    if (selfHealthRatio < CONQUEST_RETREAT_CRITICAL_HP_RATIO) {
        return true;
    }
    // 2. Tier 0 Shuttles evade any military warship (Tier 1+) or when damaged (< 55% HP)
    if (selfTier === 0 && (maxEnemyTier >= 1 || selfHealthRatio < 0.55)) {
        return true;
    }
    // 3. Fragile Tier 1 Scouts confronted by a much heavier warship (2+ tiers higher)
    if (
        selfTier <= 1
        && maxEnemyTier >= selfTier + 2
        && enemyPower > friendlyPower * 1.1
    ) {
        return true;
    }
    // 3. Outmatched by superior local enemy force (enemyPower > friendlyPower * 1.65)
    if (enemyPower > Math.max(0.5, friendlyPower) * CONQUEST_RETREAT_POWER_RATIO) {
        return true;
    }
    return false;
}

/**
 * Pure utility score for selecting the optimal hostile target:
 * balances proximity, squad focus-fire, finisher bonus on damaged hulls,
 * and winnable tier matchups.
 */
export function scoreEnemyTargetUtility(params: {
    distance: number;
    selfTier: number;
    targetTier: number;
    targetHealthRatio: number;
    isSquadTarget: boolean;
    isLastAttacker: boolean;
}): number {
    const proximityScore = 1_200 / (Math.max(0, params.distance) + 180);
    const focusFireBonus = params.isSquadTarget ? 3.5 : 0;
    const retaliationBonus = params.isLastAttacker ? 1.25 : 0;
    const finisherBonus = (1 - Math.max(0, Math.min(1, params.targetHealthRatio))) * 2.2;
    const tierDiff = params.targetTier - params.selfTier;
    const matchupBonus = tierDiff <= 1 ? 0.8 : (tierDiff >= 3 ? -1.4 : 0);
    return proximityScore + focusFireBonus + retaliationBonus + finisherBonus + matchupBonus;
}

const AURORAN_HULL_SET = new Set<string>([
    'nova:138', // Argosy
    'nova:139', // Enterprise
    'nova:152', // Abomination
    'nova:153', // Aurora Carrier
    'nova:154', // Aurora Cruiser
    'nova:155', // Firebird
    'nova:156', // Phoenix
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
