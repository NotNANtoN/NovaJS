import { ShipData } from "novadatainterface/ShipData";
import { GameDataInterface } from "novadatainterface/GameDataInterface";
import { WeaponData } from "novadatainterface/WeaponData";
import { Entities, UUID } from "nova_ecs/arg_types";
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
import { ArmorComponent } from "./health_plugin";
import { DestructionStartedComponent } from "./destruction_state";
import {
    GovernmentData,
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
import { approachTarget } from "./flight_controller";
import type { WeaponsState } from "./weapons_state";
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
    Optional(PlayerStateComponent),
] as const);

type TargetCandidate = readonly [
    string,
    MovementState,
    { owner: string },
    GovtData | undefined,
    { respawnAt?: number, wreckPosition: [number, number] } | undefined,
    { id: string },
    PlayerState | undefined,
];

function getValidTargets(
    targets: readonly TargetCandidate[],
    selfUuid: string,
    selfGovernmentId: number,
    selfGovernment: GovernmentData,
    relationStore: GovernmentRelationStore,
    provocations: ReturnType<typeof createProvocationState>,
    canAssistGovernment: boolean,
    initiatesCombat = true,
): string[] {
    return targets
        .filter(([
            targetId,
            _movement,
            multiplayer,
            targetGovernment,
            playerDeath,
            _ship,
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
                    personal || hunted || canAssistGovernment && isProvoked(
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
                || canAssistGovernment && isProvoked(
                provocations,
                selfGovernmentId,
                targetId,
                (actor, victim) => relationStore.relation(actor, victim),
            );
        })
        .map(([uuid]) => uuid);
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
        const validTargets = getValidTargets(
            targets,
            uuid,
            government.id,
            selfGovernment,
            relationStore,
            provocations,
            combatRole === "military",
            shipData ? getShipAIProfile(shipData).initiatesCombat : true,
        );

        const candidateByUuid = new Map(
            targets.map(candidate => [candidate[0], candidate] as const),
        );
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
    if (!(longestRange > 0)) {
        return DEFAULT_COMBAT_STANDOFF * standoffMultiplier;
    }
    return Math.min(
        MAX_COMBAT_STANDOFF,
        longestRange * COMBAT_RANGE_FRACTION * standoffMultiplier,
    );
}

export const FollowAI = new System({
    name: 'FollowAndShootAI',
    args: [MovementStateComponent, MovementPhysicsComponent, TargetComponent,
        FollowComponent, Entities, MultiplayerData, PlatformResource,
        Optional(WeaponsStateComponent), GameDataResource,
        Optional(ShipDataComponent),
        Optional(DestructionStartedComponent),
        Optional(ArmorComponent)] as const,
    step(movementState, physics, target, _follow, entities, multiplayer,
        platform, weapons, gameData, shipData, destructionStarted, armor) {
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
        const command = approachTarget(
            movementState,
            targetMovement,
            physics,
            {
                standoff: getCombatStandoff(
                    weapons,
                    gameData,
                    shipData
                        ? getShipAIProfile(shipData).weaponStandoffMultiplier
                        : 1,
                ),
            },
        );
        // Once holding station the controller has no thrust to aim, so the
        // nose would keep whatever heading braking left it with — pointing
        // away from the target, where fixed guns are useless. Tracking the
        // target by uuid lets the movement system keep it under the guns.
        movementState.turnTo = command.turnTo ?? target.target;
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
        Optional(ArmorComponent)] as const,
    step(weapons, gameData, target, _shoot, entities, multiplayer, platform,
        destructionStarted, armor) {
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
        world.addSystem(MiningShipProvider);
        world.addSystem(MinerSystems.target);
        world.addSystem(MinerSystems.approach);
        world.addSystem(WanderAI);
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
        world.removeSystem(MiningShipProvider);
        world.removeSystem(MinerSystems.target);
        world.removeSystem(MinerSystems.approach);
        world.removeSystem(WanderAI);
        world.removeSystem(FollowAI);
        world.removeSystem(ShootAllWeaponsAI);
        world.removeSystem(DeathAISystem);
        world.resources.delete(GovernmentRelationResource);
        world.resources.delete(ProvocationResource);
    }
}

