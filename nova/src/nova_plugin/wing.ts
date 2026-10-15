import { Entity } from 'nova_ecs/entity';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import {
    ActiveMission,
    PlayerState,
    PlayerStateComponent,
    PlayerStorePort,
} from './player_state';
import {
    areSystemsSameOrVariants,
    SystemLookup,
    variantIndexForCatalog,
    visibleJumpTarget,
} from './system_variants';

/**
 * EV Nova mïsn ShipGoal values that represent combat / tactical objectives
 * suitable for co-op wing credit when wingmates fight together in the same
 * star system:
 * - 0: Destroy all special ships
 * - 1: Disable (and/or arrest) special ships
 * - 5: Rescue special ships from attackers
 * - 6: Chase off special ships (destroy or force jump)
 */
export const COMBAT_SHARED_SHIP_GOALS = new Set<number>([0, 1, 5, 6]);

export function isCombatSharedMissionGoal(goal: number | undefined): boolean {
    return goal !== undefined && COMBAT_SHARED_SHIP_GOALS.has(goal);
}

/**
 * Two pilots are wingmates when both carry the same non-empty `wingId`.
 */
export function areWingmates(
    a: Pick<PlayerState, 'wingId'> | undefined,
    b: Pick<PlayerState, 'wingId'> | undefined,
): boolean {
    const wingA = a?.wingId?.trim();
    const wingB = b?.wingId?.trim();
    return Boolean(wingA && wingB && wingA === wingB);
}

/**
 * Deterministic shared Wing ID for a pair or group of pilots. If the inviter
 * already belongs to a wing, joining extends that wing so 3+ pilots can fly
 * together; otherwise a canonical wing ID is minted.
 */
export function deriveWingId(
    inviterWingId: string | undefined,
    peerA: string,
    peerB: string,
): string {
    const existing = inviterWingId?.trim();
    if (existing) {
        return existing;
    }
    const sorted = [peerA, peerB].sort();
    return `wing:${sorted[0]}:${sorted[1]}`;
}

/**
 * Co-op Wing combat share awarded to assisting wingmates present in the same
 * system when a combat mission's ship goal completes.
 */
export function calculateWingCombatShare(payVal: number | undefined): number {
    if (!payVal || !Number.isFinite(payVal) || payVal <= 0) {
        return 2_500;
    }
    return Math.max(2_500, Math.floor(payVal * 0.25));
}

function sameId(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return false;
    return a === b || a.replace(/^.*:/, '') === b.replace(/^.*:/, '');
}

/**
 * Find all pilots in the current system room who should receive combat goal
 * progress when a mission ship in this system is destroyed, disabled, or
 * chased off:
 * 1. The mission ship's owner (if present in the system, or if one of their
 *    wingmates in the system scored the objective).
 * 2. Any wingmate in the **same system** who has an active combat mission with
 *    the same `missionId` (or an active combat mission targeting ships in this
 *    system).
 */
export function findCoopMissionGoalRecipients(
    players: readonly (readonly [string, { owner: string }, PlayerState])[],
    missionOwnerToken: string,
    missionUuid: string,
    store: PlayerStorePort | undefined,
    systemId?: string,
    systems?: SystemLookup,
): Array<{ playerUuid: string; missionUuid: string }> {
    const tokenOf = (mp: { owner: string }) =>
        store?.getTokenForPeer(mp.owner) ?? mp.owner;

    const ownerEntry = players.find(
        ([, mp]) => tokenOf(mp) === missionOwnerToken,
    );
    if (!ownerEntry) {
        return [];
    }

    const recipients: Array<{ playerUuid: string; missionUuid: string }> = [
        { playerUuid: ownerEntry[0], missionUuid },
    ];

    const ownerState = ownerEntry[2];
    if (!ownerState.wingId) {
        return recipients;
    }

    const ownerMission = ownerState.activeMissions.find(
        entry =>
            (entry.missionUuid ?? `${entry.missionId}:${entry.acceptedDate ?? 0}`)
            === missionUuid,
    );
    const goal = ownerMission?.shipGoalProgress?.goal;
    if (goal !== undefined && !isCombatSharedMissionGoal(goal)) {
        return recipients;
    }

    for (const [peerUuid, , peerState] of players) {
        if (peerUuid === ownerEntry[0] || !areWingmates(ownerState, peerState)) {
            continue;
        }
        for (const entry of peerState.activeMissions) {
            if (entry.state !== 'active' || entry.shipGoalProgress?.completed) {
                continue;
            }
            const peerGoal = entry.shipGoalProgress?.goal;
            if (!isCombatSharedMissionGoal(peerGoal)) {
                continue;
            }
            const sameMission = ownerMission
                ? sameId(entry.missionId, ownerMission.missionId)
                : false;
            const sameSystemFight = Boolean(
                systemId
                && entry.shipSystem
                && (entry.shipSystem === '*'
                    || sameId(entry.shipSystem, systemId)
                    || (systems && areSystemsSameOrVariants(
                        entry.shipSystem, systemId, systems))),
            );
            if (sameMission || sameSystemFight) {
                const peerMissionUuid =
                    entry.missionUuid ?? `${entry.missionId}:${entry.acceptedDate ?? 0}`;
                recipients.push({
                    playerUuid: peerUuid,
                    missionUuid: peerMissionUuid,
                });
                break;
            }
        }
    }

    return recipients;
}

/**
 * Resolve the jump destination for a pilot, preferring a wingmate's active
 * system variant when jumping toward the same system so wingmates arrive in
 * the exact same system room for co-op fights while remaining free to jump
 * anywhere on their own.
 */
export function resolveWingJumpTarget(
    nextSystem: string,
    currentSystemLinks: readonly string[],
    playerState: PlayerState | undefined,
    entities: ReadonlyMap<string, Entity> | undefined,
    systems: SystemLookup & { getCached(id: string): any },
     JumpingToGetter?: (entity: Entity) => string | undefined,
): string {
    const index = variantIndexForCatalog(systems);
    const ownTarget = visibleJumpTarget(
        nextSystem,
        currentSystemLinks,
        playerState?.missionBits,
        id => systems.getCached(id),
        index,
    );
    if (!playerState?.wingId || !entities) {
        return ownTarget;
    }

    for (const [, entity] of entities) {
        const peerMp = entity.components.get(MultiplayerData);
        const peerState = entity.components.get(PlayerStateComponent);
        if (!peerMp || peerMp.owner === 'server' || !peerState
            || peerState === playerState
            || !areWingmates(playerState, peerState)) {
            continue;
        }

        // 1. If a wingmate in the current system is already jumping to a
        // variant of `nextSystem`, follow them into that exact variant room.
        const peerJumpTo = JumpingToGetter?.(entity);
        if (peerJumpTo && areSystemsSameOrVariants(peerJumpTo, nextSystem, systems)) {
            return peerJumpTo;
        }

        // 2. If a wingmate has an active combat mission targeting a variant of
        // `nextSystem`, resolve `nextSystem` using the wingmate's missionBits
        // so both pilots enter the variant where the mission fleet spawns.
        const hasMissionInTarget = peerState.activeMissions.some(
            (entry: ActiveMission) =>
                entry.state === 'active'
                && Boolean(entry.shipSystem)
                && entry.shipSystem !== '*'
                && areSystemsSameOrVariants(entry.shipSystem!, nextSystem, systems),
        );
        if (hasMissionInTarget) {
            const wingmateVariant = visibleJumpTarget(
                nextSystem,
                currentSystemLinks,
                peerState.missionBits,
                id => systems.getCached(id),
                index,
            );
            if (areSystemsSameOrVariants(wingmateVariant, nextSystem, systems)) {
                return wingmateVariant;
            }
        }
    }

    return ownTarget;
}
