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
import { Angle } from "nova_ecs/datatypes/angle";
import { Position } from "nova_ecs/datatypes/position";
import { Vector } from "nova_ecs/datatypes/vector";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { SystemData } from "novadatainterface/SystemData";
import { PersData } from "novadatainterface/PersData";
import { Entity } from "nova_ecs/entity";
import { selectPers } from "./pers";
import { makePersNpc, PersStateResource } from "./pers_plugin";
import {
    ArrivalPlacement,
    ArrivalSystem,
    chooseArrivalPlacement,
} from "./npc_arrival";
import { GovtComponent } from "./npc_plugin";
import { DudeSourceComponent } from "./boarding_plugin";
import { createArrivingTrafficState } from "./npc_traffic";
import { NpcTrafficComponent } from "./npc_traffic_plugin";
import { makeNpc } from "./npc_plugin";
import {
    NpcAIComponent,
    NpcCombatRoleComponent,
} from "./npc_components";
import { SystemIdResource } from "./system_id_resource";
import { SingletonComponent, World } from "nova_ecs/world";
import { EntityBudgetResource, reserveEntity } from "./entity_budget";


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
    /** The named people who could turn up here, once loaded. */
    pers?: PersData[];
    persLoading?: boolean;
}

interface ArrivalContext {
    system: ArrivalSystem;
    neighbours: Map<string, readonly [number, number]>;
    stellars: (readonly [number, number])[];
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

async function createNpc(
    gameData: GameDataInterface,
    entries: readonly NpcSpawnData[],
    budget: import('./entity_budget').EntityBudget,
    placement?: ArrivalPlacement,
) {
    const npcType = pickWeighted(entries);
    if (!npcType) {
        return undefined;
    }
    const shipType = pickWeighted(npcType.ships);
    if (!shipType) {
        return undefined;
    }

    try {
        const shipData = await gameData.data.Ship.get(shipType.id);
        const npc = makeNpc(shipData);
        if (!reserveEntity(budget, npc, 'ship')) {
            return undefined;
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
        // an interceptor or a miner.
        npc.components.set(
            NpcTrafficComponent, createArrivingTrafficState());
        if (placement) {
            applyPlacement(npc, placement);
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
 * Resolve what a ship could plausibly have arrived from: the galaxy positions
 * of this system's hyperspace neighbours, and the stellars a ship could have
 * lifted off from.
 *
 * Deliberately synchronous and cache-only. Awaiting these lookups would delay
 * the spawn that needs them, and a cold cache is harmless: the ship simply
 * enters on an arbitrary bearing until the data is warm.
 */
function arrivalContext(
    gameData: GameDataInterface,
    systemData: SystemData,
): ArrivalContext {
    const neighbours = new Map<string, readonly [number, number]>();
    for (const link of systemData.links ?? []) {
        const linked = gameData.data.System.getCached(link);
        if (linked) {
            neighbours.set(link, linked.position);
        }
    }
    const stellars: (readonly [number, number])[] = [];
    for (const id of systemData.planets ?? []) {
        const planet = gameData.data.Planet.getCached(id);
        if (planet) {
            stellars.push(planet.position);
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

function applyPlacement(npc: Entity, placement: ArrivalPlacement): void {
    const movement = npc.components.get(MovementStateComponent);
    if (!movement) {
        return;
    }
    movement.position = new Position(
        placement.position[0], placement.position[1]);
    movement.rotation = new Angle(placement.rotation);
    movement.velocity = new Vector(0, 0);
}

function nextPlacement(
    gameData: GameDataInterface,
    state: NpcSpawnState,
): ArrivalPlacement | undefined {
    if (!state.systemData) {
        return undefined;
    }
    const context = arrivalContext(gameData, state.systemData);
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
function startLoadingPers(
    gameData: GameDataInterface,
    state: NpcSpawnState,
): void {
    const gettable = gameData.data.Pers;
    if (state.persLoading || !gettable) {
        return;
    }
    state.persLoading = true;
    void (async () => {
        try {
            const ids = (await gameData.ids).Pers ?? [];
            const people = await Promise.all(
                ids.map(id => gettable.get(id).catch(() => undefined)));
            state.pers = people.filter(
                (person): person is PersData => person !== undefined);
        } catch (_error) {
            state.pers = [];
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
    state: NpcSpawnState,
    budget: import('./entity_budget').EntityBudget,
    placement?: ArrivalPlacement,
) {
    if (!state.pers?.length) {
        return undefined;
    }
    // Read the state store loosely rather than declaring it: PersPlugin owns
    // and deletes it, and a hard dependency would break world teardown.
    const states = world.resources.get(PersStateResource);
    const alive = new Set<string | number>();
    for (const person of state.pers) {
        if (states?.get(person.id)?.alive !== false) {
            alive.add(person.id);
        }
    }
    const chosen = selectPers(state.pers, { systemId, alive });
    if (!chosen) {
        return undefined;
    }
    try {
        const shipData = await gameData.data.Ship.get(
            `nova:${chosen.shipType}`);
        const npc = makePersNpc(shipData, chosen, states?.get(chosen.id));
        if (!reserveEntity(budget, npc, 'ship')) {
            return undefined;
        }
        if (placement) {
            applyPlacement(npc, placement);
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
            startLoadingPers(gameData, state);
            if (state.entries.length === 0 || state.target === 0) {
                state.disabled = state.entries.length === 0;
                state.nextSpawnAt = Infinity;
                console.log(`NPC spawn ${systemId}: ${npcs.length}/${state.target}`);
                return;
            }

            const room = Math.max(0, state.capacity - npcs.length);
            const initialCount = Math.max(
                0,
                Math.min(state.target - npcs.length, room),
            );
            let spawned = 0;
            for (let i = 0; i < initialCount; i++) {
                if (!activeWorlds.has(world)) {
                    return;
                }
                const placement = nextPlacement(gameData, state);
                // The await must stay inside the branch: awaiting even an
                // immediate undefined costs a tick, and a batch of spawns is
                // expected to finish within the tick that asked for it.
                const named = state.pers?.length
                    ? await createPersNpc(
                        gameData, world, systemId, state, budget, placement)
                    : undefined;
                const npc = named ?? await createNpc(
                        gameData, state.entries, budget, placement);
                if (!activeWorlds.has(world)) {
                    if (npc) {
                        budget.release('ship');
                    }
                    return;
                }
                if (npc) {
                    world.entities.set(uuid(), npc);
                    spawned++;
                }
            }
            state.nextSpawnAt = time.time + getNpcRespawnDelay();
            console.log(`NPC spawn ${systemId}: ${npcs.length + spawned}/${state.target}`);
            return;
        }

        if (time.time < state.nextSpawnAt || npcs.length >= state.target) {
            return;
        }

        state.nextSpawnAt = time.time + getNpcRespawnDelay();
        const placement = nextPlacement(gameData, state);
        const named = state.pers?.length
            ? await createPersNpc(
                gameData, world, systemId, state, budget, placement)
            : undefined;
        const npc = named
            ?? await createNpc(gameData, state.entries, budget, placement);
        if (!npc || !activeWorlds.has(world)) {
            if (npc && !activeWorlds.has(world)) {
                budget.release('ship');
            }
            return;
        }
        world.entities.set(uuid(), npc);
        console.log(`NPC spawn ${systemId}: +1 (${npcs.length + 1}/${state.target})`);
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
