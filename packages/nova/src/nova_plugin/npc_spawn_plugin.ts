import * as t from 'io-ts';
import { FleetData } from 'novadatainterface/fleet_data';
import { GovtData } from 'novadatainterface/govt_data';
import { ShipData } from 'novadatainterface/ship_data';
import { SystemData } from 'novadatainterface/system_data';
import { GetWorld } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { Plugin } from 'nova_ecs/plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { Random, RandomResource } from 'nova_ecs/plugins/random_plugin';
import { SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { TimeResource, TimeSystem } from 'nova_ecs/plugins/time_plugin';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { World } from 'nova_ecs/world';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { loadShipGameData } from './entity_data_loader.js';
import { deriveEntityComponents } from './entity_factory.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { GovtComponent } from './govt_component.js';
import { IdFactory, IdFactoryResource } from './id_factory.js';
import { JUMP_ARRIVAL_MARGIN_S, JUMP_DISTANCE } from './jump_plugin.js';
import { loadWithRetries } from './load_retry.js';
import { evaluateNCBTest } from './ncb.js';
import { DeathAIComponent } from './npc_plugin.js';
import { FiringGroupComponent } from './firing_group.js';
import { FormationComponent, NpcComponent, formationSlotPosition } from './npc_ai_plugin.js';
import { WeaponEntries } from './fire_weapon_plugin.js';
import { ShipComponent } from './ship_plugin.js';
import { TargetComponent } from './target_component.js';

/**
 * ============================================================================
 * NPC population (sÿst DudeTypes + flët fleets)
 * ============================================================================
 *
 * Each system maintains a deterministic NPC population drawn from its
 * sÿst dude table: the population target is AvgShips +/- 50% (the
 * Bible's rule), rolled once at world genesis from the per-system
 * seeded Random, so every peer builds the same population. Ships jump
 * out when their AI decides to (npc_ai_plugin) and a respawn system
 * tops the population back up with ships "jumping in" at the system
 * edge — the same deterministic-spawner shape as the asteroid field.
 *
 * The spawn TABLE is computed once at genesis and stored on a spawner
 * entity, because computing it requires async game-data loads (dude,
 * fleet, ship, govt resources) that must never happen mid-simulation.
 * Every ship class the table can ever spawn — and its transitive
 * weapon/bay closure, and its govt — is staged at genesis, so the
 * respawn system's getCached reads behave identically on every world
 * (see entity_data_loader.ts's staging contract).
 *
 * Fleets come from two sources:
 *  - sÿst DudeTypes entries -128..-383 reference flët -id directly and
 *    inherit that entry's probability weight.
 *  - Roaming fleets: every flët whose LinkSyst matches this system
 *    (specific system / this govt's systems / an ally's / an enemy's /
 *    anyone else's — resolved through GovtData class numbers) is
 *    folded into the table under a shared ROAMING_FLEET_WEIGHT so
 *    fleets stay occasional rather than dominating the dude traffic.
 *
 * MULTIPLAYER DESIGN CONSTRAINT (AppearOn): a flët's AppearOn NCB test
 * is evaluated at genesis against an EMPTY control-bit set. Control
 * bits are per-player mission state, but fleet spawning is shared-sim
 * state that must be identical for every peer in a room — one player's
 * mission bits cannot make a fleet exist for everyone (or worse, only
 * on their own world: an instant desync). Until missions land and a
 * design for shared-vs-personal encounters exists, only fleets whose
 * AppearOn passes with no bits set (i.e. unconditional or negated-bit
 * expressions) can spawn.
 */

/** Hard cap on the NPC population. AvgShips reaches 20 in stock data
 * (and 50 in plugins); ships are far heavier than asteroids (outfits,
 * weapons, AI, per-frame snapshot encoding), so populations are capped
 * well below the asteroid cap. */
export const MAX_NPC_POPULATION = 12;
/** How often the system replaces a departed/destroyed NPC. */
export const NPC_RESPAWN_INTERVAL_MS = 15_000;
/** Initial spawns scatter within this half-size box (the region where
 * planets and gameplay live; matches the asteroid field). */
const INITIAL_SPAWN_HALF_SIZE = 2000;
/** Total table weight given to all roaming (LinkSyst) fleets combined,
 * relative to dude weights that typically sum to ~100. */
const ROAMING_FLEET_WEIGHT = 15;

const WeightedShip = t.type({ id: t.string, weight: t.number });

const DudeSpawn = t.type({
    /** Düde AIType; 0 = each ship's InherentAI. */
    aiType: t.number,
    govt: t.union([t.string, t.null]),
    ships: t.array(WeightedShip),
});
type DudeSpawn = t.TypeOf<typeof DudeSpawn>;

const FleetSpawn = t.type({
    leadShip: t.string,
    escorts: t.array(t.type({
        id: t.string,
        min: t.number,
        max: t.number,
    })),
    govt: t.union([t.string, t.null]),
});
type FleetSpawn = t.TypeOf<typeof FleetSpawn>;

export const NpcSpawnEntry = t.intersection([t.type({
    weight: t.number,
}), t.partial({
    dude: DudeSpawn,
    fleet: FleetSpawn,
})]);
export type NpcSpawnEntry = t.TypeOf<typeof NpcSpawnEntry>;

/**
 * Per-system NPC spawner state, attached to a dedicated entity with
 * the deterministic uuid 'npc spawner' (like 'asteroid field').
 */
export const NpcSpawnerType = t.type({
    /** How many NPC ships the system wants alive. */
    targetCount: t.number,
    /** The weighted spawn table (see the module comment). */
    entries: t.array(NpcSpawnEntry),
    /** Sim time (ms) after which the spawner may add a ship. */
    nextSpawn: t.number,
});
export type NpcSpawnerType = t.TypeOf<typeof NpcSpawnerType>;
export const NpcSpawnerComponent = new Component<NpcSpawnerType>('NpcSpawner');

/**
 * Picks an entry from a weighted list with a single Random draw (so
 * the PRNG stream stays in lockstep no matter which entry wins).
 * Returns undefined only for an empty/zero-weight list.
 */
export function pickWeighted<T extends { weight: number }>(
    entries: readonly T[], random: Random): T | undefined {
    const total = entries.reduce((sum, entry) =>
        sum + Math.max(0, entry.weight), 0);
    if (total <= 0) {
        return undefined;
    }
    let roll = random.next() * total;
    for (const entry of entries) {
        roll -= Math.max(0, entry.weight);
        if (roll < 0) {
            return entry;
        }
    }
    return entries[entries.length - 1];
}

/**
 * Whether a fleet's LinkSyst admits it into the given system.
 * `systemGovt` is the spawn system's owning government id (null for
 * independent). The relational ranges (an ally's / an enemy's systems)
 * resolve through govt class numbers, evaluated from the system govt's
 * side: it must list the LinkSyst govt's classes among its allies (or
 * enemies); `systemGovtData`/`linkGovtData` supply those class lists.
 */
export function fleetAllowedInSystem(link: FleetData['linkSyst'],
    systemId: string, systemGovt: string | null,
    systemGovtData: GovtData | undefined,
    linkGovtData: GovtData | undefined): boolean {
    switch (link.type) {
        case 'any':
            return true;
        case 'system':
            return link.id === systemId;
        case 'govtSystems':
            return systemGovt === link.govt;
        case 'notGovtSystems':
            return systemGovt !== link.govt;
        case 'allySystems':
        case 'enemySystems': {
            if (!systemGovtData || !linkGovtData) {
                return false;
            }
            if (systemGovtData.id === linkGovtData.id) {
                // A govt is its own ally and never its own enemy.
                return link.type === 'allySystems';
            }
            const lists = link.type === 'allySystems'
                ? systemGovtData.allies : systemGovtData.enemies;
            return linkGovtData.classes.some(c => lists.includes(c));
        }
    }
}

/**
 * Stages a ship class's full closure plus a govt, with retries; see
 * the staging contract note in the module comment. Also primes the
 * world's lazily-constructed WeaponEntries for every weapon in the
 * closure — WeaponsSystem gates firing on `weaponEntries.getCached`,
 * so an unprimed entry materializes at a load-timing-dependent tick
 * and each world starts firing that NPC's weapons at a different
 * time (the exact recorded desync class from the weapons work; the
 * live nova:141 pirate-system desync during this feature's bringup
 * was this line missing).
 */
async function stageShip(world: World, shipId: string, govt: string | null) {
    const gameData = world.resources.get(SimulationGameDataResource);
    if (!gameData) {
        throw new Error('Expected SimulationGameDataResource to exist');
    }
    const weaponIds = await loadWithRetries(
        () => loadShipGameData(gameData, shipId), `NPC ship ${shipId}`);
    const weaponEntries = world.resources.get(WeaponEntries);
    if (weaponEntries) {
        await Promise.all([...weaponIds].map(id => weaponEntries.get(id)));
    }
    if (govt) {
        await loadWithRetries(() => gameData.data.Govt.get(govt),
            `NPC govt ${govt}`);
    }
}

/**
 * Builds the system's NPC spawn table: resolves the sÿst dude/fleet
 * entries and the roaming LinkSyst fleets, evaluates AppearOn against
 * an empty bit set (see the multiplayer constraint above), and stages
 * every ship class and govt the table can spawn.
 */
export async function buildNpcSpawnTable(world: World, systemId: string,
    systemData: SystemData): Promise<NpcSpawnEntry[]> {
    const gameData = world.resources.get(SimulationGameDataResource);
    if (!gameData) {
        throw new Error('Expected SimulationGameDataResource to exist');
    }
    const entries: NpcSpawnEntry[] = [];

    for (const { id, weight } of systemData.dudes) {
        try {
            const dude = await loadWithRetries(
                () => gameData.data.Dude.get(id), `düde ${id}`);
            const ships: Array<{ id: string, weight: number }> = [];
            for (const ship of dude.ships) {
                await stageShip(world, ship.id, dude.govt);
                ships.push({ id: ship.id, weight: ship.weight });
            }
            if (ships.length > 0) {
                entries.push({
                    weight,
                    dude: { aiType: dude.aiType, govt: dude.govt, ships },
                });
            }
        } catch (e) {
            // A dude that cannot load is dropped on EVERY world (the
            // table is genesis state computed identically everywhere).
            console.warn(`NPC spawn table: dropping düde ${id}: ${e}`);
        }
    }

    // AppearOn: empty bit set (per-player bits cannot drive shared
    // spawns; see the module comment).
    const emptyBits = { getBit: () => false };
    const appears = (fleet: FleetData) => {
        try {
            return evaluateNCBTest(fleet.appearOn, emptyBits);
        } catch (e) {
            console.warn(`Bad AppearOn for fleet ${fleet.id}: ${e}`);
            return false;
        }
    };

    const stageFleet = async (fleet: FleetData) => {
        await stageShip(world, fleet.leadShip, fleet.govt);
        for (const escort of fleet.escorts) {
            await stageShip(world, escort.id, fleet.govt);
        }
        return {
            leadShip: fleet.leadShip,
            escorts: fleet.escorts.map(({ id, min, max }) =>
                ({ id, min, max })),
            govt: fleet.govt,
        };
    };

    // Fleets referenced directly by the sÿst DudeTypes table.
    for (const { id, weight } of systemData.fleets) {
        try {
            const fleet = await loadWithRetries(
                () => gameData.data.Fleet.get(id), `flët ${id}`);
            if (!appears(fleet)) {
                continue;
            }
            entries.push({ weight, fleet: await stageFleet(fleet) });
        } catch (e) {
            console.warn(`NPC spawn table: dropping flët ${id}: ${e}`);
        }
    }

    // Roaming fleets: scan every flët's LinkSyst against this system.
    // Sorted ids so the table is identical on every world.
    const systemGovtData = systemData.govt
        ? await gameData.data.Govt.get(systemData.govt).catch(() => undefined)
        : undefined;
    const roaming: FleetData[] = [];
    const fleetIds = [...(await gameData.ids).Fleet].sort();
    for (const fleetId of fleetIds) {
        let fleet: FleetData;
        try {
            fleet = await gameData.data.Fleet.get(fleetId);
        } catch {
            continue;
        }
        const link = fleet.linkSyst;
        const linkGovtData =
            (link.type === 'allySystems' || link.type === 'enemySystems')
                ? await gameData.data.Govt.get(link.govt)
                    .catch(() => undefined)
                : undefined;
        const allowed = fleetAllowedInSystem(link, systemId,
            systemData.govt, systemGovtData, linkGovtData);
        if (allowed && appears(fleet)) {
            roaming.push(fleet);
        }
    }
    for (const fleet of roaming) {
        try {
            entries.push({
                weight: ROAMING_FLEET_WEIGHT / roaming.length,
                fleet: await stageFleet(fleet),
            });
        } catch (e) {
            console.warn(`NPC spawn table: dropping flët ${fleet.id}: ${e}`);
        }
    }

    return entries;
}

/** The Bible's "average +/- 50%" population roll. */
export function rollPopulationTarget(avgShips: number,
    random: Random): number {
    if (avgShips <= 0) {
        return 0;
    }
    return Math.min(MAX_NPC_POPULATION,
        Math.max(1, Math.round(avgShips * (0.5 + random.next()))));
}

/**
 * Creates one NPC ship entity. All game data must already be staged;
 * this is synchronous so the respawn system can call it mid-sim.
 */
export function makeNpcShip(shipData: ShipData, aiType: number,
    govt: string | null, position: Position, rotation: Angle,
    velocity: Vector): Entity {
    const npc = new Entity(shipData.name);
    npc.components
        .set(ShipComponent, { id: shipData.id })
        .set(MovementStateComponent, {
            accelerating: 0,
            position,
            rotation,
            turnBack: false,
            turning: 0,
            velocity,
        })
        .set(NpcComponent, {
            aiType: aiType > 0 ? aiType : shipData.inherentAI,
        })
        .set(TargetComponent, { target: undefined })
        .set(DeathAIComponent, undefined);
    if (govt) {
        npc.components.set(GovtComponent, { id: govt });
    }
    return npc;
}

/** Jump-in kinematics: where an arriving NPC appears and how it moves
 * (mirrors jump_plugin's arrival: outside the no-jump zone, coasting
 * inward at top speed). */
function jumpInState(shipData: ShipData, random: Random) {
    const bearing = new Angle(random.next() * 2 * Math.PI);
    const inward = bearing.getUnitVector().scale(-1);
    const arrivalDistance = JUMP_DISTANCE
        + shipData.physics.speed * JUMP_ARRIVAL_MARGIN_S;
    return {
        position: new Position(bearing.getUnitVector().x * arrivalDistance,
            bearing.getUnitVector().y * arrivalDistance),
        rotation: inward.angle,
        velocity: inward.scale(shipData.physics.speed),
    };
}

/**
 * Spawns one draw from the spawn table: a single dude ship, or a whole
 * fleet (lead + escorts in formation slots). `atEdge` selects jump-in
 * kinematics (respawns) vs. scattered in-system placement (genesis).
 * Deterministic: seeded Random only, ids from the IdFactory, and
 * getCached reads staged at genesis.
 *
 * NPCs are inserted FULLY FORMED (deriveEntityComponents, from the
 * staged caches) rather than left for the provider systems to fill in.
 * This is a determinism requirement, not an optimization: a bare ship
 * joins each system's query cache when its derived components attach
 * (a tick or two after insertion), so it iterates AFTER any
 * already-formed ship even if it sits earlier in the entity map. A
 * world restored from a wire snapshot rebuilds its caches in entity-
 * map order, so the two worlds would fire weapons (and consume Random)
 * in different orders — a divergence the wire-snapshot lockstep test
 * caught when genesis NPCs first landed.
 */
export function spawnNpc(world: World,
    gameData: SimulationGameDataInterface, ids: IdFactory, random: Random,
    entries: NpcSpawnEntry[], atEdge: boolean): number {
    const entities = world.entities;
    const entry = pickWeighted(entries, random);
    if (!entry) {
        return 0;
    }
    const insert = (uuid: string, entity: Entity) => {
        deriveEntityComponents(world, entity);
        entities.set(uuid, entity);
    };

    const scatter = () => new Position(
        (random.next() * 2 - 1) * INITIAL_SPAWN_HALF_SIZE,
        (random.next() * 2 - 1) * INITIAL_SPAWN_HALF_SIZE);

    if (entry.dude) {
        const choice = pickWeighted(entry.dude.ships, random);
        if (!choice) {
            return 0;
        }
        const shipData = gameData.data.Ship.getCached(choice.id);
        if (!shipData) {
            // Staged at genesis, so a miss is identical on every world.
            return 0;
        }
        let state;
        if (atEdge) {
            state = jumpInState(shipData, random);
        } else {
            state = {
                position: scatter(),
                rotation: new Angle(random.next() * 2 * Math.PI),
                velocity: new Vector(0, 0),
            };
        }
        insert(ids.next('npc'), makeNpcShip(shipData,
            entry.dude.aiType, entry.dude.govt,
            state.position, state.rotation, state.velocity));
        return 1;
    }

    if (!entry.fleet) {
        return 0;
    }
    const fleet = entry.fleet;
    const leadData = gameData.data.Ship.getCached(fleet.leadShip);
    if (!leadData) {
        return 0;
    }
    let leadState;
    if (atEdge) {
        leadState = jumpInState(leadData, random);
    } else {
        leadState = {
            position: scatter(),
            rotation: new Angle(random.next() * 2 * Math.PI),
            velocity: new Vector(0, 0),
        };
    }
    const leadUuid = ids.next('npc');
    const leadShip = makeNpcShip(leadData, 0, fleet.govt,
        leadState.position, leadState.rotation, leadState.velocity);
    // The whole fleet shares one firing group so members' weapons pass
    // through each other (see firing_group.ts): in the original game an
    // NPC and its escorts simply cannot hit each other, so a stray
    // escort shot must never turn the leader hostile to its own fleet.
    leadShip.components.set(FiringGroupComponent, { group: leadUuid });
    insert(leadUuid, leadShip);
    let spawned = 1;
    let slot = 0;
    for (const escort of fleet.escorts) {
        const count = escort.min
            + random.below(Math.max(1, escort.max - escort.min + 1));
        const escortData = gameData.data.Ship.getCached(escort.id);
        if (!escortData) {
            continue;
        }
        for (let i = 0; i < count; i++) {
            // Escorts materialize already sitting in their slots.
            const slotPosition = formationSlotPosition(
                leadState.position, leadState.rotation, slot);
            const escortEntity = makeNpcShip(escortData, 0, fleet.govt,
                slotPosition, leadState.rotation,
                Vector.fromVectorLike(leadState.velocity));
            escortEntity.components.set(FormationComponent, {
                leader: leadUuid,
                slot,
            });
            escortEntity.components.set(FiringGroupComponent,
                { group: leadUuid });
            insert(ids.next('npc'), escortEntity);
            slot++;
            spawned++;
        }
    }
    return spawned;
}

/**
 * Genesis entry point: rolls the population target, builds and stages
 * the spawn table, spawns the initial population scattered through the
 * system, and installs the spawner entity that keeps it topped up.
 * Call from makeSystem before the world steps.
 */
export async function spawnNpcs(world: World, systemId: string,
    systemData: SystemData) {
    const gameData = world.resources.get(SimulationGameDataResource);
    const random = world.resources.get(RandomResource);
    const ids = world.resources.get(IdFactoryResource);
    if (!gameData || !random || !ids) {
        throw new Error('Expected game data, random, and id factory resources');
    }

    const entries = await buildNpcSpawnTable(world, systemId, systemData);
    const targetCount = entries.length === 0 ? 0
        : rollPopulationTarget(systemData.avgShips, random);

    let population = 0;
    // Fleets can overshoot the target by their escort count; that's
    // the Bible's own behavior (a fleet arrives whole) and the excess
    // decays as ships depart.
    for (let guard = 0; population < targetCount && guard < 100; guard++) {
        population += spawnNpc(world, gameData, ids, random, entries, false);
    }

    const spawner = new Entity('npc spawner')
        .addComponent(NpcSpawnerComponent, {
            targetCount,
            entries,
            nextSpawn: 0,
        });
    world.entities.set('npc spawner', spawner);
}

const LiveNpcsQuery = new Query([NpcComponent] as const);

/**
 * Replaces departed/destroyed NPCs one at a time, jumping in at the
 * system edge, until the population is back at target. Mirrors
 * AsteroidRespawnSystem.
 */
const NpcRespawnSystem = new System({
    name: 'NpcRespawnSystem',
    args: [NpcSpawnerComponent, LiveNpcsQuery, TimeResource, GetWorld,
        RandomResource, IdFactoryResource,
        SimulationGameDataResource] as const,
    step(spawner, liveNpcs, time, world, random, ids, gameData) {
        if (time.time < spawner.nextSpawn
            || liveNpcs.length >= spawner.targetCount) {
            return;
        }
        spawner.nextSpawn = time.time + NPC_RESPAWN_INTERVAL_MS;
        spawnNpc(world, gameData, ids, random, spawner.entries, true);
    },
    // After TimeSystem for the same late-join determinism reason as
    // AsteroidMotionSystem.
    after: [TimeSystem],
});

export const NpcSpawnPlugin: Plugin = {
    name: 'NpcSpawnPlugin',
    build(world) {
        const serializer = world.resources.get(SerializerResource);
        serializer?.addComponent(NpcSpawnerComponent, NpcSpawnerType);
        world.addSystem(NpcRespawnSystem);
    },
};
