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
import { GovtComponent } from "./npc_plugin";
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
        npc.components.set(
            NpcCombatRoleComponent,
            npcType.combatRole ?? "personal",
        );
        npc.components.set(MultiplayerData, { owner: "server" });
        return npc;
    } catch (_error) {
        // A bad or incomplete data entry should not stop other systems from
        // spawning. The concise population log reports the resulting count.
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
                const npc = await createNpc(gameData, state.entries, budget);
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
        const npc = await createNpc(gameData, state.entries, budget);
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
