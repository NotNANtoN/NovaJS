import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { ShipData } from 'novadatainterface/ShipData';
import { UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Optional } from 'nova_ecs/optional';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { ProvideAsync } from 'nova_ecs/provide_async';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { AsteroidComponent } from './asteroid_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { GameDataResource } from './game_data_resource';
import { ArmorComponent } from './health_plugin';
import { NpcAIComponent } from './npc_components';
import { PlatformResource } from './platform_plugin';
import { ShipDataComponent } from './ship_plugin';
import { TargetComponent } from './target_component';

/** How far a miner will look for a rock to work on. */
export const MINING_SEEK_RANGE = 3_000;
/** Miners stop closing once they are comfortably in weapons range. */
export const MINING_STANDOFF = 400;

/**
 * Whether an NPC prospects asteroids when it has no one to fight. Combat
 * always wins: the mining behaviour only runs when no hostile target was
 * selected.
 */
export const MiningShipComponent =
    new Component<{ mining: boolean }>('MiningShipComponent');

const MINING_NAME_PATTERN = /min(e|er|ing)\b/i;

const miningShipCache = new WeakMap<GameDataInterface, Map<string, boolean>>();

/**
 * A ship counts as a mining ship when it or one of its built in outfits is
 * named for mining. In retail data this selects exactly the Asteroid Miner,
 * which carries four Asteroid Mining Lasers, while still recognising mining
 * ships added by plug-ins.
 */
export async function isMiningShip(
    shipData: ShipData, gameData: GameDataInterface,
): Promise<boolean> {
    let cache = miningShipCache.get(gameData);
    if (!cache) {
        cache = new Map();
        miningShipCache.set(gameData, cache);
    }
    const cached = cache.get(shipData.id);
    if (cached !== undefined) {
        return cached;
    }

    let mining = MINING_NAME_PATTERN.test(shipData.name);
    const outfits = gameData.data.Outfit;
    if (!mining && outfits) {
        const outfitIds = Object.keys(shipData.outfits ?? {});
        const names = await Promise.all(outfitIds.map(async id => {
            try {
                return (await outfits.get(id)).name;
            } catch (_error) {
                return '';
            }
        }));
        mining = names.some(name => MINING_NAME_PATTERN.test(name));
    }
    cache.set(shipData.id, mining);
    return mining;
}

/**
 * Resolving whether a ship is a miner needs outfit lookups, so it is provided
 * asynchronously rather than decided while spawning. Requiring the NPC marker
 * keeps this off replicated and player ships.
 */
export const MiningShipProvider = ProvideAsync({
    name: 'MiningShipProvider',
    provided: MiningShipComponent,
    update: [ShipDataComponent],
    args: [ShipDataComponent, GameDataResource, NpcAIComponent] as const,
    factory: async (shipData, gameData) => ({
        mining: await isMiningShip(shipData, gameData),
    }),
});

const AsteroidTargetsQuery = new Query(
    [UUID, MovementStateComponent, AsteroidComponent] as const,
    'AsteroidTargets');

/**
 * The ordering dependencies are injected because the combat AI systems live
 * with the rest of the NPC behaviour; importing them here would form a cycle
 * that leaves the ordering markers undefined at module load.
 */
export function createMinerSystems(
    { chooseTarget, follow }: { chooseTarget: System, follow: System },
) {
    return {
        target: makeMinerTargetAI(chooseTarget),
        approach: makeMinerApproachAI(follow),
    };
}

function makeMinerTargetAI(chooseTarget: System) {
    return new System({
        name: 'MinerTargetAI',
        args: [MiningShipComponent, TargetComponent, MovementStateComponent,
            AsteroidTargetsQuery, MultiplayerData, PlatformResource,
            NpcAIComponent, Optional(DestructionStartedComponent),
            Optional(ArmorComponent)] as const,
        after: [chooseTarget],
        step(miner, target, movement, asteroids, multiplayer, platform, _npcAI,
            destructionStarted, armor) {
            if (!miner.mining || platform !== 'node'
                || multiplayer.owner !== 'server') {
                return;
            }
            if (destructionStarted || armor && armor.current <= 0) {
                return;
            }
            // A hostile target was already chosen, so stay in the fight.
            if (target.target) {
                return;
            }

            let closest: string | undefined;
            let closestDistance = MINING_SEEK_RANGE * MINING_SEEK_RANGE;
            for (const [asteroidUuid, asteroidMovement] of asteroids) {
                const distance = asteroidMovement.position
                    .subtract(movement.position).lengthSquared;
                if (distance < closestDistance) {
                    closestDistance = distance;
                    closest = asteroidUuid;
                }
            }
            target.target = closest;
        },
    });
}

function makeMinerApproachAI(follow: System) {
    return new System({
        name: 'MinerApproachAI',
        args: [MiningShipComponent, TargetComponent, MovementStateComponent,
            AsteroidTargetsQuery, MultiplayerData, PlatformResource,
            NpcAIComponent] as const,
        after: [follow],
        step(miner, target, movement, asteroids, multiplayer, platform) {
            if (!miner.mining || platform !== 'node'
                || multiplayer.owner !== 'server') {
                return;
            }
            const targetUuid = target.target;
            if (!targetUuid) {
                return;
            }
            const asteroid = asteroids.find(([uuid]) => uuid === targetUuid);
            if (!asteroid) {
                return;
            }
            // Keep station off the rock instead of flying into it. Weapons
            // keep firing because they are aimed at the target, not the
            // heading.
            const distance = asteroid[1].position
                .subtract(movement.position).length;
            if (distance < MINING_STANDOFF) {
                movement.accelerating = 0;
            }
        },
    });
}
