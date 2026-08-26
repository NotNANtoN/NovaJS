import * as t from 'io-ts';
import { STANDARD_COMMODITIES } from 'novadatainterface/CommodityData';
import { Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import {
    MovementPhysicsComponent,
    MovementStateComponent,
} from 'nova_ecs/plugins/movement_plugin';
import {
    MultiplayerData,
    replicationPolicies,
} from 'nova_ecs/plugins/multiplayer_plugin';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { DisabledComponent } from './death_plugin';
import { DestructionStartedComponent } from './destruction_state';
import {
    approachTarget,
    hasArrived,
    inTransferRange,
} from './flight_controller';
import {
    GovernmentData,
    GovernmentRelationResource,
    GovernmentFlags,
} from './govt_relations';
import { ArmorComponent } from './health_plugin';
import {
    GovtComponent,
    NpcAIComponent,
} from './npc_components';
import {
    ChooseRandomTargetAI,
    FollowAI,
    ShootAllWeaponsAI,
} from './npc_plugin';
import {
    CargoHold,
    PlayerState,
    PlayerStateComponent,
    releaseCargo,
} from './player_state';
import { PlatformResource } from './platform_plugin';
import { ShipDataComponent } from './ship_plugin';
import { TargetComponent } from './target_component';
import { WeaponsStateComponent } from './weapons_state';

export const BOARDING_STANDOFF = 80;
export const BOARDING_TOLERANCE = 20;
export const BOARDING_TRANSFER_RANGE = 110;
export const BOARDING_MAX_RELATIVE_SPEED = 10;
export const BOARDING_CREDIT_FRACTION = 0.25;

const BoardingInventory = t.type({
    cargoCapacity: t.number,
    credits: t.number,
    holds: t.array(CargoHold),
});
export type BoardingInventory = t.TypeOf<typeof BoardingInventory>;
export const BoardingInventoryComponent =
    new Component<BoardingInventory>('BoardingInventoryComponent');

const PirateBoarder = t.type({ enabled: t.boolean });
export type PirateBoarder = t.TypeOf<typeof PirateBoarder>;
export const PirateBoarderComponent =
    new Component<PirateBoarder>('PirateBoarderComponent');

const BoardingState = t.type({
    boarded: t.array(t.string),
});
export type BoardingState = t.TypeOf<typeof BoardingState>;
export const BoardingStateComponent =
    new Component<BoardingState>('BoardingStateComponent');

replicationPolicies.register(BoardingInventoryComponent, {
    codec: BoardingInventory,
    authority: 'server',
});
replicationPolicies.register(PirateBoarderComponent, {
    codec: PirateBoarder,
    authority: 'server',
});
replicationPolicies.register(BoardingStateComponent, {
    codec: BoardingState,
    authority: 'server',
});

/**
 * Retail marks the governments that board rather than merely destroy with a
 * gövt flag, so plug-in factions and the raiders that are not named "pirate" —
 * Marauder, Houseless Warriors, Spanner, Family Moash — behave correctly.
 */
export function plundersDisabledShips(
    government: Pick<GovernmentData, 'flags'>,
): boolean {
    return ((government.flags ?? 0) & GovernmentFlags.warshipsPlunder) !== 0;
}

function hashString(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function initialNpcInventory(
    uuid: string,
    ship: { cargoCapacity: number, cost: number },
): BoardingInventory {
    const cargoCapacity = Math.max(0, Math.floor(ship.cargoCapacity));
    const cargoTons = Math.floor(cargoCapacity / 2);
    const commodity =
        STANDARD_COMMODITIES[hashString(uuid) % STANDARD_COMMODITIES.length];
    return {
        cargoCapacity,
        // NPC commerce has no manifest or account model yet. A deterministic
        // half hold and a small fraction of hull value make boarding useful
        // without pretending to reproduce retail's düde-specific loadouts.
        credits: Math.max(0, Math.floor(ship.cost * 0.001)),
        holds: cargoTons > 0 ? [{
            commodity,
            tons: cargoTons,
            isMissionCargo: false,
        }] : [],
    };
}

export const BoardingSetupSystem = new System({
    name: 'BoardingSetupSystem',
    args: [
        UUID,
        NpcAIComponent,
        GovtComponent,
        ShipDataComponent,
        GetEntity,
        Optional(BoardingInventoryComponent),
        Optional(PirateBoarderComponent),
        Optional(BoardingStateComponent),
        GovernmentRelationResource,
        MultiplayerData,
        PlatformResource,
    ] as const,
    step(uuid, _npc, governmentRef, ship, entity, inventory, pirate, boarding,
        governments, multiplayer, platform) {
        if (platform !== 'node' || multiplayer.owner !== 'server') {
            return;
        }
        if (!inventory) {
            entity.components.set(
                BoardingInventoryComponent, initialNpcInventory(uuid, ship));
        }
        if (pirate && boarding) {
            return;
        }

        const government = governments.getCached(governmentRef.id);
        if (!government) {
            return;
        }
        entity.components.set(PirateBoarderComponent, {
            enabled: plundersDisabledShips(government),
        });
        entity.components.set(BoardingStateComponent, { boarded: [] });
    },
});

function heldCargo(inventory: Pick<BoardingInventory, 'holds'>): number {
    return inventory.holds.reduce((total, hold) =>
        total + Math.max(0, Math.floor(hold.tons)), 0);
}

function addCargo(
    inventory: BoardingInventory,
    commodity: string,
    tons: number,
): void {
    const existing = inventory.holds.find(hold =>
        !hold.isMissionCargo && hold.commodity === commodity);
    if (existing) {
        existing.tons += tons;
    } else {
        inventory.holds.push({
            commodity,
            tons,
            isMissionCargo: false,
        });
    }
}

function releaseNpcCargo(
    inventory: BoardingInventory,
    commodity: string,
    tons: number,
): number {
    let remaining = tons;
    let removed = 0;
    for (let index = inventory.holds.length - 1;
        index >= 0 && remaining > 0; index--) {
        const hold = inventory.holds[index];
        if (hold.isMissionCargo || hold.commodity !== commodity) {
            continue;
        }
        const amount = Math.min(remaining, hold.tons);
        hold.tons -= amount;
        remaining -= amount;
        removed += amount;
        if (hold.tons <= 0) {
            inventory.holds.splice(index, 1);
        }
    }
    return removed;
}

export interface PlunderResult {
    cargo: number;
    credits: number;
}

export function plunderShip(
    boarder: BoardingInventory,
    victimPlayer: PlayerState | undefined,
    victimNpc: BoardingInventory | undefined,
): PlunderResult {
    const victim = victimPlayer ?? victimNpc;
    if (!victim) {
        return { cargo: 0, credits: 0 };
    }

    let freeSpace = Math.max(
        0, Math.floor(boarder.cargoCapacity - heldCargo(boarder)));
    let cargo = 0;
    const cargoSnapshot = victim.holds
        .filter(hold => !hold.isMissionCargo && hold.tons > 0)
        .map(hold => ({ commodity: hold.commodity, tons: hold.tons }));
    for (const hold of cargoSnapshot) {
        const requested = Math.min(freeSpace, Math.floor(hold.tons));
        if (requested <= 0) {
            break;
        }
        const removed = victimPlayer
            ? releaseCargo(victimPlayer, hold.commodity, requested)
            : releaseNpcCargo(victimNpc!, hold.commodity, requested);
        addCargo(boarder, hold.commodity, removed);
        freeSpace -= removed;
        cargo += removed;
    }

    const credits = Math.min(
        Math.max(0, Math.floor(victim.credits)),
        Math.max(0, Math.floor(
            victim.credits * BOARDING_CREDIT_FRACTION)),
    );
    victim.credits -= credits;
    boarder.credits += credits;
    return { cargo, credits };
}

const DisabledBoardingTargets = new Query([
    UUID,
    DisabledComponent,
    MovementStateComponent,
    Optional(PlayerStateComponent),
    Optional(BoardingInventoryComponent),
    Optional(DestructionStartedComponent),
    Optional(ArmorComponent),
] as const, 'DisabledBoardingTargets');

function ceaseFire(
    weapons: Map<string, {
        count: number,
        firing: boolean,
        target?: string,
    }> | undefined,
): void {
    for (const weapon of weapons?.values() ?? []) {
        weapon.firing = false;
        weapon.target = undefined;
    }
}

export const PirateBoardingSystem = new System({
    name: 'PirateBoardingSystem',
    after: [ChooseRandomTargetAI, FollowAI, ShootAllWeaponsAI],
    args: [
        PirateBoarderComponent,
        BoardingStateComponent,
        BoardingInventoryComponent,
        TargetComponent,
        MovementStateComponent,
        MovementPhysicsComponent,
        Optional(WeaponsStateComponent),
        DisabledBoardingTargets,
        Entities,
        MultiplayerData,
        PlatformResource,
        NpcAIComponent,
        Optional(DisabledComponent),
        Optional(DestructionStartedComponent),
        Optional(ArmorComponent),
    ] as const,
    step(pirate, boarding, inventory, target, movement, physics, weapons,
        disabledTargets, entities, multiplayer, platform, _npc,
        disabled, destructionStarted, armor) {
        if (!pirate.enabled || platform !== 'node'
            || multiplayer.owner !== 'server' || disabled
            || destructionStarted
            || armor && armor.current <= 0) {
            return;
        }

        const targetUuid = target.target;
        if (!targetUuid) {
            return;
        }
        if (boarding.boarded.includes(targetUuid)) {
            target.target = undefined;
            movement.accelerating = 0;
            movement.turnTo = null;
            ceaseFire(weapons);
            return;
        }

        const victim = disabledTargets.find(candidate =>
            candidate[0] === targetUuid && candidate[1]
            && !candidate[5] && (!candidate[6] || candidate[6]!.current > 0));
        if (!victim || !entities.has(targetUuid)) {
            return;
        }

        ceaseFire(weapons);
        const victimMovement = victim[2];
        const arrived = hasArrived(movement, victimMovement, {
            standoff: BOARDING_STANDOFF,
            tolerance: BOARDING_TOLERANCE,
            maxSpeed: BOARDING_MAX_RELATIVE_SPEED,
        }) && inTransferRange(
            movement, victimMovement, BOARDING_TRANSFER_RANGE);
        if (arrived) {
            plunderShip(inventory, victim[3], victim[4]);
            boarding.boarded.push(targetUuid);
            target.target = undefined;
            movement.accelerating = 0;
            movement.turning = 0;
            movement.turnBack = false;
            movement.turnTo = null;
            return;
        }

        const command = approachTarget(movement, victimMovement, {
            acceleration: physics.acceleration,
            maxVelocity: physics.maxVelocity,
            turnRate: physics.turnRate,
        }, {
            standoff: BOARDING_STANDOFF,
            tolerance: BOARDING_TOLERANCE,
        });
        movement.turnTo = command.turnTo;
        movement.accelerating = command.accelerating;
        movement.turnBack = command.turnBack;
    },
});

export const BoardingPlugin: Plugin = {
    name: 'BoardingPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        world.addComponent(BoardingInventoryComponent);
        deltaMaker.addComponent(BoardingInventoryComponent, {
            componentType: BoardingInventory,
        });
        world.addComponent(PirateBoarderComponent);
        deltaMaker.addComponent(PirateBoarderComponent, {
            componentType: PirateBoarder,
        });
        world.addComponent(BoardingStateComponent);
        deltaMaker.addComponent(BoardingStateComponent, {
            componentType: BoardingState,
        });
        world.addSystem(BoardingSetupSystem);
        world.addSystem(PirateBoardingSystem);
    },
    remove(world) {
        world.removeSystem(BoardingSetupSystem);
        world.removeSystem(PirateBoardingSystem);
    },
};
