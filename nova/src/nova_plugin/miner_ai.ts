import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { ShipData } from 'novadatainterface/ShipData';
import { Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Optional } from 'nova_ecs/optional';
import {
    MovementPhysicsComponent,
    MovementStateComponent,
} from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { ProvideAsync } from 'nova_ecs/provide_async';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { AsteroidComponent, OreComponent } from './asteroid_plugin';
import { PlanetComponent } from './planet_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { approachTarget } from './flight_controller';
import { GameDataResource } from './game_data_resource';
import { ArmorComponent } from './health_plugin';
import { JumpStateComponent } from './jump_plugin';
import { CommandedEscortComponent, NpcAIComponent } from './npc_components';
import { PlatformResource } from './platform_plugin';
import { ShipDataComponent } from './ship_plugin';
import { TargetComponent } from './target_component';

/** How far a miner will look for a rock to work on. */
export const MINING_SEEK_RANGE = 3_000;
/** Miners stop closing once they are comfortably in weapons range. */
export const MINING_STANDOFF = 400;
/** How far a miner will detour to scoop floating ore chunks. */
export const MINING_ORE_SEEK_RANGE = 1_500;
/** Pickup radius for NPC miners scooping ore chunks. */
export const MINER_ORE_PICKUP_RADIUS = 65;
/** Tractor pull radius for NPC miners scooping ore chunks. */
export const MINER_ORE_MAGNET_RADIUS = 160;
/** Fallback cargo capacity if a miner lacks ShipDataComponent. */
export const DEFAULT_MINER_CARGO_CAPACITY = 20;
/** Distance to a planet at which a full miner docks and sells its ore. */
export const MINER_DOCK_DISTANCE = 140;

export interface NpcCargoHold {
    tons: number;
    capacity: number;
    commodity?: string;
}

/** Local server-side cargo hold for NPC miners collecting and selling ore. */
export const NpcCargoHoldComponent =
    new Component<NpcCargoHold>('NpcCargoHoldComponent');

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
const OreTargetsQuery = new Query(
    [UUID, MovementStateComponent, OreComponent] as const,
    'MinerOreTargets');
const MinerPlanetsQuery = new Query(
    [MovementStateComponent, PlanetComponent] as const,
    'MinerPlanets');
const NpcOreCollectorsQuery = new Query([
    MovementStateComponent,
    MiningShipComponent,
    Optional(NpcCargoHoldComponent),
    Optional(ShipDataComponent),
    GetEntity,
] as const, 'NpcOreCollectors');

function isHoldFull(hold: NpcCargoHold | undefined): boolean {
    return Boolean(hold && hold.capacity > 0 && hold.tons >= hold.capacity);
}

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
        scoop: makeMinerOreScoopSystem(),
    };
}

function makeMinerTargetAI(chooseTarget: System) {
    return new System({
        name: 'MinerTargetAI',
        args: [MiningShipComponent, TargetComponent, MovementStateComponent,
            AsteroidTargetsQuery, OreTargetsQuery, MultiplayerData, PlatformResource,
            NpcAIComponent, Optional(DestructionStartedComponent),
            Optional(ArmorComponent), Optional(CommandedEscortComponent),
            Optional(NpcCargoHoldComponent)] as const,
        after: [chooseTarget],
        step(miner, target, movement, asteroids, ores, multiplayer, platform, _npcAI,
            destructionStarted, armor, commandedEscort, cargoHold) {
            if (!miner.mining || platform !== 'node'
                || multiplayer.owner !== 'server' || commandedEscort !== undefined) {
                return;
            }
            if (destructionStarted || armor && armor.current <= 0) {
                return;
            }
            const currentTargetIsAsteroid = target.target !== undefined
                && asteroids.some(([asteroidUuid]) => asteroidUuid === target.target);

            // When the hold is full, stop targeting rocks so the miner returns to a planet to sell.
            if (isHoldFull(cargoHold)) {
                if (currentTargetIsAsteroid) {
                    target.target = undefined;
                }
                return;
            }

            // If a hostile (non-asteroid) target was already chosen, stay in the fight.
            if (target.target && !currentTargetIsAsteroid) {
                return;
            }

            // If floating ore is nearby, clear any rock target so we pause shooting and scoop it.
            const oreSeekSq = MINING_ORE_SEEK_RANGE * MINING_ORE_SEEK_RANGE;
            for (const [, oreMovement] of ores) {
                if (oreMovement.position.subtract(movement.position).lengthSquared <= oreSeekSq) {
                    target.target = undefined;
                    return;
                }
            }

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
            MovementPhysicsComponent, AsteroidTargetsQuery, OreTargetsQuery,
            MinerPlanetsQuery, MultiplayerData, PlatformResource, NpcAIComponent,
            Optional(JumpStateComponent), Optional(CommandedEscortComponent),
            Optional(NpcCargoHoldComponent)] as const,
        after: [follow],
        step(miner, target, movement, physics, asteroids, ores, planets, multiplayer,
            platform, _npcAI, jumpState, commandedEscort, cargoHold) {
            if (!miner.mining || platform !== 'node'
                || multiplayer.owner !== 'server' || commandedEscort !== undefined) {
                return;
            }
            if (jumpState) {
                return;
            }

            const targetUuid = target.target;
            // Full cargo hold and not in combat: fly to nearest planet, dock, and offload/sell.
            if (!targetUuid && isHoldFull(cargoHold) && cargoHold) {
                let bestPlanet: typeof planets[number][0] | undefined;
                let bestDistSq = Infinity;
                for (const [planetMovement, planet] of planets) {
                    if (planet.inhabited === false) {
                        continue;
                    }
                    const distSq = planetMovement.position
                        .subtract(movement.position).lengthSquared;
                    if (distSq < bestDistSq) {
                        bestDistSq = distSq;
                        bestPlanet = planetMovement;
                    }
                }
                if (!bestPlanet && planets.length > 0) {
                    bestPlanet = planets[0][0];
                    bestDistSq = bestPlanet.position.subtract(movement.position).lengthSquared;
                }
                if (!bestPlanet) {
                    return;
                }
                if (bestDistSq <= MINER_DOCK_DISTANCE * MINER_DOCK_DISTANCE) {
                    cargoHold.tons = 0;
                    cargoHold.commodity = undefined;
                    movement.accelerating = 0;
                    movement.turnTo = null;
                    movement.turnBack = true;
                    return;
                }
                const command = approachTarget(movement, bestPlanet, physics, { standoff: 0 });
                movement.turnTo = command.turnTo;
                movement.accelerating = command.accelerating;
                movement.turnBack = command.turnBack;
                return;
            }

            // No target and space in hold: fly directly to nearest floating ore chunk to scoop it.
            if (!targetUuid) {
                let closestOre: typeof ores[number][1] | undefined;
                let closestDistSq = MINING_ORE_SEEK_RANGE * MINING_ORE_SEEK_RANGE;
                for (const [, oreMovement] of ores) {
                    const distSq = oreMovement.position
                        .subtract(movement.position).lengthSquared;
                    if (distSq < closestDistSq) {
                        closestDistSq = distSq;
                        closestOre = oreMovement;
                    }
                }
                if (closestOre) {
                    const command = approachTarget(movement, closestOre, physics, { standoff: 0 });
                    movement.turnTo = command.turnTo;
                    movement.accelerating = command.accelerating;
                    movement.turnBack = command.turnBack;
                }
                return;
            }

            const asteroid = asteroids.find(([uuid]) => uuid === targetUuid);
            if (!asteroid) {
                return;
            }
            const command = approachTarget(movement, asteroid[1], physics, {
                standoff: MINING_STANDOFF,
            });
            // Holding station leaves the nose wherever braking pointed it,
            // which is away from the rock. Track the rock instead so mining
            // fire keeps landing.
            movement.turnTo = command.turnTo
                ?? asteroid[1].position.subtract(movement.position).angle;
            movement.accelerating = command.accelerating;
            movement.turnBack = command.turnBack;
        },
    });
}

function makeMinerOreScoopSystem() {
    return new System({
        name: 'MinerOreScoopSystem',
        args: [OreComponent, MovementStateComponent, UUID, Entities,
            NpcOreCollectorsQuery, MultiplayerData, PlatformResource] as const,
        step(ore, movement, selfUuid, entities, collectors, multiplayer, platform) {
            if (platform !== 'node' || multiplayer.owner !== 'server' || !entities.has(selfUuid)) {
                return;
            }
            for (const [minerMovement, miner, existingHold, shipData, minerEntity] of collectors) {
                if (!miner.mining) {
                    continue;
                }
                const capacity = existingHold?.capacity
                    ?? Math.max(1, shipData?.cargoCapacity || DEFAULT_MINER_CARGO_CAPACITY);
                const currentTons = existingHold?.tons ?? 0;
                const freeSpace = capacity - currentTons;
                if (freeSpace <= 0) {
                    continue;
                }
                const delta = minerMovement.position.subtract(movement.position);
                const distance = delta.length;
                if (distance > MINER_ORE_MAGNET_RADIUS) {
                    continue;
                }
                if (distance > MINER_ORE_PICKUP_RADIUS) {
                    const pull = delta.normalize().scale(140 * 0.016);
                    movement.velocity = movement.velocity.add(pull);
                    const speed = movement.velocity.length;
                    if (speed > 120) {
                        movement.velocity = movement.velocity.normalize().scale(120);
                    }
                    continue;
                }
                const taken = Math.min(ore.tons, freeSpace);
                if (taken <= 0) {
                    continue;
                }
                const hold: NpcCargoHold = existingHold ?? { tons: 0, capacity };
                hold.tons += taken;
                hold.commodity = ore.commodity;
                if (!existingHold) {
                    minerEntity.components.set(NpcCargoHoldComponent, hold);
                }
                if (taken >= ore.tons) {
                    entities.delete(selfUuid);
                } else {
                    ore.tons -= taken;
                }
                return;
            }
        },
    });
}
