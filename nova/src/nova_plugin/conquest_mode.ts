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
import { AsteroidComponent, makeOre, OreComponent } from './asteroid_plugin';
import { DeathEvent, DisabledComponent } from './death_plugin';
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
} from './npc_components';
import { FollowAI, makeNpc } from './npc_plugin';
import { OutfitsStateComponent } from './outfit_plugin';
import { PlatformResource } from './platform_plugin';
import { PlayerStateComponent } from './player_state';
import { ShipComponent, ShipDataComponent, ShipPhysicsComponent } from './ship_plugin';
import { CombatAuthorityComponent } from './combat_resources';
import { SystemIdResource } from './system_id_resource';
import { TargetComponent } from './target_component';
import { WeaponsStateComponent } from './weapons_state';

import {
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
    FEDERATION_GOVT,
    FEDERATION_UPGRADE_TIERS,
    isConquestMode,
    isConquestPocketSystem,
    MAX_CONQUEST_BOTS_PER_SYSTEM,
    oppositeConquestSystem,
    pickUniqueConquestCallsign,
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
] as const, 'ConquestShips');

function upgradeCostForTier(tier: number): number {
    return CONQUEST_BOT_UPGRADE_BASE_COST * (tier + 1);
}

export function hullTiersForGovt(govt: number): readonly string[] {
    return govt === AURORAN_GOVT
        ? AURORAN_UPGRADE_TIERS
        : FEDERATION_UPGRADE_TIERS;
}

const nextConquestBotSpawnBySystem = new Map<string, number>();
const nextRivalRaidWaveBySystem = new Map<string, number>();
const CONQUEST_RIVAL_RAID_WAVE_INTERVAL_MS = 28_000;

async function spawnConquestBotEntity(
    gameData: import('novadatainterface/GameDataInterface').GameDataInterface,
    budget: import('./entity_budget').EntityBudget,
    botState: ConquestBotState,
    position: Position,
    rotation = new Angle(Math.random() * 2 * Math.PI),
    velocity = new Vector(0, 0),
    arrivingFrom?: { from: string; to: string; now: number },
): Promise<Entity | undefined> {
    const tiers = hullTiersForGovt(botState.factionGovt);
    const clampedTier = Math.max(0, Math.min(tiers.length - 1, botState.tier));
    botState.tier = clampedTier;
    const shipId = tiers[clampedTier];
    const shipData = await gameData.data.Ship.get(shipId);
    const bot = makeNpc(shipData);
    if (!reserveEntity(budget, bot, 'ship')) {
        return undefined;
    }
    // ConquestBotLifecycleSystem manages targeting; prevent ChooseRandomTargetAI
    // from wiping out asteroid targets every frame.
    bot.components.delete(ChooseRandomTargetComponent);
    bot.name = `${botState.callsign} (${shipData.name})`;

    const mov = bot.components.get(MovementStateComponent);
    if (mov) {
        mov.position = position;
        mov.rotation = rotation;
        mov.velocity = velocity;
    }
    bot.components
        .set(GovtComponent, { id: botState.factionGovt })
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

const ConquestBotLifecycleSystem = new AsyncSystem({
    name: 'ConquestBotLifecycle',
    after: [FollowAI],
    exclusive: true,
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
    ] as const,
    async step(
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
    ) {
        if (platform !== 'node' || !isConquestPocketSystem(systemId)) {
            return;
        }
        const hasConquestPlayer = players.some(([, state]) =>
            isConquestMode(state));
        if (!hasConquestPlayer) {
            return;
        }

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
                const bot = await spawnConquestBotEntity(
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

        // 2. Spawn Home Faction Miners/Defenders up to MAX_CONQUEST_BOTS_PER_SYSTEM
        const nextSpawnAt = nextConquestBotSpawnBySystem.get(systemId) ?? 0;
        const homeBotsCount = bots.filter(([, b]) => b.factionGovt === homeGovt).length;
        if (
            bots.length < MAX_CONQUEST_BOTS_PER_SYSTEM
            && homeBotsCount < MAX_CONQUEST_BOTS_PER_SYSTEM - 2
            && time.time >= nextSpawnAt
        ) {
            nextConquestBotSpawnBySystem.set(
                systemId,
                time.time + CONQUEST_BOT_SPAWN_INTERVAL_MS,
            );
            const callsign = pickUniqueConquestCallsign(homeGovt, usedCallsigns);
            usedCallsigns.add(callsign);
            const angle = Math.random() * 2 * Math.PI;
            const dist = 450 + Math.random() * 750;
            const pos = new Position(Math.cos(angle) * dist, Math.sin(angle) * dist);
            try {
                const bot = await spawnConquestBotEntity(
                    gameData,
                    budget,
                    {
                        callsign,
                        mode: 'gather',
                        factionGovt: homeGovt,
                        homeSystem: systemId,
                        tier: 0,
                        gatheredCredits: 0,
                        lastModeSwitchAt: time.time,
                        upgradePending: false,
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
                    const bot = await spawnConquestBotEntity(
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
            maxRange = Infinity,
        ): string | undefined => {
            let closestEnemy: string | undefined;
            let closestDistSq = maxRange * maxRange;
            for (const [
                candidateUuid,
                candidateMov,
                ,
                ,
                candidateGovt,
                candidatePlayer,
                candidateDisabled,
                candidateBot,
            ] of ships) {
                if (candidateUuid === botUuid || candidateDisabled) {
                    continue;
                }
                const candGovtId = candidateBot?.factionGovt ?? candidateGovt?.id;
                const isEnemyNpc = candGovtId !== undefined
                    && candGovtId !== botState.factionGovt
                    && (candGovtId === FEDERATION_GOVT
                        || candGovtId === AURORAN_GOVT
                        || candGovtId === 130);
                const isEnemyPlayer = Boolean(
                    candidatePlayer
                    && isConquestMode(candidatePlayer)
                    && systemId !== botState.homeSystem,
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
                // Self-defense if an enemy raider gets close
                const nearbyThreat = findClosestEnemy(
                    botUuid,
                    botState,
                    movement.position,
                    650,
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
                        if (physics) {
                            const cmd = approachTarget(movement, closestRockMov, physics, {
                                standoff: 190,
                            });
                            movement.turnTo = dist <= 420
                                ? toRock.angle
                                : (cmd.turnTo ?? toRock.angle);
                            movement.accelerating = dist > 210 ? cmd.accelerating : 0;
                            movement.turnBack = cmd.turnBack;
                        }
                        if (dist <= 450) {
                            botState.gatheredCredits +=
                                CONQUEST_BOT_GATHER_CREDIT_RATE_PER_SEC * (time.delta_s || 0.016);
                            if (weapons) {
                                for (const [, w] of weapons) {
                                    w.firing = true;
                                    w.target = closestRockUuid;
                                }
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
                        try {
                            const nextShipData = await gameData.data.Ship.get(nextHullId);
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
                        } catch {
                            // Keep current hull if next tier is unavailable
                        }
                    }

                    targetComp.target = undefined;
                    const enemyInSystem = findClosestEnemy(
                        botUuid,
                        botState,
                        movement.position,
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
                    if (leaderTarget && entities.has(leaderTarget)) {
                        chosenEnemy = leaderTarget;
                    }
                }
                if (!chosenEnemy) {
                    chosenEnemy = findClosestEnemy(
                        botUuid,
                        botState,
                        movement.position,
                    );
                }

                if (chosenEnemy) {
                    targetComp.target = chosenEnemy;
                    botState.lastModeSwitchAt = time.time;
                } else if (time.time - botState.lastModeSwitchAt >= CONQUEST_BOT_RAID_IDLE_MS) {
                    // No enemies in sight: either jump to the rival system to raid,
                    // or return to mining asteroids if in home system and below max tier.
                    const inHomeSystem = systemId === botState.homeSystem;
                    if (
                        otherSystem
                        && (!inHomeSystem || (botState.tier >= 1 && Math.random() < 0.45))
                    ) {
                        botState.mode = 'raid';
                        botState.lastModeSwitchAt = time.time;
                        targetComp.target = undefined;
                    } else {
                        botState.mode = 'gather';
                        botState.lastModeSwitchAt = time.time;
                        delete botState.squadId;
                        delete botState.squadLeaderUuid;
                        targetComp.target = undefined;
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
        MovementStateComponent,
        Entities,
        PlatformResource,
        SystemIdResource,
        EntityBudgetResource,
        ConquestPlayersQuery,
    ] as const,
    step(_ship, shipData, movement, entities, platform, systemId, budget, players) {
        if (platform !== 'node' || !isConquestPocketSystem(systemId)) {
            return;
        }
        const hasConquestPlayer = players.some(([, state]) => isConquestMode(state));
        if (!hasConquestPlayer) {
            return;
        }
        const cost = shipData?.cost ?? 30_000;
        const totalTons = Math.max(3, Math.min(24, Math.round(cost / 12_000)));
        const chunks = Math.min(3, totalTons);
        const tonsPerChunk = Math.max(1, Math.floor(totalTons / chunks));
        for (let i = 0; i < chunks; i++) {
            const origin = new Position(
                movement.position.x + (Math.random() - 0.5) * 30,
                movement.position.y + (Math.random() - 0.5) * 30,
            );
            const salvage = makeOre('nova:140', 'Salvage Core', tonsPerChunk, origin);
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
