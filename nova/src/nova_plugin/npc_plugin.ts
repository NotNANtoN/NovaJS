import { ShipData } from "novadatainterface/ShipData";
import { GameDataInterface } from "novadatainterface/GameDataInterface";
import { WeaponData } from "novadatainterface/WeaponData";
import { Emit, Entities, GetEntity, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { Plugin } from "nova_ecs/plugin";
import { DeltaResource } from "nova_ecs/plugins/delta_plugin";
import { MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import {
    MovementPhysicsComponent,
    MovementState,
    MovementStateComponent,
} from "nova_ecs/plugins/movement_plugin";
import { Optional } from "nova_ecs/optional";
import { PlatformResource } from "./platform_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { Query } from "nova_ecs/query";
import { System } from "nova_ecs/system";
import { Angle } from "nova_ecs/datatypes/angle";
import { DeathEvent, PlayerDeathComponent } from "./death_plugin";
import { ArmorComponent, ShieldComponent } from "./health_plugin";
import { DestructionStartedComponent } from "./destruction_state";
import {
    GovernmentData,
    GovernmentFlags,
    GovernmentRelationResource,
    GovernmentRelationStore,
    canTargetPlayer,
} from "./govt_relations";
import { makeShip } from "./make_ship";
import { getShipAIProfile } from "./ship_ai_profile";
import { ShipDataComponent } from "./ship_plugin";
import { ShipComponent } from "./ship_plugin";
import { TargetComponent } from "./target_component";
import { WeaponsStateComponent } from "./weapons_state";
import { GameDataResource } from "./game_data_resource";
import {
    NpcHostilitySystems,
    ProvocationResource,
    createProvocationState,
    isPersonallyProvoked,
    isProvoked,
} from "./npc_hostility";
import {
    ChooseRandomTargetComponent,
    GovtData as GovtDataCodec,
    GovtComponent,
    NpcAIComponent,
    NpcCombatRoleComponent,
} from "./npc_components";
import type { GovtData } from "./npc_components";
import { createMinerSystems, MiningShipProvider } from "./miner_ai";
import { PlayerState, PlayerStateComponent } from "./player_state";
import { isCriminal, recordFor } from "./legal_record";
import { approachTarget, fleeFromTarget } from "./flight_controller";
import type { WeaponsState } from "./weapons_state";
import { PlanetComponent } from "./planet_plugin";
import {
    InitiateJumpEvent,
    JumpStateComponent,
} from "./jump_plugin";
import { SystemIdResource } from "./system_id_resource";
export {
    ChooseRandomTargetComponent,
    GovtComponent,
    NpcAIComponent,
    NpcCombatRoleComponent,
} from "./npc_components";
export type { GovtData } from "./npc_components";

const TargetsQuery = new Query([
    UUID,
    MovementStateComponent,
    MultiplayerData,
    Optional(GovtComponent),
    Optional(PlayerDeathComponent),
    ShipComponent,
    Optional(ShipDataComponent),
    Optional(ShieldComponent),
    Optional(PlayerStateComponent),
] as const);

type TargetCandidate = readonly [
    string,
    MovementState,
    { owner: string },
    GovtData | undefined,
    { respawnAt?: number, wreckPosition: [number, number] } | undefined,
    { id: string },
    ShipData | undefined,
    { current: number, max: number } | undefined,
    PlayerState | undefined,
];

/**
 * Interceptor AI is the Bible's "piracy police": it attacks a ship reported
 * for firing on or attempting to board another non-enemy ship while watching.
 * A world is one star system, so its live provocation reports are the
 * interceptor's current observation scope.
 */
export function isInterceptorPiracyTarget(
    provocations: ReturnType<typeof createProvocationState>,
    selfGovernmentId: number,
    targetId: string,
    relationFor: (
        actorGovernment: number,
        victimGovernment: number,
    ) => "ally" | "neutral" | "enemy" | undefined,
): boolean {
    for (const [victimGovernment, reports] of
        provocations.threatReportsByGovernment) {
        if (!reports.has(targetId)) {
            continue;
        }
        if (victimGovernment === selfGovernmentId) {
            return true;
        }
        const relation = relationFor(selfGovernmentId, victimGovernment);
        if (relation === "ally" || relation === "neutral") {
            return true;
        }
    }
    return false;
}

function getValidTargets(
    targets: readonly TargetCandidate[],
    selfUuid: string,
    selfGovernmentId: number,
    selfGovernment: GovernmentData,
    relationStore: GovernmentRelationStore,
    provocations: ReturnType<typeof createProvocationState>,
    canAssistGovernment: boolean,
    initiatesCombat = true,
    policesPiracy = false,
): string[] {
    return targets
        .filter(([
            targetId,
            _movement,
            multiplayer,
            targetGovernment,
            playerDeath,
            _ship,
            _shipData,
            _shield,
            playerState,
        ]) => {
            if (targetId === selfUuid) {
                return false;
            }
            if (playerDeath) {
                return false;
            }
            const personal = isPersonallyProvoked(
                provocations, selfUuid, targetId);
            const policeTarget = policesPiracy
                && isInterceptorPiracyTarget(
                    provocations,
                    selfGovernmentId,
                    targetId,
                    (actor, victim) => relationStore.relation(actor, victim),
                );

            if (multiplayer.owner !== "server") {
                // A record past this government's tolerance makes the player
                // a standing target, unlike a provocation which fades.
                const record = recordFor(
                    playerState?.legalRecords,
                    selfGovernment.id,
                    selfGovernment,
                );
                const hunted = isCriminal(
                    record, selfGovernment.crimeTolerance ?? 0);
                return canTargetPlayer(
                    selfGovernment,
                    personal || hunted || policeTarget
                    || canAssistGovernment && isProvoked(
                        provocations,
                        selfGovernmentId,
                        targetId,
                        (actor, victim) => relationStore.relation(actor, victim),
                    ),
                );
            }

            if (!targetGovernment) {
                return false;
            }
            if (targetGovernment.id === selfGovernmentId) {
                return false;
            }

            const relation = relationStore.relation(
                selfGovernmentId,
                targetGovernment.id,
            );
            if (relation === "ally") {
                return false;
            }
            // A trader hull shares its government's enemies but not its
            // appetite for a fight: it shoots back, and helps when its own
            // side is already fighting, yet never opens fire itself.
            return relation === "enemy" && initiatesCombat || personal
                || policeTarget
                || canAssistGovernment && isProvoked(
                provocations,
                selfGovernmentId,
                targetId,
                (actor, victim) => relationStore.relation(actor, victim),
            );
        })
        .map(([uuid]) => uuid);
}

export const MIN_SHIELD_STRENGTH_FRACTION = 0.3;
export const RETREAT_SHIELD_FRACTION = 0.25;

export interface CombatStrengthInput {
    strength: number;
    shield?: { current: number, max: number };
}

/**
 * Bible, gövt/MaxOdds: a ship's Strength is "modified from between 30% and
 * 100% of that value depending on the ship's present shield stat".
 */
export function shieldScaledStrength(
    combatant: CombatStrengthInput,
): number {
    const strength = Number.isFinite(combatant.strength)
        ? Math.max(0, combatant.strength) : 0;
    const shieldFraction = combatant.shield && combatant.shield.max > 0
        ? Math.max(0, Math.min(
            1,
            combatant.shield.current / combatant.shield.max,
        ))
        : 0;
    return strength * (
        MIN_SHIELD_STRENGTH_FRACTION
        + (1 - MIN_SHIELD_STRENGTH_FRACTION) * shieldFraction
    );
}

/**
 * Bible, gövt/MaxOdds: 100 is one-to-one, 200 is two-to-one, and a ship
 * engages only when enemy strength is within that multiple of friendly
 * strength.
 */
export function combatOddsAreFavorable(
    friends: readonly CombatStrengthInput[],
    enemies: readonly CombatStrengthInput[],
    maxOdds: number,
): boolean {
    const friendlyStrength = friends.reduce(
        (total, ship) => total + shieldScaledStrength(ship), 0);
    const enemyStrength = enemies.reduce(
        (total, ship) => total + shieldScaledStrength(ship), 0);
    if (enemyStrength <= 0) {
        return true;
    }
    const odds = Number.isFinite(maxOdds) ? Math.max(0, maxOdds) : 0;
    return friendlyStrength > 0
        && enemyStrength * 100 <= friendlyStrength * odds;
}

export function shouldWarshipRetreat(
    profile: ReturnType<typeof getShipAIProfile>,
    government: Pick<GovernmentData, 'flags'>,
    shield: { current: number, max: number } | undefined,
): boolean {
    return profile.role === "warship"
        && Boolean((government.flags ?? 0) & GovernmentFlags.warshipsRetreat)
        && Boolean(shield && shield.max > 0
            && shield.current / shield.max < RETREAT_SHIELD_FRACTION);
}

export function shouldFleeFromAttacker(
    profile: ReturnType<typeof getShipAIProfile>,
    personallyProvoked: boolean,
    attackerDistance: number,
    weaponRange: number,
): boolean {
    if (!personallyProvoked) {
        return false;
    }
    if (profile.fleesWhenAttacked) {
        return true;
    }
    return profile.breaksOffOutOfRange
        && attackerDistance > Math.max(0, weaponRange);
}

function combatStrengthOf(
    candidate: TargetCandidate,
): CombatStrengthInput | undefined {
    const ship = candidate[6];
    return ship ? {
        strength: ship.strength,
        shield: candidate[7],
    } : undefined;
}

function hasUnresolvedTargetGovernment(
    targets: readonly TargetCandidate[],
    selfUuid: string,
    selfGovernmentId: number,
    governments: GovernmentRelationStore,
): boolean {
    return targets.some(candidate => {
        const government = candidate[3];
        return candidate[0] !== selfUuid
            && government !== undefined
            && government.id !== selfGovernmentId
            && governments.getCached(government.id) === undefined;
    });
}

export const ChooseRandomTargetAI = new System({
    name: 'ChooseRandomTarget',
    args: [TargetComponent, TargetsQuery, ChooseRandomTargetComponent,
        TimeResource, UUID, MovementStateComponent, Entities, GovernmentRelationResource,
        ProvocationResource, MultiplayerData, PlatformResource,
        GovtComponent, NpcAIComponent, NpcCombatRoleComponent,
        Optional(ShipDataComponent),
        Optional(DestructionStartedComponent),
        Optional(ArmorComponent)] as const,
    step(target, targets, randomTargetData, time, uuid, movementState, entities,
        relationStore, provocations, multiplayer, platform, government,
        _npcAI, combatRole, shipData, destructionStarted, armor) {
        if (platform !== "node" || multiplayer.owner !== "server") {
            return;
        }
        if (destructionStarted || armor && armor.current <= 0) {
            target.target = undefined;
            return;
        }

        const currentCandidate = target.target
            ? targets.find(candidate => candidate[0] === target.target)
            : undefined;
        if (target.target && (
            target.target === uuid
            || !currentCandidate
            || currentCandidate[4] !== undefined
            || currentCandidate[3]?.id === government.id
            || currentCandidate[3] !== undefined
            && relationStore.relation(
                government.id,
                currentCandidate[3].id,
            ) === "ally"
        )) {
            target.target = undefined;
        }

        if ((randomTargetData.nextTime ?? 0) > time.time &&
            target.target && entities.has(target.target)) {
            return;
        }

        const selfGovernment = relationStore.getCached(government.id);
        if (!selfGovernment) {
            // Government data is asynchronous. Retry promptly once it has
            // arrived instead of waiting for the normal target interval.
            randomTargetData.nextTime = time.time + 100;
            target.target = undefined;
            return;
        }

        randomTargetData.nextTime = time.time + randomTargetData.interval;
        const profile = shipData ? getShipAIProfile(shipData) : undefined;
        const validTargets = getValidTargets(
            targets,
            uuid,
            government.id,
            selfGovernment,
            relationStore,
            provocations,
            combatRole === "military",
            profile?.initiatesCombat ?? true,
            profile?.policesPiracy ?? false,
        );
        if (hasUnresolvedTargetGovernment(
            targets,
            uuid,
            government.id,
            relationStore,
        )) {
            randomTargetData.nextTime = time.time + 100;
            target.target = undefined;
            return;
        }

        const candidateByUuid = new Map(
            targets.map(candidate => [candidate[0], candidate] as const),
        );
        if (shipData && selfGovernment.maxOdds !== undefined
            && validTargets.length > 0) {
            const targetIds = new Set(validTargets);
            const friendCandidates = targets.filter(candidate => {
                const candidateGovernment = candidate[3];
                return candidate[0] === uuid
                    || candidateGovernment !== undefined
                    && (
                        candidateGovernment.id === government.id
                        || relationStore.relation(
                            government.id,
                            candidateGovernment.id,
                        ) === "ally"
                    );
            });
            const enemyCandidates = targets
                .filter(candidate => targetIds.has(candidate[0]));
            if ([...friendCandidates, ...enemyCandidates]
                .some(candidate => combatStrengthOf(candidate) === undefined)) {
                randomTargetData.nextTime = time.time + 100;
                target.target = undefined;
                return;
            }
            const friends = friendCandidates
                .map(combatStrengthOf) as CombatStrengthInput[];
            const enemies = enemyCandidates
                .map(combatStrengthOf) as CombatStrengthInput[];
            if (!combatOddsAreFavorable(
                friends,
                enemies,
                selfGovernment.maxOdds,
            )) {
                target.target = undefined;
                return;
            }
        }
        const selected = validTargets
            .map(targetId => candidateByUuid.get(targetId))
            .filter(candidate => candidate !== undefined)
            .sort((a, b) => {
                const distanceA = a[1].position.subtract(movementState.position)
                    .lengthSquared;
                const distanceB = b[1].position.subtract(movementState.position)
                    .lengthSquared;
                return distanceA - distanceB || a[0].localeCompare(b[0]);
            })[0];

        target.target = selected?.[0];
    }
});

export const FollowComponent = new Component<undefined>('FollowComponent');

export const DEFAULT_COMBAT_STANDOFF = 300;
export const COMBAT_RANGE_FRACTION = 0.6;
export const MAX_COMBAT_STANDOFF = 600;

function weaponRange(weapon: WeaponData): number | undefined {
    if (weapon.type === "BayWeaponData"
        || weapon.fireGroup === "pointDefense") {
        return;
    }
    if (weapon.type === "BeamWeaponData") {
        return weapon.beamAnimation.length;
    }
    return weapon.physics.speed * weapon.shotDuration / 1000;
}

export function getMaximumWeaponRange(
    weapons: WeaponsState | undefined,
    gameData: GameDataInterface,
): number {
    let longestRange = 0;
    for (const [id, state] of weapons ?? []) {
        if (state.count <= 0) {
            continue;
        }
        const weapon = gameData.data.Weapon.getCached(id);
        if (!weapon) {
            continue;
        }
        longestRange = Math.max(longestRange, weaponRange(weapon) ?? 0);
    }
    return longestRange;
}

/**
 * Long-range weapons should influence positioning without letting an NPC
 * exploit every last unit of nominal range, where target motion would make
 * projectiles expire before connecting.
 */
export function getCombatStandoff(
    weapons: WeaponsState | undefined,
    gameData: GameDataInterface,
    standoffMultiplier = 1,
): number {
    const longestRange = getMaximumWeaponRange(weapons, gameData);
    if (!(longestRange > 0)) {
        return DEFAULT_COMBAT_STANDOFF * standoffMultiplier;
    }
    return Math.min(
        MAX_COMBAT_STANDOFF,
        longestRange * COMBAT_RANGE_FRACTION * standoffMultiplier,
    );
}

export interface NpcFleeState {
    threat: string;
    distance: number;
    reason: "attacked" | "out-of-range" | "retreat";
}
export const NpcFleeComponent =
    new Component<NpcFleeState>("NpcFleeComponent");
const NpcDepartureComponent =
    new Component<undefined>("NpcDepartureComponent");

function departureSystem(
    gameData: GameDataInterface,
    systemId: string,
): string | undefined {
    const destination = gameData.data.System.getCached(systemId)?.links[0];
    if (!destination || !gameData.data.System.getCached(destination)) {
        return undefined;
    }
    return destination;
}

export const NpcPurposeAI = new System({
    name: "NpcPurposeAI",
    after: [ChooseRandomTargetAI],
    args: [
        TargetComponent,
        UUID,
        GetEntity,
        Entities,
        TargetsQuery,
        MovementStateComponent,
        Optional(WeaponsStateComponent),
        GameDataResource,
        ShipDataComponent,
        GovtComponent,
        GovernmentRelationResource,
        ProvocationResource,
        Optional(ShieldComponent),
        Optional(NpcFleeComponent),
        Optional(NpcDepartureComponent),
        Optional(JumpStateComponent),
        // A world without a system id, such as a focused test harness, simply
        // has nowhere to jump to; that must not stop NpcPlugin from loading.
        Optional(SystemIdResource),
        Emit,
        MultiplayerData,
        PlatformResource,
        NpcAIComponent,
        Optional(DestructionStartedComponent),
        Optional(ArmorComponent),
    ] as const,
    step(target, uuid, entity, entities, targets, movement, weapons, gameData,
        shipData, governmentRef, governments, provocations, shield, fleeing,
        departing, jumpState, systemId, emit, multiplayer, platform, _npc,
        destructionStarted, armor) {
        if (platform !== "node" || multiplayer.owner !== "server"
            || destructionStarted || armor && armor.current <= 0) {
            entity.components.delete(NpcFleeComponent);
            return;
        }

        const profile = getShipAIProfile(shipData);
        const government = governments.getCached(governmentRef.id);
        if (!government) {
            return;
        }

        const targetId = target.target;
        const targetEntity = targetId ? entities.get(targetId) : undefined;
        const targetMovement = targetEntity?.components
            .get(MovementStateComponent);
        const targetDistance = targetMovement
            ? targetMovement.position.subtract(movement.position).length
            : 0;
        const personallyProvoked = Boolean(targetId
            && isPersonallyProvoked(provocations, uuid, targetId));
        const weaponRange = getMaximumWeaponRange(weapons, gameData);
        const governmentRetreat = shouldWarshipRetreat(
            profile, government, shield);
        const fleeFromAttacker = Boolean(targetId && targetMovement
            && shouldFleeFromAttacker(
                profile,
                personallyProvoked,
                targetDistance,
                weaponRange,
            ));

        if (targetId && targetMovement
            && (governmentRetreat || fleeFromAttacker)) {
            const reason = governmentRetreat
                ? "retreat"
                : profile.fleesWhenAttacked ? "attacked" : "out-of-range";
            // The Bible specifies when running starts but not a manoeuvring
            // distance. Receding by the existing fallback combat standoff each
            // controller step keeps the ship running until the threat breaks.
            const state: NpcFleeState = {
                threat: targetId,
                distance: targetDistance + DEFAULT_COMBAT_STANDOFF,
                reason,
            };
            if (fleeing) {
                Object.assign(fleeing, state);
            } else {
                entity.components.set(NpcFleeComponent, state);
            }
        } else {
            entity.components.delete(NpcFleeComponent);
        }

        const shouldLeave = governmentRetreat
            || profile.jumpsWithoutEnemies && !target.target
            && !hasUnresolvedTargetGovernment(
                targets,
                uuid,
                governmentRef.id,
                governments,
            );
        if (!shouldLeave || departing || jumpState || !systemId) {
            return;
        }
        const destination = departureSystem(gameData, systemId);
        if (!destination) {
            return;
        }
        entity.components.set(NpcDepartureComponent, undefined);
        emit(InitiateJumpEvent, { to: destination }, [uuid]);
    },
});

const ParkingPlanetsQuery = new Query([
    MovementStateComponent,
    PlanetComponent,
] as const, "NpcParkingPlanets");

export const ParkInterceptorAI = new System({
    name: "ParkInterceptorAI",
    after: [NpcPurposeAI],
    args: [
        MovementStateComponent,
        MovementPhysicsComponent,
        TargetComponent,
        ParkingPlanetsQuery,
        ShipDataComponent,
        MultiplayerData,
        PlatformResource,
        NpcAIComponent,
        Optional(NpcFleeComponent),
        Optional(JumpStateComponent),
        Optional(DestructionStartedComponent),
        Optional(ArmorComponent),
    ] as const,
    step(movement, physics, target, planets, shipData, multiplayer, platform,
        _npc, fleeing, jumpState, destructionStarted, armor) {
        const profile = getShipAIProfile(shipData);
        if (platform !== "node" || multiplayer.owner !== "server"
            || target.target || !profile.parksWithoutEnemies || fleeing
            || jumpState || destructionStarted || armor && armor.current <= 0) {
            return;
        }
        const planet = planets
            .map(([candidate]) => candidate)
            .sort((a, b) => {
                const distanceA =
                    a.position.subtract(movement.position).lengthSquared;
                const distanceB =
                    b.position.subtract(movement.position).lengthSquared;
                return distanceA - distanceB;
            })[0];
        if (!planet) {
            return;
        }
        // "Parks in orbit" has no radius in the Bible. The existing fallback
        // combat standoff gives a stable nearby station without overlapping
        // the stellar.
        const command = approachTarget(movement, planet, physics, {
            standoff: DEFAULT_COMBAT_STANDOFF,
        });
        movement.turnTo = command.turnTo;
        movement.accelerating = command.accelerating;
        movement.turnBack = command.turnBack;
    },
});

export const FollowAI = new System({
    name: 'FollowAndShootAI',
    args: [MovementStateComponent, MovementPhysicsComponent, TargetComponent,
        FollowComponent, Entities, MultiplayerData, PlatformResource,
        Optional(WeaponsStateComponent), GameDataResource,
        Optional(ShipDataComponent),
        Optional(NpcFleeComponent),
        Optional(DestructionStartedComponent),
        Optional(ArmorComponent)] as const,
    step(movementState, physics, target, _follow, entities, multiplayer,
        platform, weapons, gameData, shipData, fleeing, destructionStarted,
        armor) {
        if (platform === "node" && multiplayer.owner !== "server"
            || platform === "browser" && multiplayer.owner === "server") {
            return;
        }
        if (destructionStarted || armor && armor.current <= 0) {
            movementState.turnTo = null;
            movementState.accelerating = 0;
            return;
        }
        if (!target.target) {
            return;
        }
        if (!entities.has(target.target)) {
            target.target = undefined;
            movementState.turnTo = null;
            movementState.accelerating = 0;
            return;
        }
        const targetMovement = entities.get(target.target)
            ?.components.get(MovementStateComponent);
        if (!targetMovement) {
            movementState.turnTo = null;
            movementState.accelerating = 0;
            return;
        }
        const command = fleeing?.threat === target.target
            ? fleeFromTarget(
                movementState,
                targetMovement,
                physics,
                { distance: fleeing.distance },
            )
            : approachTarget(movementState, targetMovement, physics, {
                standoff: getCombatStandoff(
                    weapons,
                    gameData,
                    shipData
                        ? getShipAIProfile(shipData).weaponStandoffMultiplier
                        : 1,
                ),
            });
        // Once holding station the controller has no thrust to aim, so the
        // nose would keep whatever heading braking left it with — pointing
        // away from the target, where fixed guns are useless. Tracking the
        // target by uuid lets the movement system keep it under the guns.
        movementState.turnTo = fleeing
            ? command.turnTo
            : command.turnTo ?? target.target;
        movementState.accelerating = command.accelerating;
        movementState.turnBack = command.turnBack;
    }
});

export const ShootAllWeaponsComponent = new Component<undefined>('ShootAllWeaponsComponent');
export const ShootAllWeaponsAI = new System({
    name: 'ShootAllWeaponsAI',
    args: [WeaponsStateComponent, GameDataResource, TargetComponent,
        ShootAllWeaponsComponent, Entities, MultiplayerData,
        PlatformResource, Optional(DestructionStartedComponent),
        Optional(ArmorComponent), Optional(NpcFleeComponent)] as const,
    step(weapons, gameData, target, _shoot, entities, multiplayer, platform,
        destructionStarted, armor, fleeing) {
        if (platform === "node" && multiplayer.owner !== "server"
            || platform === "browser" && multiplayer.owner === "server") {
            return;
        }
        if (destructionStarted || armor && armor.current <= 0 || fleeing) {
            for (const weapon of weapons.values()) {
                weapon.firing = false;
                weapon.target = undefined;
            }
            return;
        }
        const targetUuid = target.target;
        if (targetUuid && !entities.has(targetUuid)) {
            target.target = undefined;
        }
        for (const [id, weapon] of weapons) {
            const weaponType = gameData.data.Weapon.getCached(id)?.type;
            if (weaponType == null || weaponType === 'BayWeaponData') {
                // do not use bay weapons yet since there is no ammo limit.
                continue;
            };
            weapon.target = target.target;
            weapon.firing = target.target !== undefined;
        }
    }
});

interface WanderState {
    heading?: number;
    nextTurnAt: number;
}

export const WanderComponent =
    new Component<WanderState>('NpcWanderComponent');

function hashUuid(uuid: string): number {
    let hash = 2166136261;
    for (let i = 0; i < uuid.length; i++) {
        hash ^= uuid.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function getWanderHeading(uuid: string, time: number): number {
    const slot = Math.floor(time / 5_000);
    const mixed = (hashUuid(uuid) + Math.imul(slot, 0x9e3779b9)) >>> 0;
    return mixed / 0x1_0000_0000 * 2 * Math.PI;
}

const WanderAI = new System({
    name: "NpcWanderAI",
    args: [MovementStateComponent, TargetComponent, WanderComponent,
        TimeResource, UUID, MultiplayerData, PlatformResource,
        NpcAIComponent, Optional(DestructionStartedComponent),
        Optional(ArmorComponent)] as const,
    step(movementState, target, wander, time, uuid, multiplayer, platform,
        _npcAI, destructionStarted, armor) {
        if (platform !== "node" || multiplayer.owner !== "server"
            || target.target) {
            return;
        }
        if (destructionStarted || armor && armor.current <= 0) {
            movementState.turnTo = null;
            movementState.accelerating = 0;
            return;
        }
        if (wander.heading === undefined || time.time >= wander.nextTurnAt) {
            wander.heading = getWanderHeading(uuid, time.time);
            wander.nextTurnAt = time.time + 5_000;
        }
        movementState.turnTo = new Angle(wander.heading);
        movementState.accelerating = 1;
    },
});


export const DeathAIComponent = new Component<undefined>('DeathAIComponent');
export const DeathAISystem = new System({
    name: 'DeathAISystem',
    events: [DeathEvent],
    args: [Entities, UUID, DeathAIComponent, MultiplayerData,
        PlatformResource] as const,
    step(entities, uuid, _death, multiplayer, platform) {
        if (platform === "node" && multiplayer.owner !== "server"
            || platform === "browser" && multiplayer.owner === "server") {
            return;
        }
        entities.delete(uuid);
    }
})

export function makeNpc(shipData: ShipData) {
    const ship = makeShip(shipData);
    ship.components.set(ChooseRandomTargetComponent, {
        interval: 1_000,
    });
    ship.components.set(FollowComponent, undefined);
    ship.components.set(ShootAllWeaponsComponent, undefined);
    ship.components.set(WanderComponent, {
        nextTurnAt: 0,
    });
    ship.components.set(NpcAIComponent, undefined);
    ship.components.set(NpcCombatRoleComponent, "personal");
    ship.components.set(DeathAIComponent, undefined);
    return ship;
}

/**
 * Built here rather than in miner_ai.ts so that module does not have to
 * import this one back, which would leave the ordering markers undefined.
 */
const MinerSystems = createMinerSystems({
    chooseTarget: ChooseRandomTargetAI,
    follow: FollowAI,
});

export const NpcPlugin: Plugin = {
    name: 'NpcPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        deltaMaker.addComponent(GovtComponent, {
            componentType: GovtDataCodec,
        });
        world.addComponent(GovtComponent);
        world.resources.set(
            GovernmentRelationResource,
            new GovernmentRelationStore(world.resources.get(GameDataResource)!),
        );
        world.resources.set(ProvocationResource, createProvocationState());
        world.addSystem(NpcHostilitySystems.trackDamageSources);
        world.addSystem(NpcHostilitySystems.provocation);
        world.addSystem(NpcHostilitySystems.cleanup);
        world.addSystem(NpcHostilitySystems.playerDeathCleanup);
        world.addSystem(ChooseRandomTargetAI);
        world.addSystem(NpcPurposeAI);
        world.addSystem(MiningShipProvider);
        world.addSystem(MinerSystems.target);
        world.addSystem(MinerSystems.approach);
        world.addSystem(WanderAI);
        world.addSystem(ParkInterceptorAI);
        world.addSystem(FollowAI);
        world.addSystem(ShootAllWeaponsAI);
        world.addSystem(DeathAISystem);
    },
    remove(world) {
        world.removeSystem(NpcHostilitySystems.trackDamageSources);
        world.removeSystem(NpcHostilitySystems.provocation);
        world.removeSystem(NpcHostilitySystems.cleanup);
        world.removeSystem(NpcHostilitySystems.playerDeathCleanup);
        world.removeSystem(ChooseRandomTargetAI);
        world.removeSystem(NpcPurposeAI);
        world.removeSystem(MiningShipProvider);
        world.removeSystem(MinerSystems.target);
        world.removeSystem(MinerSystems.approach);
        world.removeSystem(WanderAI);
        world.removeSystem(ParkInterceptorAI);
        world.removeSystem(FollowAI);
        world.removeSystem(ShootAllWeaponsAI);
        world.removeSystem(DeathAISystem);
        world.resources.delete(GovernmentRelationResource);
        world.resources.delete(ProvocationResource);
    }
}

