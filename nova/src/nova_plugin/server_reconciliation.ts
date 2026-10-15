import { resourceId, sameResourceId } from '../common/resource_id';
import type { PlayerState } from './player_state';

export interface RevisionCommitter {
    readonly retired: boolean;
    readonly balance: { revision: number };
    commit(): void;
}

type PendingServerBits = Map<number, { value: boolean; revision?: number }>;
// Mission bits the server authored (special-ship goals) that the owner has
// not yet acknowledged. Keyed by owning peer.
const serverMissionBits = new Map<string, PendingServerBits>();

type PendingStellar = { destroyed: boolean; regenAt?: number; revision?: number };
// Stellar destructions the server recorded for a pilot (spöb Strength
// broken by its weapons) that the owner has not yet acknowledged.
const serverStellars = new Map<string, Map<string, PendingStellar>>();

const playerStateEchoes = new Set<string>();

/** True once after an owner write had server mission progress merged in. */
export function takePlayerStateEcho(owner: string): boolean {
    return playerStateEchoes.delete(owner);
}

/** Copy with overrides, keeping the non-enumerable freeSpace getter. */
export function withPlayerStateOverrides(
    state: PlayerState,
    overrides: Partial<PlayerState>,
): PlayerState {
    const copy = { ...state, ...overrides } as PlayerState;
    const freeSpace = Object.getOwnPropertyDescriptor(state, 'freeSpace');
    if (freeSpace?.get) {
        Object.defineProperty(copy, 'freeSpace', freeSpace);
    }
    return copy;
}

/**
 * Remember server-authored mission bit changes until the owner has seen them.
 * With a combat authority the change is stamped with a fresh ledger revision,
 * which the next projection carries to the owner in the same PlayerState
 * delta; an owner write at or past that revision has observed the bits. Without
 * an authority (tests, legacy stores) echoing the value acknowledges it.
 */
export function recordServerMissionBits(
    owner: string,
    authority: RevisionCommitter | undefined,
    changes: Iterable<readonly [number, boolean]>,
): void {
    const list = [...changes];
    if (list.length === 0) return;
    let revision: number | undefined;
    if (authority && !authority.retired) {
        authority.commit();
        revision = authority.balance.revision;
    }
    let pending = serverMissionBits.get(owner);
    if (!pending) {
        pending = new Map();
        serverMissionBits.set(owner, pending);
    }
    for (const [bit, value] of list) {
        pending.set(bit, { value, revision });
    }
}

/**
 * Remember a server-authored stellar destruction (or regeneration) until the
 * owner has seen it: a stale full PlayerState from the owner must not
 * resurrect a stellar it destroyed or drop its regeneration date.
 */
export function recordServerStellarChanges(
    owner: string,
    authority: RevisionCommitter | undefined,
    changes: Iterable<{ id: string; destroyed: boolean; regenAt?: number }>,
): void {
    const list = [...changes];
    if (list.length === 0) return;
    let revision: number | undefined;
    if (authority && !authority.retired) {
        authority.commit();
        revision = authority.balance.revision;
    }
    let pending = serverStellars.get(owner);
    if (!pending) {
        pending = new Map();
        serverStellars.set(owner, pending);
    }
    for (const { id, destroyed, regenAt } of list) {
        pending.set(resourceId(id), { destroyed, regenAt, revision });
    }
}

/** A server-recorded destruction the owner has not acknowledged yet. */
export function hasPendingServerDestruction(
    owner: string,
    planetId: string,
): boolean {
    for (const [id, entry] of serverStellars.get(owner) ?? []) {
        if (entry.destroyed && sameResourceId(id, planetId)) return true;
    }
    return false;
}

function stellarMatches(
    state: PlayerState,
    id: string,
    entry: PendingStellar,
): boolean {
    const destroyed = state.destroyedStellars.some(stellar =>
        sameResourceId(stellar, id));
    if (destroyed !== entry.destroyed) return false;
    if (!entry.destroyed) return true;
    const regenKey = Object.keys(state.stellarRegen ?? {})
        .find(key => sameResourceId(key, id));
    const regenAt = regenKey === undefined ? undefined : state.stellarRegen![regenKey];
    return regenAt === entry.regenAt;
}

function mergeServerStellars(
    merged: PlayerState,
    owner: string,
    remoteRevision: number | undefined,
): Pick<PlayerState, 'destroyedStellars' | 'stellarRegen'> | undefined {
    const pending = serverStellars.get(owner);
    if (!pending) return undefined;
    let destroyedStellars = merged.destroyedStellars;
    let stellarRegen = merged.stellarRegen;
    let changed = false;
    for (const [id, entry] of pending) {
        const acknowledged = entry.revision !== undefined
            ? (remoteRevision ?? -1) >= entry.revision
            : stellarMatches(merged, id, entry);
        if (acknowledged) {
            pending.delete(id);
            continue;
        }
        const current = { ...merged, destroyedStellars, stellarRegen } as PlayerState;
        if (stellarMatches(current, id, entry)) continue;
        changed = true;
        destroyedStellars = destroyedStellars.filter(stellar =>
            !sameResourceId(stellar, id));
        const schedule = Object.fromEntries(Object.entries(stellarRegen ?? {})
            .filter(([key]) => !sameResourceId(key, id)));
        if (entry.destroyed) {
            destroyedStellars = [...destroyedStellars, id];
            if (entry.regenAt !== undefined) schedule[id] = entry.regenAt;
        }
        stellarRegen = schedule;
    }
    if (pending.size === 0) serverStellars.delete(owner);
    return changed ? { destroyedStellars, stellarRegen } : undefined;
}

function missionEntryKey(entry: PlayerState['activeMissions'][number]): string {
    return entry.missionUuid ?? `${entry.missionId}:${entry.acceptedDate ?? 0}`;
}

/**
 * Special-ship goal progress is recorded by the server, while the owner keeps
 * authoring the rest of its PlayerState and may send a complete copy taken
 * before the server's write. Goal counters are monotonic, so keep the larger
 * of each; a mission the server failed cannot be revived by a stale write.
 * Entries the owner removed (completed/aborted on landing) stay removed.
 */
export function mergeServerMissionProgress(
    local: PlayerState,
    merged: PlayerState,
    owner: string,
    remoteRevision: number | undefined,
): PlayerState {
    const localEntries = new Map(local.activeMissions?.map(entry =>
        [missionEntryKey(entry), entry] as const) ?? []);
    let activeMissions = merged.activeMissions;
    activeMissions?.forEach((entry, index) => {
        const server = localEntries.get(missionEntryKey(entry));
        if (!server) return;
        const serverProgress = server.shipGoalProgress;
        const ownerProgress = entry.shipGoalProgress;
        const failed = server.state === 'failed' && entry.state === 'active';
        let progress = ownerProgress;
        if (serverProgress && (!ownerProgress
            || serverProgress.goal !== ownerProgress.goal
            || serverProgress.total !== ownerProgress.total)) {
            progress = ownerProgress ?? serverProgress;
        } else if (serverProgress && ownerProgress) {
            progress = {
                ...ownerProgress,
                destroyed: Math.max(ownerProgress.destroyed, serverProgress.destroyed),
                disabled: Math.max(ownerProgress.disabled, serverProgress.disabled),
                boarded: Math.max(ownerProgress.boarded, serverProgress.boarded),
                observed: Math.max(ownerProgress.observed, serverProgress.observed),
                lost: Math.max(ownerProgress.lost, serverProgress.lost),
                completed: ownerProgress.completed || serverProgress.completed,
                shipDoneApplied: ownerProgress.shipDoneApplied
                    || serverProgress.shipDoneApplied,
            };
        }
        if (!failed && JSON.stringify(progress) === JSON.stringify(ownerProgress)) return;
        if (activeMissions === merged.activeMissions) activeMissions = [...activeMissions];
        activeMissions[index] = {
            ...entry,
            ...(failed ? { state: 'failed' as const } : {}),
            ...(progress ? { shipGoalProgress: progress } : {}),
        };
    });
    let missionBits = merged.missionBits;
    const pending = serverMissionBits.get(owner);
    if (pending) {
        for (const [bit, { value, revision }] of pending) {
            const acknowledged = revision !== undefined
                ? (remoteRevision ?? -1) >= revision
                : missionBits[bit] === value;
            if (acknowledged) {
                pending.delete(bit);
                continue;
            }
            if (missionBits[bit] !== value) {
                if (missionBits === merged.missionBits) missionBits = [...missionBits];
                missionBits[bit] = value;
            }
        }
        if (pending.size === 0) serverMissionBits.delete(owner);
    }
    const stellars = mergeServerStellars(merged, owner, remoteRevision);
    if (activeMissions === merged.activeMissions && missionBits === merged.missionBits
        && !stellars) {
        return merged;
    }
    // The merged value becomes the replication baseline without being sent,
    // so the owner would keep its stale copy. Ask the server to echo it.
    playerStateEchoes.add(owner);
    return withPlayerStateOverrides(merged, { activeMissions, missionBits, ...stellars });
}
