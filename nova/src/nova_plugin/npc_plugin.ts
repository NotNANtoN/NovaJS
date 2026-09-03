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
import { firstOrderWithFallback } from "./guidance";
import { Position } from "nova_ecs/datatypes/position";
import { Vector } from "nova_ecs/datatypes/vector";
import type { WeaponsState } from "./weapons_state";
import { PlanetComponent } from "./planet_plugin";
import {
    InitiateJumpEvent,
    JumpStateComponent,
} from "./jump_plugin";
import { SystemIdResource } from "./system_id_resource";
import { CloakStateComponent } from "./cloaking_plugin";
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
    Optional(DestructionStartedComponent),
    Optional(JumpStateComponent),
    Optional(CloakStateComponent),
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
    any | undefined,
    any | undefined,
    any | undefined,
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
            destructionStarted,
            jumpState,
            cloakState,
        ]) => {
            if (targetId === selfUuid) {
                return false;
            }
            if (playerDeath || destructionStarted || jumpState?.phase === 'departing' || jumpState?.phase === 'arriving' || (cloakState?.cloaked && cloakState.alpha < 0.5)) {
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
    shield?: { current: number, max: number },
): boolean {
    if (!personallyProvoked) {
        return false;
    }
    // An unarmed ship cannot defend itself and must flee.
    if (!(weaponRange > 0)) {
        return true;
    }
    const shieldFraction = shield && shield.max > 0
        ? shield.current / shield.max
        : undefined;
    // Wimpy traders defend themselves while shields hold, but retreat when shields drop low.
    if (profile.fleesWhenAttacked) {
        return shieldFraction !== undefined
            ? shieldFraction < 0.5
            : true;
    }
    // Brave traders fight back until shields are critical or attacker is well out of range.
    if (profile.breaksOffOutOfRange) {
        return (shieldFraction !== undefined && shieldFraction < 0.25)
            || attackerDistance > Math.max(DEFAULT_COMBAT_STANDOFF, weaponRange * 1.5);
    }
    return false;
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
            || currentCandidate[9] !== undefined
            || currentCandidate[10]?.phase === 'departing'
            || currentCandidate[10]?.phase === 'arriving'
            || (currentCandidate[11]?.cloaked && (currentCandidate[11]?.alpha ?? 1) < 0.5)
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
            // Incomplete government JSON must not dump a live lock. Retry
            // picking a *new* target shortly; keep whoever we already have.
            randomTargetData.nextTime = time.time + 100;
            return;
        }

        const defending = Boolean(target.target
            && isPersonallyProvoked(provocations, uuid, target.target)
            && entities.has(target.target));
        const returningFire = validTargets.some(id =>
            isPersonallyProvoked(provocations, uuid, id));
        if (defending) {
            // MaxOdds is for opening a fight, not for dropping one you are
            // already in. A freighter that just got shot would otherwise
            // decide the player is too strong and wander off.
            randomTargetData.nextTime = time.time + randomTargetData.interval;
            return;
        }

        const candidateByUuid = new Map(
            targets.map(candidate => [candidate[0], candidate] as const),
        );
        if (!returningFire && shipData && selfGovernment.maxOdds !== undefined
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

export const DEFAULT_COMBAT_STANDOFF = 250;

function weaponRange(weapon: WeaponData): number | undefined {
    if (weapon.type === "BayWeaponData"
        || weapon.fireGroup === "pointDefense") {
        return;
    }
    if (weapon.type === "BeamWeaponData") {
        const range = weapon.beamAnimation?.length;
        return typeof range === "number" && Number.isFinite(range)
            ? range
            : undefined;
    }
    if (typeof weapon.physics?.speed !== "number"
        || typeof weapon.shotDuration !== "number") {
        return;
    }
    const range = weapon.physics.speed * weapon.shotDuration / 1000;
    return Number.isFinite(range) ? range : undefined;
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
 * Determine the effective engagement range from the ship's actual weapon loadout.
 * If the ship carries primary forward guns/beams, use the shortest primary range so
 * all primary forward weapons can bear. Otherwise, fall back to secondary weapons.
 */
export function getEffectiveWeaponRange(
    weapons: WeaponsState | undefined,
    gameData: GameDataInterface,
): number | undefined {
    let primaryRange: number | undefined;
    let secondaryRange: number | undefined;

    for (const [id, state] of weapons ?? []) {
        if (state.count <= 0) {
            continue;
        }
        const weapon = gameData.data.Weapon.getCached(id);
        if (!weapon) {
            continue;
        }
        const range = weaponRange(weapon);
        if (range === undefined || range <= 0) {
            continue;
        }

        if (weapon.fireGroup === "primary") {
            primaryRange = primaryRange === undefined
                ? range
                : Math.min(primaryRange, range);
        } else {
            secondaryRange = secondaryRange === undefined
                ? range
                : Math.max(secondaryRange, range);
        }
    }

    return primaryRange ?? secondaryRange;
}

/**
 * Combat standoff is determined dynamically by the ship's installed weapons loadout
 * and ship AI profile. Ships with short-range blasters (e.g. Thunderbirds, Light Blasters)
 * close in aggressively, while ships with long-range weapons (Heavy Blasters, Railguns)
 * hold appropriate standoff distance without being constrained by an arbitrary hard cap.
 */
export function getCombatStandoff(
    weapons: WeaponsState | undefined,
    gameData: GameDataInterface,
    standoffMultiplier = 1,
): number {
    const effectiveRange = getEffectiveWeaponRange(weapons, gameData);
    if (effectiveRange === undefined || !(effectiveRange > 0)) {
        return DEFAULT_COMBAT_STANDOFF * standoffMultiplier;
    }
    const baseFraction = 0.75;
    return Math.max(80, effectiveRange * baseFraction * standoffMultiplier);
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

export interface WanderState {
    heading?: number;
    nextTurnAt: number;
    enteredAt?: number;
}

export const WanderComponent =
    new Component<WanderState>('NpcWanderComponent');

export const WARSHIP_SEARCH_DURATION_MS = 30_000;

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
        TimeResource,
        Optional(WanderComponent),
    ] as const,
    step(target, uuid, entity, entities, targets, movement, weapons, gameData,
        shipData, governmentRef, governments, provocations, shield, fleeing,
        departing, jumpState, systemId, emit, multiplayer, platform, _npc,
        destructionStarted, armor, time, wander) {
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
        if (targetId && !entities.has(targetId)) {
            target.target = undefined;
        }
        const activeTargetId = target.target;
        const targetEntity = activeTargetId ? entities.get(activeTargetId) : undefined;
        const targetCloak = targetEntity?.components.get(CloakStateComponent);
        if (targetCloak?.cloaked && targetCloak.alpha < 0.5) {
            target.target = undefined;
        }
        const targetMovement = targetEntity?.components
            .get(MovementStateComponent);
        const targetDistance = targetMovement
            ? targetMovement.position.subtract(movement.position).length
            : 0;
        const personallyProvoked = Boolean(activeTargetId
            && isPersonallyProvoked(provocations, uuid, activeTargetId));
        const weaponRange = getMaximumWeaponRange(weapons, gameData);
        const governmentRetreat = shouldWarshipRetreat(
            profile, government, shield);
        const fleeFromAttacker = Boolean(activeTargetId && targetMovement
            && shouldFleeFromAttacker(
                profile,
                personallyProvoked,
                targetDistance,
                weaponRange,
                shield,
            ));

        if (activeTargetId && targetMovement
            && (governmentRetreat || fleeFromAttacker)) {
            const reason = governmentRetreat
                ? "retreat"
                : profile.fleesWhenAttacked ? "attacked" : "out-of-range";
            // The Bible specifies when running starts but not a manoeuvring
            // distance. Receding by the existing fallback combat standoff each
            // controller step keeps the ship running until the threat breaks.
            const state: NpcFleeState = {
                threat: activeTargetId,
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

        const searchElapsed = wander?.enteredAt !== undefined
            && time.time - wander.enteredAt >= WARSHIP_SEARCH_DURATION_MS;
        const shouldLeave = governmentRetreat
            || profile.jumpsWithoutEnemies && !target.target && searchElapsed
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
        if (command.turnTo === null && !command.turnBack) {
            movement.turning = 0;
        }
    },
});


export function getPrimaryForwardWeapon(
    weapons: WeaponsState | undefined,
    gameData: GameDataInterface,
): WeaponData | undefined {
    for (const [id, state] of weapons ?? []) {
        if (state.count <= 0) continue;
        const weapon = gameData.data.Weapon.getCached(id);
        if (!weapon || weapon.type === "BayWeaponData") continue;
        const guidance = "guidance" in weapon ? weapon.guidance : undefined;
        if (guidance === "turret" || guidance === "beamTurret" || guidance === "guided"
            || guidance === "rearQuadrant" || guidance === "pointDefense" || guidance === "pointDefenseBeam") {
            continue;
        }
        return weapon;
    }
    return undefined;
}

export function calculateLeadAimAngle(
    sourcePosition: Position,
    sourceVelocity: Vector,
    targetPosition: Position,
    targetVelocity: Vector,
    weaponData?: WeaponData,
): Angle {
    if (!weaponData || weaponData.type === "BeamWeaponData") {
        return targetPosition.subtract(sourcePosition).angle;
    }
    const shotSpeed = weaponData.shotSpeed
        ?? (weaponData as any).physics?.speed
        ?? 300;
    if (!(shotSpeed > 0)) {
        return targetPosition.subtract(sourcePosition).angle;
    }
    return firstOrderWithFallback(
        sourcePosition,
        sourceVelocity,
        targetPosition,
        targetVelocity,
        shotSpeed,
    );
}

export type CombatTactic =
    | "dogfight"   // Fast interceptors / fighters: strafe passes and breakaway
    | "skirmish"   // Long-range beam escorts: standoff kiting, backpedal
    | "broadside"  // Heavy dreadnoughts / warships: steady platform, turret arcs
    | "defensive"; // Armed freighters & traders: hold formation, retreat

export function getShipCombatTactic(
    shipData: ShipData | undefined,
    weapons: WeaponsState | undefined,
    gameData: GameDataInterface,
): CombatTactic {
    if (!shipData) {
        return "dogfight";
    }
    const inherentAI = shipData.inherentAI;
    if (inherentAI === 1 || inherentAI === 2 || (shipData.cargoCapacity > 100 && shipData.maxGuns <= 2)) {
        return "defensive";
    }
    if (shipData.physics.mass >= 3000 || shipData.physics.turnRate < 1.2) {
        return "broadside";
    }
    const primary = getPrimaryForwardWeapon(weapons, gameData);
    const range = getEffectiveWeaponRange(weapons, gameData) ?? 600;
    if (primary?.type === "BeamWeaponData" || range >= 700) {
        return "skirmish";
    }
    return "dogfight";
}

export const FollowAI = new System({
    name: 'FollowAndShootAI',
    args: [MovementStateComponent, MovementPhysicsComponent, TargetComponent,
        FollowComponent, Entities, MultiplayerData, PlatformResource,
        Optional(WeaponsStateComponent), GameDataResource,
        Optional(ShipDataComponent),
        Optional(NpcFleeComponent),
        Optional(DestructionStartedComponent),
        Optional(ArmorComponent),
        Optional(JumpStateComponent)] as const,
    step(movementState, physics, target, _follow, entities, multiplayer,
        platform, weapons, gameData, shipData, fleeing, destructionStarted,
        armor, jumpState) {
        if (platform === "node" && multiplayer.owner !== "server"
            || platform === "browser" && multiplayer.owner === "server") {
            return;
        }
        if (destructionStarted || armor && armor.current <= 0) {
            movementState.turnTo = null;
            movementState.accelerating = 0;
            return;
        }
        if (jumpState) {
            return;
        }
        if (!target.target) {
            return;
        }
        const targetEntity = entities.get(target.target);
        if (!targetEntity
            || targetEntity.components.has(DestructionStartedComponent)
            || targetEntity.components.get(JumpStateComponent)?.phase === 'departing') {
            target.target = undefined;
            movementState.turnTo = null;
            movementState.accelerating = 0;
            return;
        }
        const targetMovement = targetEntity.components.get(MovementStateComponent);
        if (!targetMovement) {
            movementState.turnTo = null;
            movementState.accelerating = 0;
            return;
        }
        const toTarget = targetMovement.position.subtract(movementState.position);
        const distance = toTarget.length;
        const primaryWeapon = getPrimaryForwardWeapon(weapons, gameData);
        const effectiveRange = getEffectiveWeaponRange(weapons, gameData) ?? 600;
        const leadAngle = calculateLeadAimAngle(
            movementState.position,
            movementState.velocity,
            targetMovement.position,
            targetMovement.velocity,
            primaryWeapon,
        );
        const tactic = getShipCombatTactic(shipData, weapons, gameData);
        const standoffMultiplier = shipData
            ? getShipAIProfile(shipData).weaponStandoffMultiplier
            : 1;
        const baseStandoff = getCombatStandoff(weapons, gameData, standoffMultiplier);

        if (fleeing?.threat === target.target) {
            const command = fleeFromTarget(
                movementState,
                targetMovement,
                physics,
                { distance: fleeing.distance },
            );
            movementState.turnTo = command.turnTo;
            movementState.accelerating = command.accelerating;
            movementState.turnBack = command.turnBack;
        } else if (tactic === "skirmish" && distance < baseStandoff * 0.5) {
            // Skirmisher kiting: reverse burn while keeping nose on lead angle
            movementState.turnTo = leadAngle;
            movementState.accelerating = 0;
            movementState.turnBack = true;
        } else if (tactic === "dogfight" && shipData && distance < 140) {
            // Dogfighter breakaway: bank away laterally to avoid ramming
            const breakAngle = leadAngle.add(Math.PI * 0.6);
            movementState.turnTo = breakAngle;
            movementState.accelerating = 1;
            movementState.turnBack = false;
        } else {
            const standoff = tactic === "dogfight" && shipData
                ? Math.max(150, baseStandoff * 0.75)
                : baseStandoff;
            const command = approachTarget(movementState, targetMovement, physics, {
                standoff,
            });
            movementState.turnTo = command.turnTo ?? leadAngle;
            movementState.accelerating = command.accelerating;
            movementState.turnBack = command.turnBack;
        }

        if (movementState.turnTo === null && !movementState.turnBack) {
            movementState.turning = 0;
        }
    }
});

export const ShootAllWeaponsComponent = new Component<undefined>('ShootAllWeaponsComponent');
export const ShootAllWeaponsAI = new System({
    name: 'ShootAllWeaponsAI',
    args: [WeaponsStateComponent, GameDataResource, TargetComponent,
        Optional(MovementStateComponent), ShootAllWeaponsComponent,
        Entities, MultiplayerData,
        PlatformResource, Optional(DestructionStartedComponent),
        Optional(ArmorComponent), Optional(NpcFleeComponent)] as const,
    step(weapons, gameData, target, movement, _shoot, entities, multiplayer,
        platform, destructionStarted, armor, _fleeing) {
        if (platform === "node" && multiplayer.owner !== "server"
            || platform === "browser" && multiplayer.owner === "server") {
            return;
        }
        if (destructionStarted || armor && armor.current <= 0) {
            for (const weapon of weapons.values()) {
                weapon.firing = false;
                weapon.target = undefined;
            }
            return;
        }
        const targetUuid = target.target;
        if (targetUuid) {
            const ent = entities.get(targetUuid);
            if (!ent
                || ent.components.has(DestructionStartedComponent)
                || ent.components.get(JumpStateComponent)?.phase === 'departing') {
                target.target = undefined;
            }
        }
        const targetEntity = target.target
            ? entities.get(target.target)
            : undefined;
        const targetMovement = targetEntity?.components
            .get(MovementStateComponent);
        const targetDistance = movement && targetMovement
            ? targetMovement.position.subtract(movement.position).length
            : undefined;
        for (const [id, weapon] of weapons) {
            const weaponData = gameData.data.Weapon.getCached(id);
            if (weaponData == null || weaponData.type === 'BayWeaponData') {
                // do not use bay weapons yet since there is no ammo limit.
                continue;
            };
            weapon.target = target.target;
            const pointDefense = weaponData.guidance === 'pointDefense'
                || weaponData.guidance === 'pointDefenseBeam';
            const range = weaponRange(weaponData);
            const inRange = pointDefense || range === undefined
                || targetDistance === undefined || targetDistance <= range;

            if (!target.target || !inRange) {
                weapon.firing = false;
                continue;
            }

            if (pointDefense) {
                weapon.firing = true;
                continue;
            }

            // Check firing arc for directional / fixed weapons
            let canBear = true;
            if (movement && targetMovement) {
                const guidance = "guidance" in weaponData ? weaponData.guidance : undefined;

                if (guidance === "turret" || guidance === "beamTurret" || guidance === "guided") {
                    canBear = true;
                } else if (guidance === "rearQuadrant") {
                    const angleToTarget = targetMovement.position.subtract(movement.position).angle;
                    const angleDiff = Math.abs(movement.rotation.distanceTo(angleToTarget).angle);
                    canBear = angleDiff > (Math.PI * 0.65);
                } else {
                    // Fixed forward guns, unguided, rockets, frontQuadrant, fixed beams
                    const aimAngle = calculateLeadAimAngle(
                        movement.position,
                        movement.velocity,
                        targetMovement.position,
                        targetMovement.velocity,
                        weaponData,
                    );
                    const angleDiff = Math.abs(movement.rotation.distanceTo(aimAngle).angle);
                    const maxArc = weaponData.type === "BeamWeaponData"
                        ? 0.08  // ~4.6 degrees for precision beams
                        : 0.18; // ~10.3 degrees for forward projectile guns
                    canBear = angleDiff <= maxArc;
                }
            }

            weapon.firing = canBear;
        }
    }
});

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
        Optional(ArmorComponent), Optional(JumpStateComponent)] as const,
    step(movementState, target, wander, time, uuid, multiplayer, platform,
        _npcAI, destructionStarted, armor, jumpState) {
        if (platform !== "node" || multiplayer.owner !== "server"
            || target.target) {
            return;
        }
        if (destructionStarted || armor && armor.current <= 0) {
            movementState.turnTo = null;
            movementState.accelerating = 0;
            return;
        }
        if (jumpState) {
            return;
        }
        if (wander.enteredAt === undefined) {
            wander.enteredAt = time.time;
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

