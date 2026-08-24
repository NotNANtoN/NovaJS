import * as t from "io-ts";
import { ShipData } from "novadatainterface/ShipData";
import { Entities, UUID } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { Plugin } from "nova_ecs/plugin";
import { DeltaResource } from "nova_ecs/plugins/delta_plugin";
import { MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { MovementState, MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { Optional } from "nova_ecs/optional";
import { PlatformResource } from "./platform_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { Query } from "nova_ecs/query";
import { System } from "nova_ecs/system";
import { Angle } from "nova_ecs/datatypes/angle";
import { DeathEvent } from "./death_plugin";
import {
    GovernmentData,
    GovernmentRelationResource,
    GovernmentRelationStore,
    canTargetPlayer,
} from "./govt_relations";
import { makeShip } from "./make_ship";
import { ShipComponent } from "./ship_plugin";
import { TargetComponent } from "./target_component";
import { WeaponsStateComponent } from "./weapons_state";
import { GameDataResource } from "./game_data_resource";
import {
    NpcAIComponent,
    NpcHostilitySystems,
    ProvocationResource,
    createProvocationState,
    isProvoked,
} from "./npc_hostility";

const GovtData = t.type({
    id: t.number,
});
export type GovtData = t.TypeOf<typeof GovtData>;
export const GovtComponent = new Component<GovtData>('GovtComponent');

const TargetsQuery = new Query([
    UUID,
    MovementStateComponent,
    MultiplayerData,
    Optional(GovtComponent),
    ShipComponent,
] as const);

type TargetCandidate = readonly [
    string,
    MovementState,
    { owner: string },
    GovtData | undefined,
    { id: string },
];

function getValidTargets(
    targets: readonly TargetCandidate[],
    selfUuid: string,
    selfGovernmentId: number,
    selfGovernment: GovernmentData,
    relationStore: GovernmentRelationStore,
    provocations: ReturnType<typeof createProvocationState>,
): string[] {
    return targets
        .filter(([targetId, _movement, multiplayer, targetGovernment]) => {
            if (targetId === selfUuid) {
                return false;
            }

            if (multiplayer.owner !== "server") {
                return canTargetPlayer(
                    selfGovernment,
                    isProvoked(
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

            return relationStore.relation(
                selfGovernmentId,
                targetGovernment.id,
            ) === "enemy" || isProvoked(
                provocations,
                selfGovernmentId,
                targetId,
                (actor, victim) => relationStore.relation(actor, victim),
            );
        })
        .map(([uuid]) => uuid);
}

const ChooseRandomTargetComponent = new Component<{
    interval: number,
    nextTime?: number,
}>('ChooseRandomTargetComponent');

const ChooseRandomTargetAI = new System({
    name: 'ChooseRandomTarget',
    args: [TargetComponent, TargetsQuery, ChooseRandomTargetComponent,
        TimeResource, UUID, MovementStateComponent, Entities, GovernmentRelationResource,
        ProvocationResource, MultiplayerData, PlatformResource,
        GovtComponent, NpcAIComponent] as const,
    step(target, targets, randomTargetData, time, uuid, movementState, entities,
        relationStore, provocations, multiplayer, platform, government) {
        if (platform !== "node" || multiplayer.owner !== "server") {
            return;
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
        );

        const candidateByUuid = new Map(
            targets.map(candidate => [candidate[0], candidate] as const),
        );
        const selected = validTargets
            .map(targetId => candidateByUuid.get(targetId))
            .filter((candidate): candidate is TargetCandidate =>
                candidate !== undefined)
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
const FollowAI = new System({
    name: 'FollowAndShootAI',
    args: [MovementStateComponent, TargetComponent, FollowComponent,
        Entities, MultiplayerData, PlatformResource] as const,
    step(movementState, target, _follow, entities, multiplayer, platform) {
        if (platform === "node" && multiplayer.owner !== "server"
            || platform === "browser" && multiplayer.owner === "server") {
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
        movementState.turnTo = target.target;
        movementState.accelerating = 1;
    }
});

export const ShootAllWeaponsComponent = new Component<undefined>('ShootAllWeaponsComponent');
const ShootAllWeaponsAI = new System({
    name: 'ShootAllWeaponsAI',
    args: [WeaponsStateComponent, GameDataResource, TargetComponent,
        ShootAllWeaponsComponent, Entities, MultiplayerData,
        PlatformResource] as const,
    step(weapons, gameData, target, _shoot, entities, multiplayer, platform) {
        if (platform === "node" && multiplayer.owner !== "server"
            || platform === "browser" && multiplayer.owner === "server") {
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
        NpcAIComponent] as const,
    step(movementState, target, wander, time, uuid, multiplayer, platform) {
        if (platform !== "node" || multiplayer.owner !== "server"
            || target.target) {
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
    ship.components.set(DeathAIComponent, undefined);
    return ship;
}

export const NpcPlugin: Plugin = {
    name: 'NpcPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        deltaMaker.addComponent(GovtComponent, {
            componentType: GovtData,
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
        world.addSystem(ChooseRandomTargetAI);
        world.addSystem(WanderAI);
        world.addSystem(FollowAI);
        world.addSystem(ShootAllWeaponsAI);
        world.addSystem(DeathAISystem);
    },
    remove(world) {
        world.removeSystem(NpcHostilitySystems.trackDamageSources);
        world.removeSystem(NpcHostilitySystems.provocation);
        world.removeSystem(NpcHostilitySystems.cleanup);
        world.removeSystem(ChooseRandomTargetAI);
        world.removeSystem(WanderAI);
        world.removeSystem(FollowAI);
        world.removeSystem(ShootAllWeaponsAI);
        world.removeSystem(DeathAISystem);
        world.resources.delete(GovernmentRelationResource);
        world.resources.delete(ProvocationResource);
    }
}

