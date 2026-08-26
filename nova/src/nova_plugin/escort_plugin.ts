import * as t from 'io-ts';
import { ShipData } from 'novadatainterface/ShipData';
import { Entities, GetEntity, GetWorld, UUID } from 'nova_ecs/arg_types';
import { AsyncSystem } from 'nova_ecs/async_system';
import { Position } from 'nova_ecs/datatypes/position';
import { Component } from 'nova_ecs/component';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import {
    MultiplayerData,
} from 'nova_ecs/plugins/multiplayer_plugin';
import {
    MovementPhysicsComponent,
    MovementState,
    MovementStateComponent,
    copyMovementState,
} from 'nova_ecs/plugins/movement_plugin';
import { System } from 'nova_ecs/system';
import { v4 as uuid } from 'uuid';
import { GameDataResource } from './game_data_resource';
import { approachTarget } from './flight_controller';
import { makeNpc } from './npc_plugin';
import { PlatformResource } from './platform_plugin';
import { TargetComponent } from './target_component';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';

/**
 * The Bible's shïp/HireRandom definition is exact:
 * “The percent chance that a ship of this type will be available for hire in
 * the bar on a given day. A HireRandom of 0 means this ship will never be made
 * available for hire.”
 */
export interface EscortOfferSource {
    id: string;
    hireRandom: number;
}

export function isEscortOfferAvailable(
    hireRandom: number,
    sample: number,
): boolean {
    const chance = Math.max(0, Math.min(100, Math.floor(hireRandom)));
    return chance > 0 && Math.floor(sample) >= 0
        && Math.floor(sample) < chance;
}

function hashSample(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % 100;
}

/** Stable within a planet/day, different on the following retail day. */
export function availableEscortOffers<T extends EscortOfferSource>(
    ships: readonly T[],
    planetId: string,
    gameDate: number,
): T[] {
    return ships.filter(ship => isEscortOfferAvailable(
        ship.hireRandom,
        hashSample(`${planetId}:${Math.floor(gameDate)}:${ship.id}`),
    ));
}

export const EscortContractData = t.type({
    id: t.string,
    shipId: t.string,
    dailyPay: t.number,
});
export type EscortContract = t.TypeOf<typeof EscortContractData>;

export const EscortRosterData = t.type({
    contracts: t.array(EscortContractData),
});
export type EscortRoster = t.TypeOf<typeof EscortRosterData>;

export const EscortRosterComponent =
    new Component<EscortRoster>('EscortRosterComponent');

export interface EscortHireTerms extends EscortContract {
    hirePrice: number;
}

export type EscortHireResult = {
    hired: true;
    credits: number;
    roster: EscortRoster;
} | {
    hired: false;
    reason: 'insufficient-credits' | 'maximum-escorts' | 'already-hired';
    credits: number;
    roster: EscortRoster;
};

/**
 * Apply terms supplied by an authoritative caller. The Bible and retail data
 * expose the concepts of Hiring Price, Pay and a maximum, but neither source
 * contains their formulas; this function therefore has no guessed defaults.
 */
export function hireEscort(
    credits: number,
    roster: EscortRoster,
    terms: EscortHireTerms,
    maximumEscorts: number,
): EscortHireResult {
    if (roster.contracts.some(contract => contract.id === terms.id)) {
        return { hired: false, reason: 'already-hired', credits, roster };
    }
    if (roster.contracts.length >= Math.max(0, Math.floor(maximumEscorts))) {
        return { hired: false, reason: 'maximum-escorts', credits, roster };
    }
    const price = Math.max(0, Math.floor(terms.hirePrice));
    if (credits < price) {
        return { hired: false, reason: 'insufficient-credits', credits, roster };
    }
    return {
        hired: true,
        credits: credits - price,
        roster: {
            contracts: [...roster.contracts, {
                id: terms.id,
                shipId: terms.shipId,
                dailyPay: Math.max(0, Math.floor(terms.dailyPay)),
            }],
        },
    };
}

export function escortPayroll(roster: EscortRoster): number {
    return roster.contracts.reduce(
        (sum, contract) => sum + Math.max(0, Math.floor(contract.dailyPay)),
        0,
    );
}

export function dismissEscort(
    roster: EscortRoster,
    contractId: string,
): EscortRoster {
    return {
        contracts: roster.contracts.filter(contract =>
            contract.id !== contractId),
    };
}

const HiredEscortData = t.type({
    ownerUuid: t.string,
    contractId: t.string,
    slot: t.number,
});
type HiredEscortData = t.TypeOf<typeof HiredEscortData>;

export const HiredEscortComponent =
    new Component<HiredEscortData>('HiredEscortComponent');

function formationOffset(contractId: string, slot: number): Position {
    const angle = hashSample(contractId) / 100 * Math.PI * 2;
    const radius = 180 + Math.max(0, slot) * 45;
    return new Position(Math.cos(angle) * radius, Math.sin(angle) * radius);
}

/**
 * Construct an authoritative escort through the same makeNpc path as retail
 * traffic. The Bible says InherentAI is “what AI the ship uses when it's
 * escorting the player”; makeNpc already derives its profile from that field.
 */
export function makeHiredEscort(
    shipData: ShipData,
    ownerUuid: string,
    contractId: string,
    slot: number,
    ownerMovement: MovementState,
) {
    const escort = makeNpc(shipData);
    escort.components.set(HiredEscortComponent, {
        ownerUuid,
        contractId,
        slot,
    });
    escort.components.set(MultiplayerData, { owner: 'server' });
    const movement = copyMovementState(ownerMovement);
    const offset = formationOffset(contractId, slot);
    movement.position = new Position(
        ownerMovement.position.x + offset.x,
        ownerMovement.position.y + offset.y,
    );
    escort.components.set(MovementStateComponent, movement);
    return escort;
}

const SpawnHiredEscorts = new AsyncSystem({
    name: 'SpawnHiredEscorts',
    args: [
        EscortRosterComponent,
        MovementStateComponent,
        MultiplayerData,
        GameDataResource,
        GetWorld,
        GetEntity,
        PlatformResource,
    ] as const,
    exclusive: true,
    async step(
        roster,
        movement,
        multiplayer,
        gameData,
        world,
        owner,
        platform,
    ) {
        if (platform !== 'node' || multiplayer.owner === 'server') {
            return;
        }
        const existing = new Set([...world.entities.values()]
            .map(entity => entity.components.get(HiredEscortComponent))
            .filter((entry): entry is HiredEscortData => entry !== undefined)
            .map(entry => entry.contractId));
        for (let slot = 0; slot < roster.contracts.length; slot++) {
            const contract = roster.contracts[slot]!;
            if (existing.has(contract.id)) {
                continue;
            }
            const ship = await gameData.data.Ship.get(contract.shipId);
            world.entities.set(uuid(), makeHiredEscort(
                ship,
                owner.uuid,
                contract.id,
                slot,
                movement,
            ));
        }
    },
});

const FollowEscortOwner = new System({
    name: 'FollowEscortOwner',
    args: [
        HiredEscortComponent,
        MovementStateComponent,
        MovementPhysicsComponent,
        Entities,
        Optional(TargetComponent),
        PlatformResource,
    ] as const,
    step(escort, movement, physics, entities, combatTarget, platform) {
        if (platform !== 'node' || combatTarget?.target) {
            return;
        }
        const ownerMovement = entities.get(escort.ownerUuid)
            ?.components.get(MovementStateComponent);
        if (!ownerMovement) {
            movement.accelerating = 0;
            movement.turnTo = null;
            return;
        }
        const command = approachTarget(movement, ownerMovement, physics, {
            standoff: 180 + Math.max(0, escort.slot) * 45,
        });
        movement.turnTo = command.turnTo ?? escort.ownerUuid;
        movement.accelerating = command.accelerating;
        movement.turnBack = command.turnBack;
    },
});

const RemoveDismissedEscorts = new System({
    name: 'RemoveDismissedEscorts',
    args: [
        HiredEscortComponent,
        Entities,
        UUID,
        PlatformResource,
    ] as const,
    step(escort, entities, escortUuid, platform) {
        if (platform !== 'node') {
            return;
        }
        const roster = entities.get(escort.ownerUuid)
            ?.components.get(EscortRosterComponent);
        if (!roster || !roster.contracts.some(contract =>
            contract.id === escort.contractId)) {
            entities.delete(escortUuid);
        }
    },
});

export const EscortPlugin: Plugin = {
    name: 'EscortPlugin',
    build(world) {
        world.addComponent(EscortRosterComponent);
        world.addComponent(HiredEscortComponent);
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        deltaMaker.addComponent(EscortRosterComponent, {
            componentType: EscortRosterData,
        });
        deltaMaker.addComponent(HiredEscortComponent, {
            componentType: HiredEscortData,
        });
        world.addSystem(SpawnHiredEscorts);
        world.addSystem(FollowEscortOwner);
        world.addSystem(RemoveDismissedEscorts);
    },
    remove(world) {
        world.removeSystem(SpawnHiredEscorts);
        world.removeSystem(FollowEscortOwner);
        world.removeSystem(RemoveDismissedEscorts);
    },
};
