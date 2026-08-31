import { GameDataInterface } from "novadatainterface/GameDataInterface";
import { NpcSpawnData } from "novadatainterface/SystemData";
import { GetWorld } from "nova_ecs/arg_types";
import { AsyncSystem } from "nova_ecs/async_system";
import { MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { Plugin } from "nova_ecs/plugin";
import { Query } from "nova_ecs/query";
import { Resource } from "nova_ecs/resource";
import { v4 as uuid } from "uuid";
import { GameDataResource } from "./game_data_resource";
import { resourceId } from "../common/resource_id";
import { Angle } from "nova_ecs/datatypes/angle";
import { Position } from "nova_ecs/datatypes/position";
import { Vector } from "nova_ecs/datatypes/vector";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { SystemData } from "novadatainterface/SystemData";
import { PersData } from "novadatainterface/PersData";
import { Entity } from "nova_ecs/entity";
import { selectPers } from "./pers";
import { PlanetComponent } from "./planet_plugin";
import { composeFleetRoster, formationSlot } from "./fleet";
import {
    FleetMemberComponent,
    worldFormationPosition,
} from "./fleet_plugin";
import { TargetComponent } from "./target_component";
import { makePersNpc, PersStateResource } from "./pers_plugin";
import {
    ArrivalPlacement,
    ArrivalStellarCandidate,
    ArrivalSystem,
    chooseArrivalPlacement,
} from "./npc_arrival";
import { GovtComponent } from "./npc_plugin";
import { DudeSourceComponent } from "./boarding_plugin";
import { createArrivingTrafficState } from "./npc_traffic";
import { NpcTrafficComponent } from "./npc_traffic_plugin";
import { DEFAULT_PATROL_RADIUS, PatrolComponent } from "./patrol_plugin";
import { makeNpc } from "./npc_plugin";
import {
    NpcAIComponent,
    NpcCombatRoleComponent,
} from "./npc_components";
import { SystemIdResource } from "./system_id_resource";
import { SingletonComponent, World } from "nova_ecs/world";
import { EntityBudgetResource, reserveEntity } from "./entity_budget";
import {
    JUMP_ARRIVAL_MS,
    JumpStateComponent,
} from './jump_plugin';


export const NPC_RESPAWN_INTERVAL_MS = 3_000;

export function pickWeighted<T extends { weight: number }>(
    entries: readonly T[],
    random: () => number = Math.random,
): T | undefined {
    let totalWeight = 0;
    let lastWeighted: T | undefined;
    for (const entry of entries) {
        if (Number.isFinite(entry.weight) && entry.weight > 0) {
            totalWeight += entry.weight;
            lastWeighted = entry;
        }
    }

    if (!Number.isFinite(totalWeight) || totalWeight <= 0 || !lastWeighted) {
        return undefined;
    }

    const sample = random();
    const normalizedSample = Number.isFinite(sample)
        ? Math.min(1, Math.max(0, sample))
        : 0;
    let remaining = normalizedSample * totalWeight;
    for (const entry of entries) {
        if (!Number.isFinite(entry.weight) || entry.weight <= 0) {
            continue;
        }
        if (remaining < entry.weight) {
            return entry;
        }
        remaining -= entry.weight;
    }
    return lastWeighted;
}

export function getNpcScale(rawScale?: string | number): number {
    const configuredScale = rawScale ??
        (typeof process === "undefined" ? undefined : process.env.NOVA_NPC_SCALE);
    const scale = Number(configuredScale ?? 1);
    return Number.isFinite(scale) && scale >= 0 ? scale : 1;
}

export function getNpcTargetCount(avgShips: number, scale = getNpcScale()): number {
    const safeAvgShips = Number.isFinite(avgShips) && avgShips > 0 ? avgShips : 0;
    const safeScale = Number.isFinite(scale) && scale >= 0 ? scale : 1;
    return Math.max(0, Math.round(safeAvgShips * safeScale));
}

export function getNpcCapacity(target: number): number {
    if (target <= 0) {
        return 0;
    }
    return target + Math.max(1, Math.ceil(target * 0.1));
}

export function getNpcRespawnDelay(random: () => number = Math.random): number {
    const sample = random();
    const normalizedSample = Number.isFinite(sample)
        ? Math.min(1, Math.max(0, sample))
        : 0.5;
    // Keep the cadence predictable while avoiding synchronized respawns.
    return NPC_RESPAWN_INTERVAL_MS * (0.75 + normalizedSample * 0.5);
}

const NpcShipsQuery = new Query(
    [GovtComponent, NpcAIComponent] as const,
    "NpcShips",
);
const NpcSpawnStateResource = new Resource<NpcSpawnState>("NpcSpawnState");

interface NpcSpawnState {
    initialized: boolean;
    disabled: boolean;
    target: number;
    capacity: number;
    nextSpawnAt: number;
    entries: NpcSpawnData[];
    /** Kept so a spawn can work out where a ship arrived from. */
    systemData?: SystemData;
}

interface ArrivalContext {
    system: ArrivalSystem;
    neighbours: Map<string, readonly [number, number]>;
    stellars: ArrivalStellarCandidate[];
}

function isWeightedShip(value: unknown): value is { id: string, weight: number } {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const ship = value as { id?: unknown, weight?: unknown };
    return typeof ship.id === "string"
        && typeof ship.weight === "number"
        && Number.isFinite(ship.weight);
}

function isNpcSpawnData(value: unknown): value is NpcSpawnData {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const entry = value as {
        id?: unknown,
        weight?: unknown,
        government?: unknown,
        combatRole?: unknown,
        ships?: unknown,
    };
    return typeof entry.id === "string"
        && typeof entry.weight === "number"
        && Number.isFinite(entry.weight)
        && typeof entry.government === "number"
        && Number.isFinite(entry.government)
        && (entry.combatRole === undefined
            || entry.combatRole === "civilian"
            || entry.combatRole === "military"
            || entry.combatRole === "personal")
        && Array.isArray(entry.ships)
        && entry.ships.every(isWeightedShip);
}

function getSpawnEntries(systemData: {
    npcs?: unknown,
    dudes?: unknown,
}): NpcSpawnData[] {
    const normalized = systemData.npcs;
    if (Array.isArray(normalized)) {
        return normalized.filter(isNpcSpawnData);
    }

    // Accept a rich `dudes` table from older generated data as well.
    const legacy = systemData.dudes;
    return Array.isArray(legacy) ? legacy.filter(isNpcSpawnData) : [];
}

const AURORAN_ACE_NAMES = [
    'Dechanik', 'Blood Honor', "Frunch'eck", 'Talons of Integrity',
    "Warrior's Pride", 'Doomblade', "Warrior's Path", 'Gjinchar',
    "Swordsman's Song", 'Ytrack',
];

const PIRATE_ACE_NAMES = [
    'Howling Wolf', 'Hell-Hound', 'Old Grey Fox', 'Black Dragon',
    'Footpad', 'Silent Footfall', 'Ball and Chain', 'Raven Stone',
    'Lone Horseman', 'Old Veteran',
];

const FEDERATION_ACE_NAMES = [
    'Resolute', 'Vigilant', 'Dauntless', 'Omata Kane', 'Thunderer',
    'Valiant', 'Defender', 'Centurion', 'Lexington', 'Intrepid',
];

const POLARIS_ACE_NAMES = [
    "Nil'kem", "Kel'ar", "Ver'a Se", "Mu'ao", "Kha'r", "Trel'a",
];

function chooseAceName(govtId: string | number, role?: string): string | undefined {
    const gid = String(govtId);
    if (Math.random() < 0.45) {
        if (gid === 'nova:132' || gid === '132') {
            return AURORAN_ACE_NAMES[Math.floor(Math.random() * AURORAN_ACE_NAMES.length)];
        }
        if (gid === 'nova:130' || gid === '130' || role === 'pirate') {
            return PIRATE_ACE_NAMES[Math.floor(Math.random() * PIRATE_ACE_NAMES.length)];
        }
        if (gid === 'nova:128' || gid === '128') {
            return FEDERATION_ACE_NAMES[Math.floor(Math.random() * FEDERATION_ACE_NAMES.length)];
        }
        if (gid === 'nova:133' || gid === '133') {
            return POLARIS_ACE_NAMES[Math.floor(Math.random() * POLARIS_ACE_NAMES.length)];
        }
    }
    return undefined;
}

async function buildNpc(
    gameData: GameDataInterface,
    npcType: NpcSpawnData,
    shipId: string,
    budget: import('./entity_budget').EntityBudget,
    placement?: ArrivalPlacement,
    fleet?: boolean,
    post?: [number, number],
    now = 0,
) {
    try {
        const shipData = await gameData.data.Ship.get(shipId);
        const npc = makeNpc(shipData);
        if (!reserveEntity(budget, npc, 'ship')) {
            return undefined;
        }
        const aceName = chooseAceName(npcType.government, npcType.combatRole);
        if (aceName) {
            npc.name = `${aceName} (${shipData.name})`;
        }
        npc.components.set(GovtComponent, { id: npcType.government });
        if (npcType.kind === "dude") {
            // What a ship carries when boarded is a düde property, so only a
            // düde-backed spawn can say what its booty is.
            npc.components.set(DudeSourceComponent, { id: npcType.id });
        }
        npc.components.set(
            NpcCombatRoleComponent,
            npcType.combatRole ?? "personal",
        );
        // Ambient traders are given an errand to run. The traffic system
        // drops this marker again for anything that turns out to be a warship,
        // an interceptor or a miner. A fleet is already going somewhere as a
        // group, so its members are not given errands of their own.
        if (!fleet) {
            npc.components.set(
                NpcTrafficComponent, createArrivingTrafficState());
        }
        // A navy ship guards its own world instead of running errands. A fleet
        // is already flying as a group and keeps its formation.
        if (post && !fleet && npcType.combatRole === 'military') {
            npc.components.delete(NpcTrafficComponent);
            npc.components.set(PatrolComponent,
                { guardPost: post, radius: DEFAULT_PATROL_RADIUS });
        }
        if (placement) {
            applyPlacement(npc, placement, now);
        }
        npc.components.set(MultiplayerData, { owner: "server" });
        return npc;
    } catch (_error) {
        // A bad or incomplete data entry should not stop other systems from
        // spawning. The concise population log reports the resulting count.
        return undefined;
    }
}


/**
 * Spawn one ambient entry, which may be a whole flët rather than a lone hull.
 *
 * Returns the uuids alongside the entities because an escort has to be told the
 * uuid of the leader it is escorting, which means the group has to agree on
 * those names before any of it is published to the world.
 */
async function createNpcGroup(
    gameData: GameDataInterface,
    entries: readonly NpcSpawnData[],
    budget: import('./entity_budget').EntityBudget,
    placement?: ArrivalPlacement,
    systemData?: SystemData,
    now = 0,
): Promise<Array<[string, Entity]>> {
    const npcType = pickWeighted(entries);
    if (!npcType) {
        return [];
    }
    const post = guardPost(gameData, systemData, npcType.government);
    if (!npcType.fleet) {
        const shipType = pickWeighted(npcType.ships);
        const npc = shipType && await buildNpc(
            gameData, npcType, shipType.id, budget, placement, false, post, now);
        return npc ? [[uuid(), npc]] : [];
    }

    const roster = composeFleetRoster({
        leaderShipId: npcType.fleet.leader.id,
        escorts: npcType.fleet.escorts.map(escort => ({
            shipId: escort.id,
            min: escort.min,
            max: escort.max,
        })),
    });
    const leader = await buildNpc(
        gameData, npcType, roster.leaderShipId, budget, placement, true,
        undefined, now);
    if (!leader) {
        return [];
    }
    const leaderUuid = uuid();
    const fleetId = uuid();
    leader.components.set(FleetMemberComponent, {
        fleetId, leaderUuid, role: 'leader' as const, slot: -1,
    });
    leader.components.set(TargetComponent, { target: undefined });
    const group: Array<[string, Entity]> = [[leaderUuid, leader]];

    const leaderMovement = leader.components.get(MovementStateComponent);
    for (const [slot, shipId] of roster.escortShipIds.entries()) {
        // An escort that does not fit in the entity budget is simply left out:
        // a smaller wing is better than refusing to spawn the fleet at all.
        let station: ArrivalPlacement | undefined;
        if (leaderMovement && placement) {
            const world = worldFormationPosition(
                leaderMovement, formationSlot(slot));
            station = {
                position: [world.x, world.y],
                rotation: placement.rotation,
                origin: placement.origin,
            };
        }
        const escort = await buildNpc(
            gameData, npcType, shipId, budget, station, true, undefined, now);
        if (!escort) {
            continue;
        }
        escort.components.set(FleetMemberComponent, {
            fleetId, leaderUuid, role: 'escort' as const, slot,
        });
        escort.components.set(TargetComponent, { target: undefined });
        group.push([uuid(), escort]);
    }
    return group;
}

/**
 * Resolve what a ship could plausibly have arrived from: the galaxy positions
 * of this system's hyperspace neighbours, and the stellars a ship could have
 * lifted off from.
 *
 * Live planet entities take precedence because their positions are authoritative
 * for the world currently being populated.
 */
function arrivalContext(
    gameData: GameDataInterface,
    systemData: SystemData,
    world: World,
): ArrivalContext {
    const neighbours = new Map<string, readonly [number, number]>();
    for (const link of systemData.links ?? []) {
        const linked = gameData.data.System.getCached(link);
        if (linked) {
            neighbours.set(link, linked.position);
        }
    }
    const liveStellars = new Map<string, ArrivalStellarCandidate>();
    for (const entity of world.entities.values()) {
        const planet = entity.components.get(PlanetComponent);
        const movement = entity.components.get(MovementStateComponent);
        if (!planet || !movement) {
            continue;
        }
        liveStellars.set(planet.id, {
            position: [movement.position.x, movement.position.y],
            inhabited: planet.inhabited,
        });
    }
    const stellars: ArrivalStellarCandidate[] = [];
    for (const id of systemData.planets ?? []) {
        const live = liveStellars.get(id);
        if (live) {
            stellars.push(live);
            continue;
        }
        const planet = gameData.data.Planet.getCached(id);
        if (planet) {
            // A barren rock has no traffic to launch, so the inhabited flag
            // decides which stellars can be a departure point.
            stellars.push(
                { position: planet.position, inhabited: planet.inhabited });
        }
    }
    return {
        system: {
            position: systemData.position ?? [0, 0],
            links: systemData.links ?? [],
            planets: systemData.planets ?? [],
        },
        neighbours,
        stellars,
    };
}

async function warmPlanetData(
    gameData: GameDataInterface,
    systemData: SystemData,
): Promise<void> {
    await Promise.all((systemData.planets ?? []).map(id =>
        gameData.data.Planet.get(id).catch(() => undefined)));
}

/**
 * Where a warship of `government` would stand guard in this system: one of its
 * own inhabited worlds. Kept general rather than keyed to Sol, because every
 * government's navy has the same reason to circle the worlds it holds.
 *
 * A cold cache simply means no patrol post this time, and the ship behaves as
 * it did before.
 */
function guardPost(
    gameData: GameDataInterface,
    systemData: SystemData | undefined,
    government: number | undefined,
): [number, number] | undefined {
    if (!systemData || government === undefined || government < 0) {
        return undefined;
    }
    const posts: [number, number][] = [];
    for (const id of systemData.planets ?? []) {
        const planet = gameData.data.Planet.getCached(id);
        if (planet && planet.inhabited
            && planet.government === government) {
            posts.push([planet.position[0], planet.position[1]]);
        }
    }
    return posts[Math.floor(Math.random() * posts.length)];
}

function applyPlacement(
    npc: Entity,
    placement: ArrivalPlacement,
    now: number,
): void {
    const movement = npc.components.get(MovementStateComponent);
    if (!movement) {
        return;
    }
    movement.position = new Position(
        placement.position[0], placement.position[1]);
    movement.rotation = new Angle(placement.rotation);
    movement.velocity = new Vector(0, 0);
    if (placement.origin === 'hyperspace') {
        npc.components.set(JumpStateComponent, {
            from: '',
            to: '',
            phase: 'arriving',
            phaseStartedAt: now,
            transitionAt: now + JUMP_ARRIVAL_MS,
            requiresAdjacency: false,
            arrivalSoundPending: false,
            createdAt: now,
        });
    }
}

function nextPlacement(
    gameData: GameDataInterface,
    systemData: SystemData | undefined,
    world: World,
): ArrivalPlacement | undefined {
    if (!systemData) {
        return undefined;
    }
    const context = arrivalContext(gameData, systemData, world);
    return chooseArrivalPlacement(
        context.system,
        context.neighbours,
        context.stellars,
        Math.random,
    );
}


/**
 * Load the named people once, in the background.
 *
 * This must never be awaited on the spawn path: an await there delays the very
 * spawn it is meant to inform. Until the list arrives, systems are populated by
 * anonymous traffic alone.
 */
/**
 * The loaded people are kept here rather than on the spawn state resource.
 * That state is handed to systems as an Immer draft whose proxy is revoked when
 * the step ends, so an async continuation writing into it would throw.
 */
const persByGameData = new WeakMap<GameDataInterface, PersData[]>();

/**
 * The plain spawn table for a world, held outside the state resource for the
 * same reason: these objects are read inside async spawn work, long after the
 * drafts handed to a step have been revoked.
 */
const spawnDataByWorld = new WeakMap<World, {
    entries: NpcSpawnData[],
    systemData: SystemData,
}>();
const persLoading = new WeakSet<GameDataInterface>();

/**
 * Load the named people once, in the background.
 *
 * This must never be awaited on the spawn path: an await there delays the very
 * spawn it is meant to inform. Until the list arrives, systems are populated by
 * anonymous traffic alone.
 */
function startLoadingPers(gameData: GameDataInterface): void {
    const gettable = gameData.data.Pers;
    if (persLoading.has(gameData) || !gettable) {
        return;
    }
    persLoading.add(gameData);
    void (async () => {
        try {
            const ids = (await gameData.ids).Pers ?? [];
            const people = await Promise.all(
                ids.map(id => gettable.get(id).catch(() => undefined)));
            persByGameData.set(gameData, people.filter(
                (person): person is PersData => person !== undefined));
        } catch (_error) {
            persByGameData.set(gameData, []);
        }
    })();
}

/**
 * Try to make this spawn somebody in particular. The Bible is explicit: "When
 * ships are created, there is a 5% chance that a specific AI-person will also
 * be created", and selectPers applies that roll.
 */
async function createPersNpc(
    gameData: GameDataInterface,
    world: World,
    systemId: string,
    budget: import('./entity_budget').EntityBudget,
    placement?: ArrivalPlacement,
    now = 0,
) {
    const people = persByGameData.get(gameData);
    if (!people?.length) {
        return undefined;
    }
    // Read the state store loosely rather than declaring it: PersPlugin owns
    // and deletes it, and a hard dependency would break world teardown.
    const states = world.resources.get(PersStateResource);
    const alive = new Set<string | number>();
    for (const person of people) {
        if (states?.get(person.id)?.alive !== false) {
            alive.add(person.id);
        }
    }
    const chosen = selectPers(people, { systemId, alive });
    if (!chosen) {
        return undefined;
    }
    try {
        // A pers already names its hull with a namespace, so prefixing again
        // asked for "nova:nova:151", missed, and gave every unique character
        // the default hull and its placeholder sprite.
        const shipData = await gameData.data.Ship.get(
            resourceId(chosen.shipType));
        const npc = makePersNpc(shipData, chosen, states?.get(chosen.id));
        if (!reserveEntity(budget, npc, 'ship')) {
            return undefined;
        }
        if (placement) {
            applyPlacement(npc, placement, now);
        }
        npc.components.set(MultiplayerData, { owner: "server" });
        return npc;
    } catch (_error) {
        return undefined;
    }
}

const NpcSpawnSystem = new AsyncSystem({
    name: "NpcSpawn",
    args: [
        SingletonComponent,
        GameDataResource,
        SystemIdResource,
        TimeResource,
        NpcSpawnStateResource,
        NpcShipsQuery,
        GetWorld,
        EntityBudgetResource,
    ] as const,
    exclusive: true,
    async step(_singleton, gameData, systemId, time, state, npcs, world, budget) {
        if (!activeWorlds.has(world) || state.disabled) {
            return;
        }

        if (!state.initialized) {
            let systemData;
            try {
                systemData = await gameData.data.System.get(systemId);
            } catch (_error) {
                state.initialized = true;
                state.disabled = true;
                console.log(`NPC spawn ${systemId}: no system data`);
                return;
            }

            state.initialized = true;
            state.target = getNpcTargetCount(systemData.avgShips);
            state.capacity = getNpcCapacity(state.target);
            state.entries = getSpawnEntries(systemData);
            state.systemData = systemData;
            startLoadingPers(gameData);
            if (state.entries.length === 0 || state.target === 0) {
                state.disabled = state.entries.length === 0;
                state.nextSpawnAt = Infinity;
                console.log(`NPC spawn ${systemId}: ${npcs.length}/${state.target}`);
                return;
            }

            await warmPlanetData(gameData, systemData);

            const room = Math.max(0, state.capacity - npcs.length);
            const target = state.target;
            const initialCount = Math.max(
                0,
                Math.min(target - npcs.length, room),
            );
            // Every draft read and write happens here, before the spawn loop
            // starts awaiting. Loading ship data lets the world step again,
            // which revokes these drafts and makes any later touch throw.
            const entries = getSpawnEntries(systemData);
            spawnDataByWorld.set(world, { entries, systemData });
            const existing = npcs.length;
            state.nextSpawnAt = time.time + getNpcRespawnDelay();
            let spawned = 0;
            for (let i = 0; i < initialCount; i++) {
                if (!activeWorlds.has(world)) {
                    return;
                }
                // A fleet fills several slots at once, so the target is
                // measured in ships rather than in spawn attempts.
                if (spawned >= initialCount) {
                    break;
                }
                const placement = nextPlacement(gameData, systemData, world);
                // The await must stay inside the branch: awaiting even an
                // immediate undefined costs a tick, and a batch of spawns is
                // expected to finish within the tick that asked for it.
                const named = persByGameData.get(gameData)?.length
                    ? await createPersNpc(
                        gameData, world, systemId, budget, placement,
                        time.time)
                    : undefined;
                const group: Array<[string, Entity]> = named
                    ? [[uuid(), named]]
                    : await createNpcGroup(
                        gameData, entries, budget, placement, systemData,
                        time.time);
                if (!activeWorlds.has(world)) {
                    for (const _member of group) {
                        budget.release('ship');
                    }
                    return;
                }
                for (const [id, member] of group) {
                    world.entities.set(id, member);
                    spawned++;
                }
            }
            console.log(
                `NPC spawn ${systemId}: ${existing + spawned}/${target}`);
            return;
        }

        if (time.time < state.nextSpawnAt || npcs.length >= state.target) {
            return;
        }

        state.nextSpawnAt = time.time + getNpcRespawnDelay();
        const spawnData = spawnDataByWorld.get(world);
        if (!spawnData) {
            return;
        }
        const target = state.target;
        const existing = npcs.length;
        const placement = nextPlacement(gameData, spawnData.systemData, world);
        const named = persByGameData.get(gameData)?.length
            ? await createPersNpc(
                gameData, world, systemId, budget, placement, time.time)
            : undefined;
        const group: Array<[string, Entity]> = named
            ? [[uuid(), named]]
            : await createNpcGroup(
                gameData, spawnData.entries, budget, placement,
                spawnData.systemData, time.time);
        if (group.length === 0 || !activeWorlds.has(world)) {
            if (!activeWorlds.has(world)) {
                for (const _member of group) {
                    budget.release('ship');
                }
            }
            return;
        }
        for (const [id, member] of group) {
            world.entities.set(id, member);
        }
        console.log(`NPC spawn ${systemId}: +${group.length} `
            + `(${existing + group.length}/${target})`);
    },
});

const activeWorlds = new WeakSet<World>();

export const NpcSpawnPlugin: Plugin = {
    name: "NpcSpawnPlugin",
    build(world) {
        activeWorlds.add(world);
        world.resources.set(NpcSpawnStateResource, {
            initialized: false,
            disabled: false,
            target: 0,
            capacity: 0,
            nextSpawnAt: 0,
            entries: [],
        });
        world.addSystem(NpcSpawnSystem);
    },
    remove(world) {
        activeWorlds.delete(world);
        world.removeSystem(NpcSpawnSystem);
        world.resources.delete(NpcSpawnStateResource);
    },
};
