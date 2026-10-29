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
import { PlatformResource } from './platform_plugin';
import { PlayerStateComponent } from './player_state';
import { ShipComponent, ShipDataComponent, ShipPhysicsComponent } from './ship_plugin';
import { CombatAuthorityComponent } from './combat_resources';
import { SystemIdResource } from './system_id_resource';
import { TargetComponent } from './target_component';
import { WeaponsStateComponent } from './weapons_state';

import {
    AURORAN_GARRISON_TIERS,
    AURORAN_GOVT,
    AURORAN_UPGRADE_TIERS,
    CONQUEST_AURORA_SYSTEM,
    CONQUEST_BASE_MAGNET_RADIUS,
    CONQUEST_BOT_GATHER_CREDIT_RATE_PER_SEC,
    CONQUEST_BOT_RAID_IDLE_MS,
    CONQUEST_BOT_SPAWN_INTERVAL_MS,
    CONQUEST_BOT_UPGRADE_BASE_COST,
    CONQUEST_MAGNET_ACCEL,
    CONQUEST_ORE_SCATTER_DELAY_MS,
    CONQUEST_SOL_SYSTEM,
    CONQUEST_SYSTEM_POSITIONS,
    ConquestBotComponent,
    ConquestBotState,
    ConquestBotStateCodec,
    conquestOreCreditValue,
    drainConquestBotTransfers,
    FEDERATION_GARRISON_TIERS,
    FEDERATION_GOVT,
    FEDERATION_UPGRADE_TIERS,
    isConquestMode,
    isConquestPocketSystem,
    MAX_CONQUEST_BOTS_PER_SYSTEM,
    oppositeConquestSystem,
    pickUniqueConquestCallsign,
    playerConquestFaction,
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
] as const, 'ConquestShips');

function upgradeCostForTier(tier: number): number {
    return CONQUEST_BOT_UPGRADE_BASE_COST * (tier + 1);
}

export function hullTiersForGovt(govt: number): readonly string[] {
    return govt === AURORAN_GOVT
        ? AURORAN_UPGRADE_TIERS
        : FEDERATION_UPGRADE_TIERS;
}

export function garrisonTiersForGovt(govt: number): readonly number[] {
    return govt === AURORAN_GOVT
        ? AURORAN_GARRISON_TIERS
        : FEDERATION_GARRISON_TIERS;
}

const nextConquestBotSpawnBySystem = new Map<string, number>();
const nextRivalRaidWaveBySystem = new Map<string, number>();
const lastEnemySeenByBot = new Map<string, number>();
const miningCreditAccumByBot = new Map<string, number>();
const CONQUEST_RIVAL_RAID_WAVE_INTERVAL_MS = 28_000;
const warmedGameDataSets = new WeakSet<object>();

function warmConquestHulls(
    gameData: import('novadatainterface/GameDataInterface').GameDataInterface,
): void {
    if (warmedGameDataSets.has(gameData)) {
        return;
    }
    warmedGameDataSets.add(gameData);
    for (const id of [...FEDERATION_UPGRADE_TIERS, ...AURORAN_UPGRADE_TIERS]) {
        void gameData.data.Ship.get(id).catch(() => {});
    }
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
    const tiers = hullTiersForGovt(botState.factionGovt);
    const clampedTier = Math.max(0, Math.min(tiers.length - 1, botState.tier));
    botState.tier = clampedTier;
    const shipId = tiers[clampedTier];
    const shipData = gameData.data.Ship.getCached(shipId);
    if (!shipData) {
        void gameData.data.Ship.get(shipId).catch(() => {});
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
        provocations,
    ) {
        if (platform !== 'node' || !isConquestPocketSystem(systemId)) {
            return;
        }
        const hasConquestPlayer = players.some(([, state]) =>
            isConquestMode(state));
        if (!hasConquestPlayer) {
            return;
        }
        warmConquestHulls(gameData);

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
                const state: ConquestBotState = {
                    ...transfer.botState,
                    callsign: usedCallsigns.has(transfer.botState.callsign)
                        ? pickUniqueConquestCallsign(transfer.botState.factionGovt, usedCallsigns)
                        : transfer.botState.callsign,
                    mode: 'attack',
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

        // 2. Maintain the Homeworld Defense Fleet Garrison (Carriers, Destroyers/Cruisers,
        // Gunboats, and Patrol Boats) AND spawn Home Faction Miners/Raiders up to MAX_CONQUEST_BOTS_PER_SYSTEM
        const garrisonTiers = garrisonTiersForGovt(homeGovt);
        const activeGarrisonTiers = bots
            .filter(([, b]) => b.factionGovt === homeGovt && b.garrison)
            .map(([, b]) => b.tier);
        const missingGarrisonTier = garrisonTiers.find(t => !activeGarrisonTiers.includes(t));

        const nextSpawnAt = nextConquestBotSpawnBySystem.get(systemId) ?? 0;
        const homeBotsCount = bots.filter(([, b]) => b.factionGovt === homeGovt).length;
        // Spawn missing garrison capital ships immediately on room startup or after respawn interval
        const shouldSpawnGarrison = missingGarrisonTier !== undefined
            && (activeGarrisonTiers.length === 0 || time.time >= nextSpawnAt);

        if (
            shouldSpawnGarrison
            || (
                bots.length < MAX_CONQUEST_BOTS_PER_SYSTEM
                && homeBotsCount < MAX_CONQUEST_BOTS_PER_SYSTEM - 1
                && time.time >= nextSpawnAt
            )
        ) {
            nextConquestBotSpawnBySystem.set(
                systemId,
                time.time + (shouldSpawnGarrison && activeGarrisonTiers.length < garrisonTiers.length - 1
                    ? 400
                    : CONQUEST_BOT_SPAWN_INTERVAL_MS),
            );
            const isGarrison = missingGarrisonTier !== undefined;
            const callsign = pickUniqueConquestCallsign(homeGovt, usedCallsigns);
            usedCallsigns.add(callsign);
            const angle = Math.random() * 2 * Math.PI;
            const dist = isGarrison
                ? 240 + Math.random() * 320
                : 480 + Math.random() * 750;
            const pos = new Position(Math.cos(angle) * dist, Math.sin(angle) * dist);
            const initialTier = isGarrison ? missingGarrisonTier! : 0;
            try {
                const bot = spawnConquestBotEntity(
                    gameData,
                    budget,
                    {
                        callsign,
                        mode: isGarrison ? 'attack' : 'gather',
                        factionGovt: homeGovt,
                        homeSystem: systemId,
                        tier: initialTier,
                        gatheredCredits: 0,
                        lastModeSwitchAt: time.time,
                        upgradePending: false,
                        ...(isGarrison ? { garrison: true } : {}),
                    },
                    pos,
                );
                if (bot) {
                    entities.set(uuid(), bot);
                }
            } catch {
                // Ignore missing ship resource in minimal test fixtures
            }
        }

        // 3. Periodic Rival Faction Cross-System Raid Waves (Solo or 2-3 Ship Strike Group)
        // Ensures that even when no player is inside the opposite system room,
        // upgraded rival bots jump into this system from hyperspace alone or in a group!
        const nextRaidAt = nextRivalRaidWaveBySystem.get(systemId)
            ?? (time.time + 14_000);
        if (!nextRivalRaidWaveBySystem.has(systemId)) {
            nextRivalRaidWaveBySystem.set(systemId, nextRaidAt);
        }
        const activeRivalBots = bots.filter(([, b]) => b.factionGovt === rivalGovt).length;
        if (
            otherSystem
            && activeRivalBots < 3
            && bots.length < MAX_CONQUEST_BOTS_PER_SYSTEM + 2
            && time.time >= nextRaidAt
        ) {
            nextRivalRaidWaveBySystem.set(
                systemId,
                time.time + CONQUEST_RIVAL_RAID_WAVE_INTERVAL_MS,
            );
            // 45% solo raider, 55% coordinated 2-3 ship strike group
            const groupSize = Math.random() < 0.45 ? 1 : (Math.random() < 0.65 ? 2 : 3);
            const squadId = groupSize > 1 ? uuid() : undefined;
            const rivalTiers = hullTiersForGovt(rivalGovt);
            const baseTier = Math.min(
                rivalTiers.length - 1,
                1 + Math.floor(Math.random() * Math.min(4, rivalTiers.length - 1)),
            );
            const sourcePos = CONQUEST_SYSTEM_POSITIONS[otherSystem] ?? [45, 0];
            const destPos = CONQUEST_SYSTEM_POSITIONS[systemId] ?? [-45, 0];
            const baseLateralY = (Math.random() - 0.5) * 700;
            let leaderUuid: string | undefined;

            for (let i = 0; i < groupSize; i++) {
                const callsign = pickUniqueConquestCallsign(rivalGovt, usedCallsigns);
                usedCallsigns.add(callsign);
                const tier = i === 0
                    ? baseTier
                    : Math.max(0, baseTier - (Math.random() < 0.5 ? 1 : 0));
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

        // Helper to find closest hostile ship for a given bot
        const findClosestEnemy = (
            botUuid: string,
            botState: ConquestBotState,
            position: Position,
            botEntity: Entity,
            maxRange = Infinity,
        ): string | undefined => {
            let closestEnemy: string | undefined;
            let closestDistSq = maxRange * maxRange;
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
                if (!isEnemyNpc && !isEnemyPlayer) {
                    continue;
                }
                const dSq = candidateMov.position.subtract(position).lengthSquared;
                if (dSq < closestDistSq) {
                    closestDistSq = dSq;
                    closestEnemy = candidateUuid;
                }
            }
            return closestEnemy;
        };

        // 4. Drive Conquest AI state machine ('gather' -> upgrade -> 'attack' / 'raid')
        for (const [
            botUuid,
            botState,
            movement,
            physics,
            shipComp,
            targetComp,
            weapons,
            disabled,
            botEntity,
        ] of bots) {
            if (disabled || botEntity.components.has(JumpStateComponent)) {
                continue;
            }
            const tiers = hullTiersForGovt(botState.factionGovt);

            if (botState.mode === 'gather') {
                // Self-defense if an enemy raider or rival player enters range
                const nearbyThreat = findClosestEnemy(
                    botUuid,
                    botState,
                    movement.position,
                    botEntity,
                    1_800,
                );
                if (nearbyThreat) {
                    botState.mode = 'attack';
                    botState.lastModeSwitchAt = time.time;
                    targetComp.target = nearbyThreat;
                    continue;
                }

                // Physically pull and scoop nearby floating Ore / Salvage packages!
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
                    targetComp.target = undefined;
                    if (weapons) {
                        for (const [, w] of weapons) {
                            w.firing = false;
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
                        targetComp.target = closestRockUuid;
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
                                w.target = closestRockUuid;
                                w.firing = !usesAmmo && (
                                    canMine
                                    || Boolean(isTurret && dist <= Math.max(240, effRange * 1.1))
                                );
                            }
                        }
                    }
                }

                // Check if ready to upgrade hull
                const cost = upgradeCostForTier(botState.tier);
                if (botState.gatheredCredits >= cost) {
                    botState.gatheredCredits -= cost;
                    if (botState.tier + 1 < tiers.length) {
                        botState.tier += 1;
                        const nextHullId = tiers[botState.tier];
                        const nextShipData = gameData.data.Ship.getCached(nextHullId);
                        if (nextShipData) {
                            shipComp.id = nextShipData.id;
                            botEntity.name = `${botState.callsign} (${nextShipData.name})`;
                            botEntity.components.set(ShipComponent, { id: nextShipData.id });
                            botEntity.components.set(ShipDataComponent, nextShipData);
                            botEntity.components.set(
                                OutfitsStateComponent,
                                new Map(Object.entries(nextShipData.outfits).map(
                                    ([id, count]) => [id, { count }],
                                )),
                            );
                            const shield = botEntity.components.get(ShieldComponent);
                            if (shield) {
                                shield.max = nextShipData.physics.shield;
                                shield.current = nextShipData.physics.shield;
                            }
                            const armor = botEntity.components.get(ArmorComponent);
                            if (armor) {
                                armor.max = nextShipData.physics.armor;
                                armor.current = nextShipData.physics.armor;
                            }
                        } else {
                            void gameData.data.Ship.get(nextHullId).catch(() => {});
                        }
                    }

                    targetComp.target = undefined;
                    const enemyInSystem = findClosestEnemy(
                        botUuid,
                        botState,
                        movement.position,
                        botEntity,
                    );
                    if (enemyInSystem) {
                        botState.mode = 'attack';
                        botState.lastModeSwitchAt = time.time;
                        targetComp.target = enemyInSystem;
                    } else if (
                        otherSystem
                        && botState.tier >= 1
                        && Math.random() < 0.65
                    ) {
                        // Decide to hyperjump to the rival system to attack (alone or in a group)!
                        botState.mode = 'raid';
                        botState.lastModeSwitchAt = time.time;
                        if (Math.random() < 0.55) {
                            const newSquadId = uuid();
                            botState.squadId = newSquadId;
                            botState.squadLeaderUuid = botUuid;
                            let recruited = 0;
                            for (const [allyUuid, allyState, , , , allyTarget, , allyDisabled, allyEnt] of bots) {
                                if (
                                    allyUuid === botUuid
                                    || allyDisabled
                                    || allyState.garrison
                                    || allyState.factionGovt !== botState.factionGovt
                                    || allyState.tier < 1
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
                    } else {
                        botState.mode = 'attack';
                        botState.lastModeSwitchAt = time.time;
                    }
                }
            } else if (botState.mode === 'raid') {
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
                        for (const [allyUuid, allyState, , , , , , allyDisabled, allyEnt] of bots) {
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
                // 'attack' mode: coordinate with squad leader if present, or engage closest enemy
                let chosenEnemy: string | undefined;
                if (
                    botState.squadLeaderUuid
                    && botState.squadLeaderUuid !== botUuid
                ) {
                    const leaderTarget = entities.get(botState.squadLeaderUuid)
                        ?.components.get(TargetComponent)?.target;
                    const leaderTargetEnt = leaderTarget ? entities.get(leaderTarget) : undefined;
                    if (
                        leaderTarget
                        && leaderTargetEnt
                        && !leaderTargetEnt.components.has(DisabledComponent)
                        && !leaderTargetEnt.components.has(DestructionStartedComponent)
                        && !leaderTargetEnt.components.has(PlayerDeathComponent)
                    ) {
                        chosenEnemy = leaderTarget;
                    }
                }
                if (!chosenEnemy) {
                    chosenEnemy = findClosestEnemy(
                        botUuid,
                        botState,
                        movement.position,
                        botEntity,
                    );
                }

                if (chosenEnemy) {
                    targetComp.target = chosenEnemy;
                    lastEnemySeenByBot.set(botUuid, time.time);
                } else {
                    // Clear any disabled or dead target immediately so bots
                    // never hover motionless around a disabled hulk.
                    targetComp.target = undefined;
                    if (weapons) {
                        for (const [, w] of weapons) {
                            w.firing = false;
                        }
                    }
                    const idleElapsed = time.time - (lastEnemySeenByBot.get(botUuid) ?? botState.lastModeSwitchAt);
                    if (!botState.garrison && idleElapsed >= CONQUEST_BOT_RAID_IDLE_MS) {
                        // No enemies in sight: either jump to the rival system to raid,
                        // or return to mining asteroids if in home system.
                        const inHomeSystem = systemId === botState.homeSystem;
                        if (
                            otherSystem
                            && (!inHomeSystem || (botState.tier >= 1 && Math.random() < 0.45))
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
                        // scanning for threats (Garrison fleet or post-combat sweep).
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
