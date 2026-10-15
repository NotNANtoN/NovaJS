import { Entities, GetEntity, GetWorld, UUID } from 'nova_ecs/arg_types';
import { AsyncSystem } from 'nova_ecs/async_system';
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from 'nova_ecs/world';
import { SystemData } from 'novadatainterface/SystemData';
import { v4 as uuid } from 'uuid';
import { AsteroidComponent, makeOre, OreComponent } from './asteroid_plugin';
import { DeathEvent, DisabledComponent } from './death_plugin';
import { EntityBudgetResource, reserveEntity } from './entity_budget';
import { GameDataResource } from './game_data_resource';
import { ArmorComponent, ShieldComponent } from './health_plugin';
import {
    JUMP_BRAKE_MS,
    JumpStateComponent,
} from './jump_plugin';
import { MiningShipComponent } from './miner_ai';
import {
    GovtComponent,
    NpcAIComponent,
} from './npc_components';
import { makeNpc } from './npc_plugin';
import { OutfitsStateComponent } from './outfit_plugin';
import { PlatformResource } from './platform_plugin';
import { PlayerState, PlayerStateComponent } from './player_state';
import { ShipComponent, ShipDataComponent } from './ship_plugin';
import { SystemIdResource } from './system_id_resource';
import { TargetComponent } from './target_component';
import { WeaponsStateComponent } from './weapons_state';

import {
    AURORAN_GOVT,
    AURORAN_UPGRADE_TIERS,
    CONQUEST_AURORA_SYSTEM,
    CONQUEST_BOT_GATHER_CREDIT_RATE_PER_SEC,
    CONQUEST_BOT_RAID_IDLE_MS,
    CONQUEST_BOT_SPAWN_INTERVAL_MS,
    CONQUEST_BOT_UPGRADE_BASE_COST,
    CONQUEST_SOL_SYSTEM,
    FEDERATION_GOVT,
    FEDERATION_UPGRADE_TIERS,
    isConquestMode,
    isConquestPocketSystem,
    MAX_CONQUEST_BOTS_PER_SYSTEM,
    oppositeConquestSystem,
} from './conquest_config';
export * from './conquest_config';

export interface ConquestBotState {
    mode: 'gather' | 'attack';
    factionGovt: number;
    homeSystem: string;
    tier: number;
    gatheredCredits: number;
    lastModeSwitchAt: number;
    upgradePending: boolean;
}

export const ConquestBotComponent =
    new Component<ConquestBotState>('ConquestBotComponent');

const ConquestPlayersQuery = new Query([
    UUID,
    PlayerStateComponent,
    MovementStateComponent,
] as const, 'ConquestPlayers');

const ConquestBotsQuery = new Query([
    UUID,
    ConquestBotComponent,
    MovementStateComponent,
    ShipComponent,
    TargetComponent,
    Optional(MiningShipComponent),
    Optional(WeaponsStateComponent),
    Optional(DisabledComponent),
    GetEntity,
] as const, 'ConquestBots');

const ConquestAsteroidsQuery = new Query([
    UUID,
    MovementStateComponent,
    AsteroidComponent,
] as const, 'ConquestAsteroids');

const ConquestShipsQuery = new Query([
    UUID,
    MovementStateComponent,
    ShipComponent,
    Optional(GovtComponent),
    Optional(PlayerStateComponent),
    Optional(DisabledComponent),
] as const, 'ConquestShips');

function upgradeCostForTier(tier: number): number {
    return CONQUEST_BOT_UPGRADE_BASE_COST * (tier + 1);
}

function hullTiersForGovt(govt: number): readonly string[] {
    return govt === AURORAN_GOVT
        ? AURORAN_UPGRADE_TIERS
        : FEDERATION_UPGRADE_TIERS;
}

let nextConquestBotSpawnAt = 0;

const ConquestBotLifecycleSystem = new AsyncSystem({
    name: 'ConquestBotLifecycle',
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

        // 1. Spawn Conquest AI bots (miners/raiders) up to MAX_CONQUEST_BOTS_PER_SYSTEM
        if (bots.length < MAX_CONQUEST_BOTS_PER_SYSTEM
            && time.time >= nextConquestBotSpawnAt) {
            nextConquestBotSpawnAt = time.time + CONQUEST_BOT_SPAWN_INTERVAL_MS;
            const isAurora = systemId === CONQUEST_AURORA_SYSTEM;
            // 75% home faction defenders/miners, 25% rival faction raiders
            const isHomeFaction = Math.random() < 0.75;
            const factionGovt = (isAurora === isHomeFaction)
                ? AURORAN_GOVT
                : FEDERATION_GOVT;
            const tiers = hullTiersForGovt(factionGovt);
            const initialTier = isHomeFaction ? 0 : Math.min(1, tiers.length - 1);
            const shipId = tiers[initialTier];
            try {
                const shipData = await gameData.data.Ship.get(shipId);
                const bot = makeNpc(shipData);
                if (reserveEntity(budget, bot, 'ship')) {
                    const angle = Math.random() * 2 * Math.PI;
                    const dist = 500 + Math.random() * 900;
                    const mov = bot.components.get(MovementStateComponent);
                    if (mov) {
                        mov.position = new Position(
                            Math.cos(angle) * dist,
                            Math.sin(angle) * dist,
                        );
                    }
                    const initialMode = isHomeFaction ? 'gather' : 'attack';
                    bot.components
                        .set(GovtComponent, { id: factionGovt })
                        .set(MiningShipComponent, { mining: initialMode === 'gather' })
                        .set(ConquestBotComponent, {
                            mode: initialMode,
                            factionGovt,
                            homeSystem: factionGovt === AURORAN_GOVT
                                ? CONQUEST_AURORA_SYSTEM
                                : CONQUEST_SOL_SYSTEM,
                            tier: initialTier,
                            gatheredCredits: 0,
                            lastModeSwitchAt: time.time,
                            upgradePending: false,
                        })
                        .set(MultiplayerData, { owner: 'server' });
                    entities.set(uuid(), bot);
                }
            } catch {
                // Ignore missing ship resource in minimal test fixtures
            }
        }

        // 2. Drive Conquest AI state machine (gather -> upgrade -> attack / raid)
        for (const [
            botUuid,
            botState,
            movement,
            shipComp,
            targetComp,
            miningComp,
            weapons,
            disabled,
            botEntity,
        ] of bots) {
            if (disabled || botEntity.components.has(JumpStateComponent)) {
                continue;
            }
            const tiers = hullTiersForGovt(botState.factionGovt);

            if (botState.mode === 'gather') {
                if (!miningComp || !miningComp.mining) {
                    botEntity.components.set(MiningShipComponent, { mining: true });
                }

                // Accumulate credits while near asteroids and firing mining weapons
                const hasAsteroidTarget = Boolean(
                    targetComp.target
                    && asteroids.some(([aUuid]) => aUuid === targetComp.target),
                );
                if (hasAsteroidTarget) {
                    botState.gatheredCredits +=
                        CONQUEST_BOT_GATHER_CREDIT_RATE_PER_SEC * (time.delta_s || 0.016);
                    if (weapons) {
                        for (const [, w] of weapons) {
                            w.firing = true;
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
                    // Switch to attack mode after upgrading!
                    botState.mode = 'attack';
                    botState.lastModeSwitchAt = time.time;
                    botEntity.components.set(MiningShipComponent, { mining: false });
                    targetComp.target = undefined;
                }
            } else {
                // Attack mode: look for rival ships in system
                if (miningComp?.mining) {
                    botEntity.components.set(MiningShipComponent, { mining: false });
                }

                let closestEnemy: string | undefined;
                let closestDistSq = Infinity;
                for (const [
                    candidateUuid,
                    candidateMov,
                    ,
                    candidateGovt,
                    candidatePlayer,
                    candidateDisabled,
                ] of ships) {
                    if (candidateUuid === botUuid || candidateDisabled) {
                        continue;
                    }
                    const isEnemyNpc = candidateGovt !== undefined
                        && candidateGovt.id !== botState.factionGovt
                        && (candidateGovt.id === FEDERATION_GOVT
                            || candidateGovt.id === AURORAN_GOVT
                            || candidateGovt.id === 130);
                    // Only attack players who are in the rival home system or different govt
                    const isEnemyPlayer = Boolean(
                        candidatePlayer
                        && isConquestMode(candidatePlayer)
                        && systemId !== botState.homeSystem,
                    );
                    if (!isEnemyNpc && !isEnemyPlayer) {
                        continue;
                    }
                    const dSq = candidateMov.position
                        .subtract(movement.position).lengthSquared;
                    if (dSq < closestDistSq) {
                        closestDistSq = dSq;
                        closestEnemy = candidateUuid;
                    }
                }

                if (closestEnemy) {
                    targetComp.target = closestEnemy;
                    botState.lastModeSwitchAt = time.time;
                } else if (time.time - botState.lastModeSwitchAt >= CONQUEST_BOT_RAID_IDLE_MS) {
                    // No enemies in sight: either jump to raid the rival pocket
                    // system, or return to gathering asteroids if below max tier.
                    const otherSystem = oppositeConquestSystem(systemId);
                    if (otherSystem && Math.random() < 0.5 && movement.position.length > 1_000) {
                        botEntity.components.set(JumpStateComponent, {
                            from: systemId,
                            to: otherSystem,
                            phase: 'braking',
                            phaseStartedAt: time.time,
                            transitionAt: time.time + JUMP_BRAKE_MS,
                            requiresAdjacency: false,
                            arrivalSoundPending: false,
                        });
                    } else {
                        botState.mode = 'gather';
                        botState.lastModeSwitchAt = time.time;
                        botEntity.components.set(MiningShipComponent, { mining: true });
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
        world.addComponent(ConquestBotComponent);
        world.addSystem(ConquestBotLifecycleSystem);
        world.addSystem(ConquestSalvageDropSystem);
    },
};
