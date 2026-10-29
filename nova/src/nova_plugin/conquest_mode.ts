import { Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
import { AsyncSystem } from 'nova_ecs/async_system';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import {
    MovementPhysicsComponent,
    MovementStateComponent,
} from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from 'nova_ecs/world';
import { v4 as uuid } from 'uuid';
import { AsteroidComponent, enforceOreEntityCap, makeOre, OreComponent } from './asteroid_plugin';
import { BoardingNoticeComponent } from './boarding_notice';
import { DeathEvent, DisabledComponent, LastAttackerComponent, PlayerDeathComponent } from './death_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { CloakStateComponent } from './cloaking_plugin';
import { EntityBudgetResource, reserveEntity } from './entity_budget';
import { HiredEscortComponent } from './escort_plugin';
import { OwnerComponent } from './fire_weapon_plugin';
import { approachTarget } from './flight_controller';
import { GameDataResource } from './game_data_resource';
import { ArmorComponent, ShieldComponent } from './health_plugin';
import {
    calculateJumpArrival,
    distanceFromSystemOrigin,
    JUMP_ARRIVAL_MS,
    JUMP_ARRIVAL_RADIUS,
    JUMP_ARRIVAL_SPEED_MULTIPLIER,
    JUMP_BRAKE_MS,
    JumpStateComponent,
} from './jump_plugin';
import {
    ChooseRandomTargetComponent,
    GovtComponent,
    NpcCombatRoleComponent,
} from './npc_components';
import {
    FollowAI,
    getEffectiveWeaponRange,
    makeNpc,
    ShootAllWeaponsAI,
    WanderComponent,
} from './npc_plugin';
import {
    isPersonallyProvoked,
    isProvoked,
    ProvocationResource,
    recordProvocation,
} from './npc_hostility';
import { OutfitsStateComponent } from './outfit_plugin';
import { PlanetComponent } from './planet_plugin';
import { PlatformResource } from './platform_plugin';
import { PlayerStateComponent } from './player_state';
import {
    getShipMovementPhysics,
    ShipComponent,
    ShipDataComponent,
    ShipPhysicsComponent,
} from './ship_plugin';
import { CombatAuthorityComponent } from './combat_resources';
import { SystemIdResource } from './system_id_resource';
import { TargetComponent } from './target_component';
import { WeaponsStateComponent } from './weapons_state';

import {
    ALL_CONQUEST_UPGRADE_HULLS,
    AURORAN_GARRISON_TIERS,
    AURORAN_GOVT,
    AURORAN_UPGRADE_TIERS,
    CONQUEST_AURORA_SYSTEM,
    CONQUEST_BASE_MAGNET_RADIUS,
    CONQUEST_BOT_GATHER_CREDIT_RATE_PER_SEC,
    CONQUEST_BOT_RAID_IDLE_MS,
    CONQUEST_BOT_SPAWN_INTERVAL_MS,
    CONQUEST_BOT_UPGRADE_BASE_COST,
    CONQUEST_EARLY_PEACE_DURATION_MS,
    CONQUEST_MAGNET_ACCEL,
    CONQUEST_ORE_SCATTER_DELAY_MS,
    CONQUEST_SOL_SYSTEM,
    CONQUEST_SYSTEM_POSITIONS,
    CONQUEST_TACTICAL_AWARENESS_RADIUS,
    ConquestBotArchetype,
    ConquestBotComponent,
    ConquestBotState,
    ConquestBotStateCodec,
    conquestOreCreditValue,
    drainConquestBotTransfers,
    estimateHullCombatTier,
    evaluateShipCombatPower,
    FEDERATION_GARRISON_TIERS,
    FEDERATION_GOVT,
    FEDERATION_UPGRADE_TIERS,
    hullTiersForBot,
    isConquestMode,
    isConquestPocketSystem,
    MAX_CONQUEST_BOTS_PER_SYSTEM,
    oppositeConquestSystem,
    pickConquestArchetype,
    pickUniqueConquestCallsign,
    playerConquestFaction,
    scoreEnemyTargetUtility,
    shouldBotRetreat,
} from './conquest_config';
export * from './conquest_config';

const ConquestPlayersQuery = new Query([
    UUID,
    PlayerStateComponent,
    MovementStateComponent,
] as const, 'ConquestPlayers');

const ConquestBotsQuery = new Query([
    UUID,
    ConquestBotComponent,
    MovementStateComponent,
    Optional(MovementPhysicsComponent),
    ShipComponent,
    TargetComponent,
    Optional(WeaponsStateComponent),
    Optional(DisabledComponent),
    Optional(ShieldComponent),
    Optional(ArmorComponent),
    GetEntity,
] as const, 'ConquestBots');

const ConquestAsteroidsQuery = new Query([
    UUID,
    MovementStateComponent,
    AsteroidComponent,
] as const, 'ConquestAsteroids');

const ConquestOresQuery = new Query([
    UUID,
    OreComponent,
    MovementStateComponent,
] as const, 'ConquestOres');

const ConquestPlanetsQuery = new Query([
    UUID,
    MovementStateComponent,
    PlanetComponent,
] as const, 'ConquestPlanets');

const ConquestShipsQuery = new Query([
    UUID,
    MovementStateComponent,
    ShipComponent,
    MultiplayerData,
    Optional(GovtComponent),
    Optional(PlayerStateComponent),
    Optional(DisabledComponent),
    Optional(ConquestBotComponent),
    Optional(OwnerComponent),
    Optional(HiredEscortComponent),
    Optional(DestructionStartedComponent),
    Optional(PlayerDeathComponent),
    Optional(JumpStateComponent),
    Optional(CloakStateComponent),
    Optional(ShieldComponent),
    Optional(ArmorComponent),
] as const, 'ConquestShips');

function upgradeCostForTier(tier: number): number {
    return CONQUEST_BOT_UPGRADE_BASE_COST * (tier + 1);
}

export function hullTiersForGovt(
    govt: number,
    archetype?: ConquestBotArchetype,
): readonly string[] {
    return hullTiersForBot(govt, archetype);
}

export function garrisonTiersForGovt(govt: number): readonly number[] {
    return govt === AURORAN_GOVT
        ? AURORAN_GARRISON_TIERS
        : FEDERATION_GARRISON_TIERS;
}

const nextConquestBotSpawnBySystem = new Map<string, number>();
const nextRivalRaidWaveBySystem = new Map<string, number>();
const conquestMatchStartedAtBySystem = new Map<string, number>();
const lastEnemySeenByBot = new Map<string, number>();
const miningCreditAccumByBot = new Map<string, number>();
const CONQUEST_RIVAL_RAID_WAVE_INTERVAL_MS = 32_000;
const warmedGameDataSets = new WeakSet<object>();

export function resetConquestRuntimeState(): void {
    nextConquestBotSpawnBySystem.clear();
    nextRivalRaidWaveBySystem.clear();
    conquestMatchStartedAtBySystem.clear();
    lastEnemySeenByBot.clear();
    miningCreditAccumByBot.clear();
}

function warmConquestHulls(
    gameData: import('novadatainterface/GameDataInterface').GameDataInterface,
    systemId?: string,
): void {
    if (systemId) {
        const sys = gameData.data.System.getCached?.(systemId);
        if (!sys) {
            void gameData.data.System.get?.(systemId)?.then(loaded => {
                for (const pid of loaded?.planets ?? []) {
                    void gameData.data.Planet.get?.(pid)?.catch(() => {});
                }
            })?.catch(() => {});
        } else {
            for (const pid of sys.planets ?? []) {
                if (!gameData.data.Planet.getCached?.(pid)) {
                    void gameData.data.Planet.get?.(pid)?.catch(() => {});
                }
            }
        }
    }
    if (warmedGameDataSets.has(gameData)) {
        return;
    }
    warmedGameDataSets.add(gameData);
    for (const id of ALL_CONQUEST_UPGRADE_HULLS) {
        void gameData.data.Ship.get(id).catch(() => {});
    }
}

function resolveConquestSystemPlanets(
    gameData: import('novadatainterface/GameDataInterface').GameDataInterface,
    systemId: string,
    livePlanets: ReadonlyArray<readonly [string, import('nova_ecs/plugins/movement_plugin').MovementState, import('./planet_plugin').PlanetType]>,
): Position[] {
    const inhabitedLive: Position[] = [];
    const allLive: Position[] = [];
    for (const [, mov, planet] of livePlanets) {
        const pos = new Position(mov.position.x, mov.position.y);
        allLive.push(pos);
        if (planet.inhabited !== false && planet.canLand !== false) {
            inhabitedLive.push(pos);
        }
    }
    if (inhabitedLive.length > 0) {
        return inhabitedLive;
    }
    if (allLive.length > 0) {
        return allLive;
    }
    const sys = gameData.data.System.getCached?.(systemId);
    const cachedPositions: Position[] = [];
    for (const pid of sys?.planets ?? []) {
        const planet = gameData.data.Planet.getCached?.(pid);
        if (planet?.position) {
            cachedPositions.push(new Position(planet.position[0], planet.position[1]));
        }
    }
    if (cachedPositions.length > 0) {
        return cachedPositions;
    }
    // Fallback to homeworld center (Sol / Earth at [0, 0])
    return [new Position(0, 0)];
}

function resolveBotShipData(
    gameData: import('novadatainterface/GameDataInterface').GameDataInterface,
    factionGovt: number,
    tier: number,
    archetype?: ConquestBotArchetype,
): import('novadatainterface/ShipData').ShipData | undefined {
    const branchTiers = hullTiersForBot(factionGovt, archetype);
    const clampedTier = Math.max(0, Math.min(branchTiers.length - 1, tier));
    const primaryId = branchTiers[clampedTier];
    const primary = gameData.data.Ship.getCached(primaryId);
    if (primary) {
        return primary;
    }
    void gameData.data.Ship.get(primaryId).catch(() => {});

    const fallbackTiers = factionGovt === AURORAN_GOVT
        ? AURORAN_UPGRADE_TIERS
        : FEDERATION_UPGRADE_TIERS;
    const fallbackId = fallbackTiers[Math.min(fallbackTiers.length - 1, clampedTier)];
    if (fallbackId && fallbackId !== primaryId) {
        const fallback = gameData.data.Ship.getCached(fallbackId);
        if (fallback) {
            return fallback;
        }
        void gameData.data.Ship.get(fallbackId).catch(() => {});
    }
    // Final fallback for minimal unit test fixtures that only populate a few ships
    for (const candidateId of fallbackTiers) {
        const cached = gameData.data.Ship.getCached(candidateId);
        if (cached) {
            return cached;
        }
    }
    return undefined;
}

function spawnConquestBotEntity(
    gameData: import('novadatainterface/GameDataInterface').GameDataInterface,
    budget: import('./entity_budget').EntityBudget,
    botState: ConquestBotState,
    position: Position,
    rotation = new Angle(Math.random() * 2 * Math.PI),
    velocity = new Vector(0, 0),
    arrivingFrom?: { from: string; to: string; now: number },
): Entity | undefined {
    if (!botState.archetype) {
        botState.archetype = pickConquestArchetype(botState.callsign);
    }
    const tiers = hullTiersForBot(botState.factionGovt, botState.archetype);
    const clampedTier = Math.max(0, Math.min(tiers.length - 1, botState.tier));
    botState.tier = clampedTier;
    const shipData = resolveBotShipData(
        gameData,
        botState.factionGovt,
        clampedTier,
        botState.archetype,
    );
    if (!shipData) {
        return undefined;
    }
    const bot = makeNpc(shipData);
    if (!reserveEntity(budget, bot, 'ship')) {
        return undefined;
    }
    // ConquestBotLifecycleSystem manages targeting and flight; prevent
    // ChooseRandomTargetAI and WanderAI from overriding targets or headings.
    bot.components.delete(ChooseRandomTargetComponent);
    bot.components.delete(WanderComponent);
    bot.name = `${botState.callsign} (${shipData.name})`;

    const mov = bot.components.get(MovementStateComponent);
    if (mov) {
        mov.position = position;
        mov.rotation = rotation;
        mov.velocity = velocity;
    }
    bot.components
        .set(ShipDataComponent, shipData)
        .set(ShipPhysicsComponent, { ...shipData.physics })
        .set(MovementPhysicsComponent, getShipMovementPhysics(shipData.physics, false))
        .set(
            OutfitsStateComponent,
            new Map(Object.entries(shipData.outfits ?? {}).map(
                ([id, count]) => [id, { count }],
            )),
        )
        .set(GovtComponent, { id: botState.factionGovt })
        .set(NpcCombatRoleComponent, 'military')
        .set(ConquestBotComponent, botState)
        .set(MultiplayerData, { owner: 'server' });

    if (arrivingFrom) {
        bot.components.set(JumpStateComponent, {
            from: arrivingFrom.from,
            to: arrivingFrom.to,
            phase: 'arriving',
            phaseStartedAt: arrivingFrom.now,
            transitionAt: arrivingFrom.now + JUMP_ARRIVAL_MS,
            requiresAdjacency: false,
            arrivalSoundPending: false,
            createdAt: arrivingFrom.now,
        });
    }
    return bot;
}

const ConquestBotLifecycleSystem = new System({
    name: 'ConquestBotLifecycle',
    after: [FollowAI, ShootAllWeaponsAI],
    args: [
        SingletonComponent,
        GameDataResource,
        SystemIdResource,
        PlatformResource,
        TimeResource,
        Entities,
        EntityBudgetResource,
        ConquestPlayersQuery,
        ConquestBotsQuery,
        ConquestAsteroidsQuery,
        ConquestOresQuery,
        ConquestShipsQuery,
        ConquestPlanetsQuery,
        Optional(ProvocationResource),
    ] as const,
    step(
        _singleton,
        gameData,
        systemId,
        platform,
        time,
        entities,
        budget,
        players,
        bots,
        asteroids,
        ores,
        ships,
        planets,
        provocations,
    ) {
        if (platform !== 'node' || !isConquestPocketSystem(systemId)) {
            return;
        }
        const hasConquestPlayer = players.some(([, state]) =>
            isConquestMode(state));
        if (!hasConquestPlayer) {
            conquestMatchStartedAtBySystem.delete(systemId);
            nextConquestBotSpawnBySystem.delete(systemId);
            nextRivalRaidWaveBySystem.delete(systemId);
            return;
        }
        const existingMatchStart = conquestMatchStartedAtBySystem.get(systemId);
        if (existingMatchStart === undefined || time.time < existingMatchStart) {
            conquestMatchStartedAtBySystem.set(systemId, time.time);
        }
        const matchStartedAt = conquestMatchStartedAtBySystem.get(systemId) ?? time.time;
        const matchElapsedMs = Math.max(0, time.time - matchStartedAt);

        warmConquestHulls(gameData, systemId);
        const systemPlanets = resolveConquestSystemPlanets(gameData, systemId, planets);

        // 0. Purge any retail ambient NPCs (traders, shuttles, cargo drones)
        // that spawned before the Conquest player's state arrived.
        for (const [
            shipUuid,
            ,
            ,
            multiplayer,
            ,
            playerState,
            ,
            conquestBot,
            ownerComp,
            escortComp,
        ] of ships) {
            if (
                multiplayer.owner === 'server'
                && !playerState
                && !conquestBot
                && !ownerComp
                && !escortComp
            ) {
                entities.delete(shipUuid);
            }
        }

        const usedCallsigns = new Set<string>(
            bots.map(([, b]) => b.callsign),
        );
        const homeGovt = systemId === CONQUEST_AURORA_SYSTEM
            ? AURORAN_GOVT
            : FEDERATION_GOVT;
        const rivalGovt = homeGovt === AURORAN_GOVT
            ? FEDERATION_GOVT
            : AURORAN_GOVT;
        const otherSystem = oppositeConquestSystem(systemId);

        // 1. Materialize any Conquest bots that hyperjumped into this system
        // from the opposite pocket system!
        const incomingTransfers = drainConquestBotTransfers(systemId);
        for (const transfer of incomingTransfers) {
            const sourcePos = CONQUEST_SYSTEM_POSITIONS[transfer.from] ?? [-45, 0];
            const destPos = CONQUEST_SYSTEM_POSITIONS[systemId] ?? [45, 0];
            const arrival = calculateJumpArrival(
                sourcePos,
                destPos,
                JUMP_ARRIVAL_RADIUS,
                320 * JUMP_ARRIVAL_SPEED_MULTIPLIER,
                new Position(
                    transfer.departurePosition[0],
                    transfer.departurePosition[1],
                ),
            );
            try {
                const callsign = usedCallsigns.has(transfer.botState.callsign)
                    ? pickUniqueConquestCallsign(transfer.botState.factionGovt, usedCallsigns)
                    : transfer.botState.callsign;
                const returnedHome = transfer.botState.homeSystem === systemId
                    && transfer.botState.mode === 'retreat';
                const state: ConquestBotState = {
                    ...transfer.botState,
                    callsign,
                    archetype: transfer.botState.archetype ?? pickConquestArchetype(callsign),
                    mode: returnedHome ? 'retreat' : 'attack',
                    lastModeSwitchAt: time.time,
                };
                usedCallsigns.add(state.callsign);
                const bot = spawnConquestBotEntity(
                    gameData,
                    budget,
                    state,
                    arrival.position,
                    arrival.rotation,
                    arrival.velocity,
                    { from: transfer.from, to: systemId, now: time.time },
                );
                if (bot) {
                    entities.set(uuid(), bot);
                }
            } catch {
                // Ignore missing ship resource in minimal test fixtures
            }
        }

        // 2. Fair Match Start & Progression:
        // Every home faction pilot launches from Sol/Earth or Aurora at Tier 0
        // in a Shuttle (`nova:128`) with 0 credits and progresses upward by
        // mining asteroids, scooping salvage, and upgrading along their archetype branch.
        const rawNextSpawnAt = nextConquestBotSpawnBySystem.get(systemId) ?? 0;
        const nextSpawnAt = time.time < rawNextSpawnAt - CONQUEST_BOT_SPAWN_INTERVAL_MS * 2
            ? 0
            : rawNextSpawnAt;
        const homeBotsCount = bots.filter(([, b]) => b.factionGovt === homeGovt).length;

        if (
            bots.length < MAX_CONQUEST_BOTS_PER_SYSTEM
            && homeBotsCount < MAX_CONQUEST_BOTS_PER_SYSTEM - 1
            && (homeBotsCount === 0 || time.time >= nextSpawnAt)
        ) {
            nextConquestBotSpawnBySystem.set(
                systemId,
                time.time + CONQUEST_BOT_SPAWN_INTERVAL_MS,
            );
            const callsign = pickUniqueConquestCallsign(homeGovt, usedCallsigns);
            usedCallsigns.add(callsign);
            const archetype = pickConquestArchetype(callsign);
            // Always launch home faction ships directly from Sol or another
            // planet in the system — never pop into empty space!
            const launchPlanet = systemPlanets[
                Math.floor(Math.random() * systemPlanets.length)
            ] ?? new Position(0, 0);
            const launchBearing = Math.random() * 2 * Math.PI;
            const pos = new Position(launchPlanet.x, launchPlanet.y);
            const launchRotation = new Angle(launchBearing);
            const launchVelocity = new Vector(
                Math.sin(launchBearing) * 45,
                -Math.cos(launchBearing) * 45,
            );
            try {
                const bot = spawnConquestBotEntity(
                    gameData,
                    budget,
                    {
                        callsign,
                        archetype,
                        mode: 'gather',
                        factionGovt: homeGovt,
                        homeSystem: systemId,
                        tier: 0,
                        gatheredCredits: 0,
                        lastModeSwitchAt: time.time,
                        upgradePending: false,
                    },
                    pos,
                    launchRotation,
                    launchVelocity,
                );
                if (bot) {
                    entities.set(uuid(), bot);
                }
            } catch {
                // Ignore missing ship resource in minimal test fixtures
            }
        }

        // 3. Progression-Scaled Rival Faction Cross-System Raid Waves
        // Only begins after CONQUEST_EARLY_PEACE_DURATION_MS so rival pilots
        // have time to mine and upgrade out of their starting Shuttles, and
        // scales raider tier strictly with match elapsed time.
        const nextRaidAt = nextRivalRaidWaveBySystem.get(systemId)
            ?? (matchStartedAt + CONQUEST_EARLY_PEACE_DURATION_MS);
        if (!nextRivalRaidWaveBySystem.has(systemId)) {
            nextRivalRaidWaveBySystem.set(systemId, nextRaidAt);
        }
        const activeRivalBots = bots.filter(([, b]) => b.factionGovt === rivalGovt).length;
        if (
            otherSystem
            && matchElapsedMs >= CONQUEST_EARLY_PEACE_DURATION_MS
            && activeRivalBots < 3
            && bots.length < MAX_CONQUEST_BOTS_PER_SYSTEM + 2
            && time.time >= nextRaidAt
        ) {
            nextRivalRaidWaveBySystem.set(
                systemId,
                time.time + CONQUEST_RIVAL_RAID_WAVE_INTERVAL_MS,
            );
            const progressionSteps = Math.floor(
                (matchElapsedMs - CONQUEST_EARLY_PEACE_DURATION_MS) / 45_000,
            );
            const maxEarnedTier = Math.max(1, Math.min(4, 1 + progressionSteps));
            const groupSize = maxEarnedTier >= 2 && Math.random() < 0.55
                ? (Math.random() < 0.65 ? 2 : 3)
                : 1;
            const squadId = groupSize > 1 ? uuid() : undefined;
            const sourcePos = CONQUEST_SYSTEM_POSITIONS[otherSystem] ?? [45, 0];
            const destPos = CONQUEST_SYSTEM_POSITIONS[systemId] ?? [-45, 0];
            const baseLateralY = (Math.random() - 0.5) * 700;
            let leaderUuid: string | undefined;

            for (let i = 0; i < groupSize; i++) {
                const callsign = pickUniqueConquestCallsign(rivalGovt, usedCallsigns);
                usedCallsigns.add(callsign);
                const archetype = pickConquestArchetype(callsign);
                const rivalBranch = hullTiersForBot(rivalGovt, archetype);
                const baseTier = Math.min(rivalBranch.length - 1, maxEarnedTier);
                const tier = i === 0
                    ? baseTier
                    : Math.max(1, baseTier - (Math.random() < 0.5 ? 1 : 0));
                const lateralOffset = baseLateralY + (i - (groupSize - 1) / 2) * 110;
                const arrival = calculateJumpArrival(
                    sourcePos,
                    destPos,
                    JUMP_ARRIVAL_RADIUS,
                    320 * JUMP_ARRIVAL_SPEED_MULTIPLIER,
                    new Position(0, lateralOffset),
                );
                try {
                    const memberUuid = uuid();
                    if (i === 0) {
                        leaderUuid = memberUuid;
                    }
                    const bot = spawnConquestBotEntity(
                        gameData,
                        budget,
                        {
                            callsign,
                            archetype,
                            mode: 'attack',
                            factionGovt: rivalGovt,
                            homeSystem: otherSystem,
                            tier,
                            gatheredCredits: 0,
                            lastModeSwitchAt: time.time,
                            upgradePending: false,
                            squadId,
                            squadLeaderUuid: leaderUuid,
                        },
                        arrival.position,
                        arrival.rotation,
                        arrival.velocity,
                        { from: otherSystem, to: systemId, now: time.time },
                    );
                    if (bot) {
                        entities.set(memberUuid, bot);
                        if (i === 0) {
                            const factionLabel = rivalGovt === AURORAN_GOVT ? 'Auroran' : 'Federation';
                            const waveDesc = groupSize > 1
                                ? `${factionLabel} Strike Group (${callsign} + ${groupSize - 1} wing)`
                                : `${factionLabel} Raider ${callsign}`;
                            for (const [playerUuid, pState] of players) {
                                if (isConquestMode(pState)) {
                                    entities.get(playerUuid)?.components.set(BoardingNoticeComponent, {
                                        text: `⚠️ Incoming ${waveDesc} jumping in from ${otherSystem === CONQUEST_AURORA_SYSTEM ? 'Aurora' : 'Sol'}!`,
                                    });
                                }
                            }
                        }
                    }
                } catch {
                    break;
                }
            }
        }

        // Reusable zero-allocation scratch result for 60 Hz Tactical Utility AI
        const tacticalScratch = {
            friendlyPower: 0,
            enemyPower: 0,
            maxEnemyTier: 0,
            bestEnemyUuid: undefined as string | undefined,
            closestEnemyUuid: undefined as string | undefined,
            closestEnemyDistSq: Infinity,
        };

        const assessLocalForceBalance = (
            botUuid: string,
            botState: ConquestBotState,
            position: Position,
            botEntity: Entity,
            selfEffectiveTier: number,
            selfPower: number,
            squadLeaderTargetUuid: string | undefined,
        ) => {
            tacticalScratch.friendlyPower = selfPower;
            tacticalScratch.enemyPower = 0;
            tacticalScratch.maxEnemyTier = 0;
            tacticalScratch.bestEnemyUuid = undefined;
            tacticalScratch.closestEnemyUuid = undefined;
            tacticalScratch.closestEnemyDistSq = Infinity;

            let bestUtility = -Infinity;
            const awarenessRadiusSq =
                CONQUEST_TACTICAL_AWARENESS_RADIUS * CONQUEST_TACTICAL_AWARENESS_RADIUS;
            const lastAttacker = botEntity.components.get(LastAttackerComponent);

            for (const [
                candidateUuid,
                candidateMov,
                candidateShip,
                ,
                candidateGovt,
                candidatePlayer,
                candidateDisabled,
                candidateBot,
                ,
                ,
                candidateDestruction,
                candidatePlayerDeath,
                candidateJump,
                candidateCloak,
                candidateShield,
                candidateArmor,
            ] of ships) {
                if (
                    candidateUuid === botUuid
                    || candidateDisabled
                    || candidateDestruction
                    || candidatePlayerDeath
                    || candidateJump?.phase === 'departing'
                    || candidateJump?.phase === 'arriving'
                    || (candidateCloak?.cloaked && (candidateCloak.alpha ?? 1) < 0.5)
                ) {
                    continue;
                }
                const candGovtId = candidateBot?.factionGovt ?? candidateGovt?.id;
                const isEnemyNpc = candGovtId !== undefined
                    && candGovtId !== botState.factionGovt
                    && (candGovtId === FEDERATION_GOVT
                        || candGovtId === AURORAN_GOVT
                        || candGovtId === 130);
                const provoked = provocations
                    ? (
                        isPersonallyProvoked(provocations, botUuid, candidateUuid)
                        || isProvoked(
                            provocations,
                            botState.factionGovt,
                            candidateUuid,
                            (a, b) => (a === b ? 'ally' : 'enemy'),
                        )
                    )
                    : lastAttacker === candidateUuid;
                const isEnemyPlayer = Boolean(
                    candidatePlayer && (
                        provoked
                        || (
                            isConquestMode(candidatePlayer)
                            && (
                                playerConquestFaction(candidatePlayer, candidateShip?.id) !== botState.factionGovt
                                || systemId !== botState.homeSystem
                            )
                        )
                    ),
                );
                const isEnemy = isEnemyNpc || isEnemyPlayer;
                const isAlly = !isEnemy && (
                    candGovtId === botState.factionGovt
                    || Boolean(
                        candidatePlayer
                        && isConquestMode(candidatePlayer)
                        && playerConquestFaction(candidatePlayer, candidateShip?.id) === botState.factionGovt,
                    )
                );
                if (!isEnemy && !isAlly) {
                    continue;
                }

                const dx = candidateMov.position.x - position.x;
                const dy = candidateMov.position.y - position.y;
                const dSq = dx * dx + dy * dy;

                const candMaxHp = (candidateShield?.max ?? 0) + (candidateArmor?.max ?? 0);
                const candCurHp = (candidateShield?.current ?? 0) + (candidateArmor?.current ?? 0);
                const candHpRatio = candMaxHp > 0 ? candCurHp / candMaxHp : 1;
                const candTier = estimateHullCombatTier(candidateShip?.id, candidateBot?.tier);
                const candPower = evaluateShipCombatPower(candTier, candHpRatio, candMaxHp);

                if (isAlly) {
                    if (dSq <= awarenessRadiusSq) {
                        tacticalScratch.friendlyPower += candPower;
                    }
                    continue;
                }

                if (dSq < tacticalScratch.closestEnemyDistSq) {
                    tacticalScratch.closestEnemyDistSq = dSq;
                    tacticalScratch.closestEnemyUuid = candidateUuid;
                }
                if (dSq <= awarenessRadiusSq) {
                    tacticalScratch.enemyPower += candPower;
                    if (candTier > tacticalScratch.maxEnemyTier) {
                        tacticalScratch.maxEnemyTier = candTier;
                    }
                }

                const utility = scoreEnemyTargetUtility({
                    distance: Math.sqrt(dSq),
                    selfTier: selfEffectiveTier,
                    targetTier: candTier,
                    targetHealthRatio: candHpRatio,
                    isSquadTarget: candidateUuid === squadLeaderTargetUuid,
                    isLastAttacker: candidateUuid === lastAttacker,
                });
                if (utility > bestUtility) {
                    bestUtility = utility;
                    tacticalScratch.bestEnemyUuid = candidateUuid;
                }
            }
            return tacticalScratch;
        };

        // 4. Drive Conquest Tactical Utility AI state machine
        // ('gather' -> shipyard upgrade -> 'attack' / 'raid' <-> 'retreat')
        for (const [
            botUuid,
            botState,
            movement,
            physics,
            shipComp,
            targetComp,
            weapons,
            disabled,
            selfShield,
            selfArmor,
            botEntity,
        ] of bots) {
            if (disabled || botEntity.components.has(JumpStateComponent)) {
                continue;
            }
            if (!botState.archetype) {
                botState.archetype = pickConquestArchetype(botState.callsign);
            }
            const tiers = hullTiersForBot(botState.factionGovt, botState.archetype);

            const selfMaxHp = (selfShield?.max ?? 0) + (selfArmor?.max ?? 0);
            const selfCurHp = (selfShield?.current ?? 0) + (selfArmor?.current ?? 0);
            const selfHealthRatio = selfMaxHp > 0 ? selfCurHp / selfMaxHp : 1;
            const selfEffectiveTier = estimateHullCombatTier(shipComp.id, botState.tier);
            const selfPower = evaluateShipCombatPower(selfEffectiveTier, selfHealthRatio, selfMaxHp);

            const squadLeaderTargetUuid = (
                botState.squadLeaderUuid
                && botState.squadLeaderUuid !== botUuid
            )
                ? entities.get(botState.squadLeaderUuid)?.components.get(TargetComponent)?.target
                : undefined;

            const tactical = assessLocalForceBalance(
                botUuid,
                botState,
                movement.position,
                botEntity,
                selfEffectiveTier,
                selfPower,
                squadLeaderTargetUuid,
            );
            const retreatRecommended = shouldBotRetreat({
                selfTier: selfEffectiveTier,
                selfHealthRatio,
                friendlyPower: tactical.friendlyPower,
                enemyPower: tactical.enemyPower,
                maxEnemyTier: tactical.maxEnemyTier,
                isGarrison: botState.garrison,
            });

            let closestPlanet = systemPlanets[0] ?? new Position(0, 0);
            let closestPlanetDistSq = closestPlanet.subtract(movement.position).lengthSquared;
            for (let pIdx = 1; pIdx < systemPlanets.length; pIdx++) {
                const candidatePlanet = systemPlanets[pIdx]!;
                const dSq = candidatePlanet.subtract(movement.position).lengthSquared;
                if (dSq < closestPlanetDistSq) {
                    closestPlanetDistSq = dSq;
                    closestPlanet = candidatePlanet;
                }
            }

            if (botState.mode === 'retreat') {
                if (targetComp.target !== undefined) {
                    targetComp.target = undefined;
                }
                if (weapons) {
                    for (const [, w] of weapons) {
                        if (w.firing) {
                            w.firing = false;
                        }
                    }
                }
                const inHomeSystem = systemId === botState.homeSystem;
                if (!inHomeSystem && otherSystem) {
                    // Outmatched in enemy territory: rally squad to retreat and hyperjump back home!
                    if (botState.squadId && botState.squadLeaderUuid === botUuid) {
                        for (const [allyUuid, allyState, , , , allyTarget, , allyDisabled] of bots) {
                            if (
                                allyUuid !== botUuid
                                && !allyDisabled
                                && allyState.squadId === botState.squadId
                                && allyState.mode !== 'retreat'
                            ) {
                                allyState.mode = 'retreat';
                                allyState.lastModeSwitchAt = time.time;
                                allyTarget.target = undefined;
                            }
                        }
                    }
                    const sourcePos = CONQUEST_SYSTEM_POSITIONS[systemId] ?? [-45, 0];
                    const destPos = CONQUEST_SYSTEM_POSITIONS[otherSystem] ?? [45, 0];
                    const jumpDir = new Vector(
                        destPos[0] - sourcePos[0],
                        destPos[1] - sourcePos[1],
                    ).normalize();

                    if (distanceFromSystemOrigin(movement.position) < 950) {
                        movement.turnTo = jumpDir.angle;
                        movement.accelerating = 1;
                        movement.turnBack = false;
                    } else {
                        botEntity.components.set(JumpStateComponent, {
                            from: systemId,
                            to: otherSystem,
                            phase: 'braking',
                            phaseStartedAt: time.time,
                            transitionAt: time.time + JUMP_BRAKE_MS,
                            requiresAdjacency: false,
                            arrivalSoundPending: false,
                            createdAt: time.time,
                        });
                    }
                    continue;
                }

                // In home system: fall back to Sol/Earth or Aurora for planetary cover and repairs!
                if (closestPlanetDistSq > 150 * 150) {
                    if (physics) {
                        const cmd = approachTarget(
                            movement,
                            { position: closestPlanet, velocity: new Vector(0, 0) },
                            physics,
                            { standoff: 0 },
                        );
                        movement.turnTo = cmd.turnTo ?? closestPlanet.subtract(movement.position).angle;
                        movement.accelerating = 1;
                        movement.turnBack = false;
                    } else {
                        movement.turnTo = closestPlanet.subtract(movement.position).angle;
                        movement.accelerating = 1;
                        movement.turnBack = false;
                    }
                    continue;
                }

                // Docked at home planet: restore shields, armor, and missile/ammo outfits
                if (selfShield) {
                    selfShield.current = selfShield.max;
                }
                if (selfArmor) {
                    selfArmor.current = selfArmor.max;
                }
                const currentShipData = botEntity.components.get(ShipDataComponent);
                if (currentShipData?.outfits) {
                    botEntity.components.set(
                        OutfitsStateComponent,
                        new Map(Object.entries(currentShipData.outfits).map(
                            ([id, count]) => [id, { count }],
                        )),
                    );
                }
                const canAffordUpgrade = botState.gatheredCredits >= upgradeCostForTier(botState.tier);
                if (canAffordUpgrade || tactical.closestEnemyDistSq > 850 * 850 || !retreatRecommended) {
                    botState.mode = 'gather';
                    botState.lastModeSwitchAt = time.time;
                    delete botState.squadId;
                    delete botState.squadLeaderUuid;
                } else {
                    // Hold tight defensive orbit around homeworld while superior threat is nearby
                    const tangentAngle = movement.position.angle.add(Math.PI * 0.5);
                    movement.turnTo = tangentAngle;
                    movement.accelerating = 1;
                    movement.turnBack = false;
                }
                continue;
            }

            if (botState.mode === 'gather') {
                // 1. Check if ready to upgrade hull first: return to Sol / nearest planet
                // so ships refit at a planet shipyard rather than morphing in open space!
                const cost = upgradeCostForTier(botState.tier);
                if (botState.gatheredCredits >= cost) {
                    botState.upgradePending = true;
                    if (closestPlanetDistSq > 150 * 150) {
                        if (targetComp.target !== undefined) {
                            targetComp.target = undefined;
                        }
                        if (weapons) {
                            for (const [, w] of weapons) {
                                if (w.firing) {
                                    w.firing = false;
                                }
                            }
                        }
                        if (physics) {
                            const cmd = approachTarget(
                                movement,
                                { position: closestPlanet, velocity: new Vector(0, 0) },
                                physics,
                                { standoff: 0 },
                            );
                            movement.turnTo = cmd.turnTo ?? closestPlanet.subtract(movement.position).angle;
                            movement.accelerating = 1;
                            movement.turnBack = false;
                        } else {
                            movement.turnTo = closestPlanet.subtract(movement.position).angle;
                            movement.accelerating = 1;
                            movement.turnBack = false;
                        }
                        continue;
                    }

                    botState.upgradePending = false;
                    botState.gatheredCredits -= cost;
                    movement.position = new Position(closestPlanet.x, closestPlanet.y);
                    const launchBearing = Math.random() * 2 * Math.PI;
                    movement.rotation = new Angle(launchBearing);
                    movement.velocity = new Vector(
                        Math.sin(launchBearing) * 45,
                        -Math.cos(launchBearing) * 45,
                    );
                    if (botState.tier + 1 < tiers.length) {
                        botState.tier += 1;
                        const nextShipData = resolveBotShipData(
                            gameData,
                            botState.factionGovt,
                            botState.tier,
                            botState.archetype,
                        );
                        if (nextShipData) {
                            shipComp.id = nextShipData.id;
                            botEntity.name = `${botState.callsign} (${nextShipData.name})`;
                            botEntity.components.set(ShipComponent, { id: nextShipData.id });
                            botEntity.components.set(ShipDataComponent, nextShipData);
                            botEntity.components.set(ShipPhysicsComponent, { ...nextShipData.physics });
                            botEntity.components.set(
                                MovementPhysicsComponent,
                                getShipMovementPhysics(nextShipData.physics, false),
                            );
                            botEntity.components.set(
                                OutfitsStateComponent,
                                new Map(Object.entries(nextShipData.outfits).map(
                                    ([id, count]) => [id, { count }],
                                )),
                            );
                            if (selfShield) {
                                selfShield.max = nextShipData.physics.shield;
                                selfShield.current = nextShipData.physics.shield;
                            }
                            if (selfArmor) {
                                selfArmor.max = nextShipData.physics.armor;
                                selfArmor.current = nextShipData.physics.armor;
                            }
                        }
                    }

                    targetComp.target = undefined;
                    const newEffectiveTier = estimateHullCombatTier(shipComp.id, botState.tier);
                    const outmatchedAfterUpgrade = shouldBotRetreat({
                        selfTier: newEffectiveTier,
                        selfHealthRatio: 1,
                        friendlyPower: tactical.friendlyPower + 2,
                        enemyPower: tactical.enemyPower,
                        maxEnemyTier: tactical.maxEnemyTier,
                        isGarrison: botState.garrison,
                    });

                    if (tactical.bestEnemyUuid && !outmatchedAfterUpgrade) {
                        botState.mode = 'attack';
                        botState.lastModeSwitchAt = time.time;
                        targetComp.target = tactical.bestEnemyUuid;
                    } else if (
                        otherSystem
                        && botState.tier >= 2
                        && !tactical.bestEnemyUuid
                        && Math.random() < 0.65
                    ) {
                        // Upgraded to Tier 2+: organize a cross-system strike raid (solo or squad)!
                        botState.mode = 'raid';
                        botState.lastModeSwitchAt = time.time;
                        if (Math.random() < 0.7) {
                            const newSquadId = uuid();
                            botState.squadId = newSquadId;
                            botState.squadLeaderUuid = botUuid;
                            let recruited = 0;
                            for (const [allyUuid, allyState, , , , allyTarget, , allyDisabled, , , allyEnt] of bots) {
                                if (
                                    allyUuid === botUuid
                                    || allyDisabled
                                    || allyState.garrison
                                    || allyState.factionGovt !== botState.factionGovt
                                    || allyState.tier < 1
                                    || allyState.mode === 'retreat'
                                    || allyEnt.components.has(JumpStateComponent)
                                ) {
                                    continue;
                                }
                                allyState.mode = 'raid';
                                allyState.squadId = newSquadId;
                                allyState.squadLeaderUuid = botUuid;
                                allyState.lastModeSwitchAt = time.time;
                                allyTarget.target = undefined;
                                recruited++;
                                if (recruited >= 2) break;
                            }
                        } else {
                            delete botState.squadId;
                            delete botState.squadLeaderUuid;
                        }
                    } else if (botState.tier >= 2) {
                        botState.mode = 'attack';
                        botState.lastModeSwitchAt = time.time;
                    } else {
                        // Early-game Tier 1 hull: keep gathering credits toward Tier 2 unless enemies attack
                        botState.mode = 'gather';
                        botState.lastModeSwitchAt = time.time;
                    }
                    continue;
                }

                // 2. Tactical threat evaluation while mining:
                // If an enemy approaches within 1,600 units, evaluate force balance!
                // Evade to home planet if outmatched (e.g. Shuttle vs Warship), or attack if winnable.
                if (tactical.closestEnemyDistSq <= 1_600 * 1_600 && tactical.bestEnemyUuid) {
                    if (retreatRecommended) {
                        if (closestPlanetDistSq > 150 * 150) {
                            botState.mode = 'retreat';
                            botState.lastModeSwitchAt = time.time;
                            targetComp.target = undefined;
                            continue;
                        }
                    } else {
                        botState.mode = 'attack';
                        botState.lastModeSwitchAt = time.time;
                        targetComp.target = tactical.bestEnemyUuid;
                        continue;
                    }
                }

                // 3. Physically pull and scoop nearby floating Ore / Salvage packages!
                let nearestOreUuid: string | undefined;
                let nearestOreMov: import('nova_ecs/plugins/movement_plugin').MovementState | undefined;
                let nearestOreDist = 550;
                for (const [oreUuid, ore, oreMov] of ores) {
                    if (!entities.has(oreUuid)) continue;
                    if (
                        ore.spawnedAt !== undefined
                        && time.time - ore.spawnedAt < CONQUEST_ORE_SCATTER_DELAY_MS
                    ) {
                        continue;
                    }
                    const delta = movement.position.subtract(oreMov.position);
                    const dist = delta.length;
                    if (dist <= 34) {
                        botState.gatheredCredits += conquestOreCreditValue(
                            ore.commodity,
                            ore.tons,
                            botState.tier >= 2,
                        );
                        entities.delete(oreUuid);
                        continue;
                    }
                    if (dist <= CONQUEST_BASE_MAGNET_RADIUS + botState.tier * 20) {
                        const pull = delta.normalize().scale(CONQUEST_MAGNET_ACCEL * 0.016);
                        oreMov.velocity = oreMov.velocity.add(pull);
                    }
                    if (dist < nearestOreDist) {
                        nearestOreDist = dist;
                        nearestOreUuid = oreUuid;
                        nearestOreMov = oreMov;
                    }
                }

                if (nearestOreUuid && nearestOreMov && physics) {
                    if (targetComp.target !== undefined) {
                        targetComp.target = undefined;
                    }
                    if (weapons) {
                        for (const [, w] of weapons) {
                            if (w.firing) {
                                w.firing = false;
                            }
                        }
                    }
                    const cmd = approachTarget(movement, nearestOreMov, physics, {
                        standoff: 0,
                    });
                    movement.turnTo = cmd.turnTo ?? nearestOreMov.position.subtract(movement.position).angle;
                    movement.accelerating = 1;
                    movement.turnBack = false;
                } else {
                    // Find closest asteroid to mine
                    let closestRockUuid: string | undefined;
                    let closestRockMov: import('nova_ecs/plugins/movement_plugin').MovementState | undefined;
                    let closestRockDistSq = Infinity;
                    for (const [rockUuid, rockMov] of asteroids) {
                        const dSq = rockMov.position.subtract(movement.position).lengthSquared;
                        if (dSq < closestRockDistSq) {
                            closestRockDistSq = dSq;
                            closestRockUuid = rockUuid;
                            closestRockMov = rockMov;
                        }
                    }

                    if (closestRockUuid && closestRockMov) {
                        if (targetComp.target !== closestRockUuid) {
                            targetComp.target = closestRockUuid;
                        }
                        const toRock = closestRockMov.position.subtract(movement.position);
                        const dist = toRock.length;
                        const effRange = getEffectiveWeaponRange(weapons, gameData) ?? 200;
                        const miningStandoff = Math.min(130, Math.max(85, effRange * 0.58));
                        if (physics) {
                            const cmd = approachTarget(movement, closestRockMov, physics, {
                                standoff: miningStandoff,
                            });
                            movement.turnTo = dist <= Math.max(260, effRange * 1.3)
                                ? toRock.angle
                                : (cmd.turnTo ?? toRock.angle);
                            movement.accelerating = dist > miningStandoff + 25 ? cmd.accelerating : 0;
                            movement.turnBack = cmd.turnBack;
                        }
                        const noseAngleDiff = Math.abs(movement.rotation.distanceTo(toRock.angle).angle);
                        const canMine = dist <= Math.max(220, effRange * 1.1) && noseAngleDiff <= 0.38;
                        if (canMine) {
                            const nextAccum = (miningCreditAccumByBot.get(botUuid) ?? 0)
                                + CONQUEST_BOT_GATHER_CREDIT_RATE_PER_SEC * (time.delta_s || 0.016);
                            if (nextAccum >= 2_500) {
                                botState.gatheredCredits += Math.floor(nextAccum);
                                miningCreditAccumByBot.set(botUuid, nextAccum - Math.floor(nextAccum));
                            } else {
                                miningCreditAccumByBot.set(botUuid, nextAccum);
                            }
                        }
                        if (weapons) {
                            for (const [wId, w] of weapons) {
                                const wData = gameData.data.Weapon.getCached(wId);
                                const isTurret = wData && 'guidance' in wData
                                    && (wData.guidance === 'turret' || wData.guidance === 'beamTurret');
                                const usesAmmo = Boolean(
                                    wData
                                    && wData.ammoType !== 'unlimited'
                                    && wData.ammoType[0] !== 'energy',
                                );
                                if (w.target !== closestRockUuid) {
                                    w.target = closestRockUuid;
                                }
                                const nextFiring = !usesAmmo && (
                                    canMine
                                    || Boolean(isTurret && dist <= Math.max(240, effRange * 1.1))
                                );
                                if (w.firing !== nextFiring) {
                                    w.firing = nextFiring;
                                }
                            }
                        }
                    }
                }
            } else if (botState.mode === 'raid') {
                // If ambushed by an overwhelming force in home system before jumping, retreat to planet
                if (retreatRecommended && systemId === botState.homeSystem) {
                    botState.mode = 'retreat';
                    botState.lastModeSwitchAt = time.time;
                    targetComp.target = undefined;
                    continue;
                }
                // Fly outward along the jump vector (alone or in squad formation)
                // and hyperjump to the opposite system!
                if (!otherSystem) {
                    botState.mode = 'attack';
                    continue;
                }
                targetComp.target = undefined;
                if (weapons) {
                    for (const [, w] of weapons) {
                        w.firing = false;
                    }
                }

                const sourcePos = CONQUEST_SYSTEM_POSITIONS[systemId] ?? [-45, 0];
                const destPos = CONQUEST_SYSTEM_POSITIONS[otherSystem] ?? [45, 0];
                const jumpDir = new Vector(
                    destPos[0] - sourcePos[0],
                    destPos[1] - sourcePos[1],
                ).normalize();

                const isWingman = Boolean(
                    botState.squadId
                    && botState.squadLeaderUuid
                    && botState.squadLeaderUuid !== botUuid
                    && entities.has(botState.squadLeaderUuid),
                );
                if (isWingman) {
                    const leaderEnt = entities.get(botState.squadLeaderUuid!);
                    const leaderMov = leaderEnt?.components.get(MovementStateComponent);
                    const leaderJumping = leaderEnt?.components.has(JumpStateComponent);
                    if (
                        leaderJumping
                        || distanceFromSystemOrigin(movement.position) >= 950
                    ) {
                        botEntity.components.set(JumpStateComponent, {
                            from: systemId,
                            to: otherSystem,
                            phase: 'braking',
                            phaseStartedAt: time.time,
                            transitionAt: time.time + JUMP_BRAKE_MS,
                            requiresAdjacency: false,
                            arrivalSoundPending: false,
                            createdAt: time.time,
                        });
                        continue;
                    }
                    if (leaderMov && physics) {
                        const cmd = approachTarget(movement, leaderMov, physics, {
                            standoff: 110,
                        });
                        movement.turnTo = cmd.turnTo ?? jumpDir.angle;
                        movement.accelerating = 1;
                        movement.turnBack = false;
                        continue;
                    }
                }

                // Solo raider or Squad Leader: fly along jumpDir until >= 980 units from origin
                if (distanceFromSystemOrigin(movement.position) < 980) {
                    movement.turnTo = jumpDir.angle;
                    movement.accelerating = 1;
                    movement.turnBack = false;
                } else {
                    botEntity.components.set(JumpStateComponent, {
                        from: systemId,
                        to: otherSystem,
                        phase: 'braking',
                        phaseStartedAt: time.time,
                        transitionAt: time.time + JUMP_BRAKE_MS,
                        requiresAdjacency: false,
                        arrivalSoundPending: false,
                        createdAt: time.time,
                    });
                    // Trigger hyperjump for any squad wingmen in this squad!
                    if (botState.squadId) {
                        for (const [allyUuid, allyState, , , , , , allyDisabled, , , allyEnt] of bots) {
                            if (
                                allyUuid !== botUuid
                                && !allyDisabled
                                && allyState.squadId === botState.squadId
                                && !allyEnt.components.has(JumpStateComponent)
                            ) {
                                allyEnt.components.set(JumpStateComponent, {
                                    from: systemId,
                                    to: otherSystem,
                                    phase: 'braking',
                                    phaseStartedAt: time.time,
                                    transitionAt: time.time + JUMP_BRAKE_MS,
                                    requiresAdjacency: false,
                                    arrivalSoundPending: false,
                                    createdAt: time.time,
                                });
                            }
                        }
                    }
                }
            } else {
                // 'attack' mode: check Tactical Utility AI retreat condition first!
                if (retreatRecommended) {
                    botState.mode = 'retreat';
                    botState.lastModeSwitchAt = time.time;
                    targetComp.target = undefined;
                    if (botState.squadId && botState.squadLeaderUuid === botUuid) {
                        for (const [allyUuid, allyState, , , , allyTarget, , allyDisabled] of bots) {
                            if (
                                allyUuid !== botUuid
                                && !allyDisabled
                                && allyState.squadId === botState.squadId
                                && allyState.mode !== 'retreat'
                            ) {
                                allyState.mode = 'retreat';
                                allyState.lastModeSwitchAt = time.time;
                                allyTarget.target = undefined;
                            }
                        }
                    }
                    continue;
                }

                // Select highest-utility hostile target (includes squad focus-fire bonus)
                const chosenEnemy = tactical.bestEnemyUuid ?? tactical.closestEnemyUuid;

                if (chosenEnemy) {
                    if (targetComp.target !== chosenEnemy) {
                        targetComp.target = chosenEnemy;
                    }
                    lastEnemySeenByBot.set(botUuid, time.time);
                } else {
                    // Clear any disabled or dead target immediately so bots
                    // never hover motionless around a disabled hulk.
                    if (targetComp.target !== undefined) {
                        targetComp.target = undefined;
                    }
                    if (weapons) {
                        for (const [, w] of weapons) {
                            if (w.firing) {
                                w.firing = false;
                            }
                        }
                    }
                    const idleElapsed = time.time - (lastEnemySeenByBot.get(botUuid) ?? botState.lastModeSwitchAt);
                    if (!botState.garrison && idleElapsed >= CONQUEST_BOT_RAID_IDLE_MS) {
                        // No enemies in sight: either jump to the rival system to raid (if Tier 2+),
                        // or return to mining asteroids if in home system.
                        const inHomeSystem = systemId === botState.homeSystem;
                        if (
                            otherSystem
                            && (!inHomeSystem || (botState.tier >= 2 && Math.random() < 0.45))
                        ) {
                            botState.mode = 'raid';
                            botState.lastModeSwitchAt = time.time;
                            lastEnemySeenByBot.set(botUuid, time.time);
                        } else {
                            botState.mode = 'gather';
                            botState.lastModeSwitchAt = time.time;
                            lastEnemySeenByBot.set(botUuid, time.time);
                            delete botState.squadId;
                            delete botState.squadLeaderUuid;
                        }
                    } else {
                        // Active orbital patrol around the system center while
                        // scanning for threats.
                        const distFromOrigin = movement.position.length;
                        if (distFromOrigin > 520) {
                            movement.turnTo = new Position(0, 0).subtract(movement.position).angle;
                            movement.accelerating = 1;
                            movement.turnBack = false;
                        } else if (distFromOrigin < 220) {
                            movement.turnTo = movement.position.angle;
                            movement.accelerating = 1;
                            movement.turnBack = false;
                        } else {
                            const tangentAngle = movement.position.angle.add(Math.PI * 0.5);
                            movement.turnTo = tangentAngle;
                            movement.accelerating = 1;
                            movement.turnBack = false;
                        }
                    }
                }
            }
        }
    },
});

/**
 * When any ship is destroyed in a Conquest pocket system, drop floating Salvage
 * Ore chunks proportional to the ship's hull cost so kills reward nearby
 * fighters directly via their auto-collector!
 */
const ConquestSalvageDropSystem = new System({
    name: 'ConquestSalvageDrop',
    events: [DeathEvent],
    args: [
        ShipComponent,
        Optional(ShipDataComponent),
        Optional(ConquestBotComponent),
        Optional(LastAttackerComponent),
        MovementStateComponent,
        Entities,
        PlatformResource,
        SystemIdResource,
        EntityBudgetResource,
        ConquestPlayersQuery,
        Optional(TimeResource),
    ] as const,
    step(_ship, shipData, victimBot, lastAttackerUuid, movement, entities, platform, systemId, budget, players, time) {
        if (platform !== 'node' || !isConquestPocketSystem(systemId)) {
            return;
        }
        const hasConquestPlayer = players.some(([, state]) => isConquestMode(state));
        if (!hasConquestPlayer) {
            return;
        }
        const cost = shipData?.cost ?? 30_000;
        const bounty = Math.max(4_500, Math.round(cost * 0.35));

        // Award direct Combat Kill Bounty to the killer (Player or Conquest Bot)
        if (lastAttackerUuid) {
            const killerEnt = entities.get(lastAttackerUuid);
            const killerPlayer = killerEnt?.components.get(PlayerStateComponent);
            const killerBot = killerEnt?.components.get(ConquestBotComponent);
            if (killerEnt && killerPlayer && isConquestMode(killerPlayer)) {
                killerPlayer.credits = Math.max(0, (killerPlayer.credits ?? 0) + bounty);
                killerPlayer.kills = (killerPlayer.kills ?? 0) + 1;
                const authority = killerEnt.components.get(CombatAuthorityComponent);
                if (authority && !authority.retired) {
                    authority.state.credits = killerPlayer.credits;
                    authority.commit();
                    authority.project(killerEnt);
                }
                const victimLabel = victimBot?.callsign
                    ? `${victimBot.callsign} (${shipData?.name ?? 'Warship'})`
                    : (shipData?.name ?? 'Enemy Ship');
                killerEnt.components.set(BoardingNoticeComponent, {
                    text: `💥 Destroyed ${victimLabel} — +${bounty.toLocaleString()} cr bounty (+Salvage dropped!)`,
                });
            } else if (killerBot) {
                killerBot.gatheredCredits += bounty;
            }
        }

        const totalTons = Math.max(3, Math.min(24, Math.round(cost / 12_000)));
        const chunks = Math.min(3, totalTons);
        const tonsPerChunk = Math.max(1, Math.floor(totalTons / chunks));
        enforceOreEntityCap(entities, chunks);
        for (let i = 0; i < chunks; i++) {
            const origin = new Position(
                movement.position.x + (Math.random() - 0.5) * 30,
                movement.position.y + (Math.random() - 0.5) * 30,
            );
            const salvage = makeOre('nova:140', 'Salvage Core', tonsPerChunk, origin, undefined, time?.time);
            if (!reserveEntity(budget, salvage, 'asteroid')) {
                break;
            }
            salvage.components.set(MultiplayerData, { owner: 'server' });
            entities.set(uuid(), salvage);
        }
    },
});

export const ConquestModePlugin: Plugin = {
    name: 'ConquestModePlugin',
    build(world) {
        resetConquestRuntimeState();
        const deltaMaker = world.resources.get(DeltaResource);
        if (deltaMaker) {
            deltaMaker.addComponent(ConquestBotComponent, {
                componentType: ConquestBotStateCodec,
            });
        }
        world.addComponent(ConquestBotComponent);
        world.addSystem(ConquestBotLifecycleSystem);
        world.addSystem(ConquestSalvageDropSystem);
        world.addSystem(VellosFuelRegenSystem);
    },
    remove(world) {
        resetConquestRuntimeState();
        world.removeSystem(VellosFuelRegenSystem);
        world.removeSystem(ConquestSalvageDropSystem);
        world.removeSystem(ConquestBotLifecycleSystem);
    },
};

const VELLOS_SHIP_IDS = new Set(['nova:173', 'nova:174', 'nova:175', 'nova:381', 'nova:382', 'nova:383']);

const VELLOS_FUEL_REGEN_PER_SEC: Readonly<Record<string, number>> = {
    'nova:173': 90,
    'nova:381': 90,
    'nova:174': 180,
    'nova:382': 180,
    'nova:175': 800,
    'nova:383': 800,
};

/**
 * Regenerates jump/weapon energy (`playerState.fuel`) for Vell-os psychic ships
 * and ships with positive `energyRecharge` so fuel-powered psychic beams and
 * hyperspace jumps work continuously in flight.
 */
const VellosFuelRegenSystem = new System({
    name: 'VellosFuelRegen',
    args: [
        PlayerStateComponent,
        ShipComponent,
        Optional(ShipDataComponent),
        Optional(ShipPhysicsComponent),
        TimeResource,
        GetEntity,
    ] as const,
    step(playerState, ship, shipData, shipPhysics, time, entity) {
        const vellosRegen = VELLOS_FUEL_REGEN_PER_SEC[ship.id];
        const rawEnergyRecharge = shipPhysics?.energyRecharge ?? 0;
        const finiteEnergyRecharge = Number.isFinite(rawEnergyRecharge) ? rawEnergyRecharge : 0;
        const regenPerSec = vellosRegen !== undefined
            ? Math.max(vellosRegen, finiteEnergyRecharge)
            : finiteEnergyRecharge;
        if (regenPerSec <= 0) {
            return;
        }
        const maxFuel = Math.max(
            shipData?.fuelCapacity ?? 0,
            shipPhysics?.energy ?? 0,
            vellosRegen !== undefined ? 1_000 : 0,
        );
        const currentFuel = playerState.fuel ?? 0;
        if (currentFuel >= maxFuel) {
            return;
        }
        const nextFuel = Math.min(
            maxFuel,
            currentFuel + regenPerSec * (time.delta_s || 0.016),
        );
        playerState.fuel = nextFuel;
        if (playerState.combatResources) {
            playerState.combatResources.fuel = nextFuel;
        }
        const authority = entity.components.get(CombatAuthorityComponent);
        if (authority && !authority.retired) {
            authority.regenFuel(nextFuel);
        }
    },
});
