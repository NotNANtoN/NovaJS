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
    replicationPolicies,
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
import { JumpStateComponent } from './jump_plugin';
import { makeNpc } from './npc_plugin';
import { PlatformResource } from './platform_plugin';
import { TargetComponent } from './target_component';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { DeathEvent } from './death_plugin';
import { ControlStateEvent } from './control_state_event';
import { PlayerShipSelector } from './player_ship_plugin';
import {
    EscortContract,
    EscortContractData,
    PlayerStateComponent,
} from './player_state';

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

export { EscortContractData };
export type { EscortContract };

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

export const EscortMode = t.union([
    t.literal('formation'),
    t.literal('attack'),
    t.literal('defend'),
    t.literal('hold'),
]);
export type EscortMode = t.TypeOf<typeof EscortMode>;

export const FormationShape = t.union([
    t.literal('wedge'),
    t.literal('line'),
    t.literal('column'),
    t.literal('diamond'),
]);
export type FormationShape = t.TypeOf<typeof FormationShape>;

export const EscortOrderData = t.intersection([
    t.type({
        mode: EscortMode,
        sequence: t.number,
    }),
    t.partial({
        targetUuid: t.string,
        formationShape: FormationShape,
    }),
]);
export type EscortOrderData = t.TypeOf<typeof EscortOrderData>;

export const EscortOrderComponent =
    new Component<EscortOrderData>('EscortOrderComponent');

export const EscortOrderNoticeComponent =
    new Component<{ text: string; sequence: number }>('EscortOrderNoticeComponent');

replicationPolicies.register(EscortOrderComponent, {
    codec: EscortOrderData,
    authority: 'owning-client',
});

const HiredEscortData = t.type({
    ownerUuid: t.string,
    contractId: t.string,
    slot: t.number,
});
type HiredEscortData = t.TypeOf<typeof HiredEscortData>;

export const HiredEscortComponent =
    new Component<HiredEscortData>('HiredEscortComponent');

export interface FormationSlotOffset {
    lateral: number;      // positive = starboard (right), negative = port (left)
    longitudinal: number; // positive = ahead, negative = astern (trailing)
}

/**
 * Tactical V-formation slot offsets for naval escort wings.
 * Slot 0: Port wing trailing (-120, -90)
 * Slot 1: Starboard wing trailing (+120, -90)
 * Slot 2: Port outer wing (-180, -150)
 * Slot 3: Starboard outer wing (+180, -150)
 */
/**
 * Compute slot offsets for naval escort formations:
 * - wedge: Classical V-formation trailing the flagship
 * - line: Line abreast (wall) expanding laterally along the beam
 * - column: Single file trail directly astern
 * - diamond: 360-degree perimeter defense around the flagship
 */
export function formationSlotOffset(
    slot: number,
    shape: FormationShape = 'wedge',
): FormationSlotOffset {
    const s = Math.max(0, Math.floor(slot));
    switch (shape) {
        case 'wedge': {
            const rank = Math.floor(s / 2) + 1;
            const side = s % 2 === 0 ? -1 : 1;
            const lateral = side * (60 + rank * 60);
            const longitudinal = -(30 + rank * 60);
            return { lateral, longitudinal };
        }
        case 'line': {
            const rank = Math.floor(s / 2) + 1;
            const side = s % 2 === 0 ? -1 : 1;
            const lateral = side * (rank * 120);
            const longitudinal = -(10 + rank * 10);
            return { lateral, longitudinal };
        }
        case 'column': {
            const rank = s + 1;
            const lateral = 0;
            const longitudinal = -(20 + rank * 100);
            return { lateral, longitudinal };
        }
        case 'diamond': {
            const diamondPresets: FormationSlotOffset[] = [
                { lateral: -140, longitudinal: 0 },
                { lateral: 140, longitudinal: 0 },
                { lateral: 0, longitudinal: 130 },
                { lateral: 0, longitudinal: -140 },
            ];
            if (s < diamondPresets.length) {
                return diamondPresets[s]!;
            }
            const extra = s - 4;
            const side = extra % 2 === 0 ? -1 : 1;
            const rank = Math.floor(extra / 2) + 1;
            return { lateral: side * (140 + rank * 60), longitudinal: -(100 + rank * 50) };
        }
    }
}

export function tacticalFormationSlot(slot: number): FormationSlotOffset {
    return formationSlotOffset(slot, 'wedge');
}

/**
 * Compute the world-space target position for an escort slot, oriented
 * according to the flagship's heading and selected formation shape.
 * In Nova's coordinate system, heading 0 is pointing up (0, -1),
 * and starboard (right) is (1, 0).
 */
export function worldFormationPosition(
    flagshipPosition: Position,
    flagshipRotation: { angle: number },
    slot: number,
    shape: FormationShape = 'wedge',
): Position {
    const { lateral, longitudinal } = formationSlotOffset(slot, shape);
    const theta = flagshipRotation.angle;
    const forwardX = Math.sin(theta);
    const forwardY = -Math.cos(theta);
    const rightX = Math.cos(theta);
    const rightY = Math.sin(theta);

    const worldX = flagshipPosition.x + longitudinal * forwardX + lateral * rightX;
    const worldY = flagshipPosition.y + longitudinal * forwardY + lateral * rightY;
    return new Position(worldX, worldY);
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
    shape: FormationShape = 'wedge',
) {
    const escort = makeNpc(shipData);
    escort.components.set(HiredEscortComponent, {
        ownerUuid,
        contractId,
        slot,
    });
    escort.components.set(MultiplayerData, { owner: 'server' });
    const movement = copyMovementState(ownerMovement);
    movement.position = worldFormationPosition(
        ownerMovement.position,
        ownerMovement.rotation,
        slot,
        shape,
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
            const ownerOrder = owner.components.get(EscortOrderComponent);
            world.entities.set(uuid(), makeHiredEscort(
                ship,
                owner.uuid,
                contract.id,
                slot,
                movement,
                ownerOrder?.formationShape ?? 'wedge',
            ));
        }
    },
});

export const PlayerEscortCommandInputSystem = new System({
    name: 'PlayerEscortCommandInputSystem',
    events: [ControlStateEvent],
    args: [
        ControlStateEvent,
        TargetComponent,
        Optional(EscortOrderComponent),
        GetEntity,
        PlatformResource,
        PlayerShipSelector,
    ] as const,
    step(controlState, target, currentOrder, entity, platform) {
        if (platform !== 'browser') {
            return;
        }
        let mode: EscortMode | undefined;
        let noticeText: string | undefined;
        let shape: FormationShape | undefined = currentOrder?.formationShape;

        const SHAPES: FormationShape[] = ['wedge', 'line', 'column', 'diamond'];
        const SHAPE_NAMES: Record<FormationShape, string> = {
            wedge: 'Wedge (V) formation',
            line: 'Line Abreast (Wall) formation',
            column: 'Column (Trail) formation',
            diamond: 'Diamond (Box) formation',
        };

        if (controlState.get('attack') === 'start') {
            if (target.target) {
                mode = 'attack';
                noticeText = 'Escorts: Focus fire on target';
            } else {
                entity.components.set(EscortOrderNoticeComponent, {
                    text: 'Escorts: No target selected',
                    sequence: (currentOrder?.sequence ?? 0) + 1,
                });
                return;
            }
        } else if (controlState.get('defend') === 'start') {
            mode = 'defend';
            noticeText = 'Escorts: Defending flagship';
        } else if (controlState.get('holdPosition') === 'start') {
            mode = 'hold';
            noticeText = 'Escorts: Holding position';
        } else if (controlState.get('formation') === 'start') {
            mode = 'formation';
            if (currentOrder?.mode === 'formation') {
                const current = shape ?? 'wedge';
                const nextIndex = (SHAPES.indexOf(current) + 1) % SHAPES.length;
                shape = SHAPES[nextIndex]!;
            } else {
                shape = shape ?? 'wedge';
            }
            noticeText = `Escorts: ${SHAPE_NAMES[shape]}`;
        }

        if (mode) {
            const sequence = (currentOrder?.sequence ?? 0) + 1;
            entity.components.set(EscortOrderComponent, {
                mode,
                sequence,
                ...(mode === 'attack' ? { targetUuid: target.target } : {}),
                ...(shape ? { formationShape: shape } : {}),
            });
            entity.components.set(EscortOrderNoticeComponent, {
                text: noticeText ?? '',
                sequence,
            });
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
        Optional(JumpStateComponent),
        PlatformResource,
    ] as const,
    step(escort, movement, physics, entities, combatTarget, jumpState,
        platform) {
        if (platform !== 'node' || combatTarget?.target) {
            return;
        }
        if (jumpState) {
            return;
        }
        const owner = entities.get(escort.ownerUuid);
        if (!owner) {
            movement.accelerating = 0;
            movement.turnTo = null;
            return;
        }
        const ownerOrder = owner.components.get(EscortOrderComponent);
        if (ownerOrder?.mode === 'hold') {
            if (movement.velocity.length > 5) {
                movement.turnBack = true;
                movement.accelerating = 1;
                movement.turnTo = null;
            } else {
                movement.accelerating = 0;
                movement.turnTo = null;
                movement.turnBack = false;
            }
            return;
        }
        const ownerMovement = owner.components.get(MovementStateComponent);
        if (!ownerMovement) {
            movement.accelerating = 0;
            movement.turnTo = null;
            return;
        }

        const slotPosition = worldFormationPosition(
            ownerMovement.position,
            ownerMovement.rotation,
            escort.slot,
            ownerOrder?.formationShape ?? 'wedge',
        );
        const command = approachTarget(
            movement,
            { position: slotPosition, velocity: ownerMovement.velocity },
            physics,
            { standoff: 0, tolerance: 20 },
        );
        movement.turnTo = command.turnTo ?? ownerMovement.rotation;
        movement.accelerating = command.accelerating;
        movement.turnBack = command.turnBack;
    },
});

export const EscortDefenseSystem = new System({
    name: 'EscortDefenseSystem',
    args: [
        HiredEscortComponent,
        TargetComponent,
        Entities,
        MultiplayerData,
        PlatformResource,
    ] as const,
    step(escort, target, entities, multiplayer, platform) {
        if (platform !== 'node' || multiplayer.owner !== 'server') {
            return;
        }
        const owner = entities.get(escort.ownerUuid);
        if (!owner) {
            return;
        }
        const order = owner.components.get(EscortOrderComponent);
        const mode = order?.mode ?? 'defend';

        if (mode === 'hold') {
            target.target = undefined;
            return;
        }

        if (mode === 'formation') {
            if (target.target && !entities.has(target.target)) {
                target.target = undefined;
            }
            return;
        }

        if (mode === 'attack') {
            const attackTarget = order?.targetUuid ?? owner.components.get(TargetComponent)?.target;
            if (attackTarget && entities.has(attackTarget) && attackTarget !== escort.ownerUuid) {
                const targetEscort = entities.get(attackTarget)?.components.get(HiredEscortComponent);
                if (targetEscort?.ownerUuid !== escort.ownerUuid) {
                    target.target = attackTarget;
                    return;
                }
            }
            if (target.target && !entities.has(target.target)) {
                target.target = undefined;
            }
            return;
        }

        // Defend mode
        let attackerUuid: string | undefined;
        for (const [entityUuid, entity] of entities) {
            if (entityUuid === escort.ownerUuid || entityUuid === escort.contractId) continue;
            const entityTarget = entity.components.get(TargetComponent)?.target;
            if (entityTarget === escort.ownerUuid) {
                attackerUuid = entityUuid;
                break;
            }
        }
        if (attackerUuid) {
            target.target = attackerUuid;
            return;
        }

        const ownerTarget = owner.components.get(TargetComponent)?.target;
        if (ownerTarget && entities.has(ownerTarget) && ownerTarget !== escort.ownerUuid) {
            const targetEscort = entities.get(ownerTarget)?.components.get(HiredEscortComponent);
            if (targetEscort?.ownerUuid !== escort.ownerUuid) {
                target.target = ownerTarget;
                return;
            }
        }
        if (target.target && !entities.has(target.target)) {
            target.target = undefined;
        }
    },
});

export const HandleEscortDestruction = new System({
    name: 'HandleEscortDestruction',
    events: [DeathEvent],
    args: [
        HiredEscortComponent,
        DeathEvent,
        Entities,
        PlatformResource,
    ] as const,
    step(escort, _death, entities, platform) {
        if (platform !== 'node') {
            return;
        }
        const owner = entities.get(escort.ownerUuid);
        if (!owner) {
            return;
        }
        const playerState = owner.components.get(PlayerStateComponent);
        if (playerState && playerState.escorts) {
            playerState.escorts = playerState.escorts.filter(
                contract => contract.id !== escort.contractId,
            );
            owner.components.set(PlayerStateComponent, playerState);
        }
        const roster = owner.components.get(EscortRosterComponent);
        if (roster) {
            owner.components.set(EscortRosterComponent, {
                contracts: roster.contracts.filter(
                    contract => contract.id !== escort.contractId,
                ),
            });
        }
    },
});

export const RemoveDismissedEscorts = new System({
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


/**
 * Mirror the saved contracts onto the roster component.
 *
 * The persisted state is the single authority: it is what reaches disk, what
 * pays the wing each day, and what drops an escort the pilot can no longer
 * afford. The component exists so the client can see the roster, so it is
 * only ever written in this direction.
 */
export const SyncEscortRoster = new System({
    name: 'SyncEscortRoster',
    args: [
        GetEntity,
        PlayerStateComponent,
        Optional(EscortRosterComponent),
        PlatformResource,
        MultiplayerData,
    ] as const,
    step(entity, playerState, roster, platform, multiplayer) {
        if (platform !== 'node' || multiplayer.owner === 'server') {
            return;
        }
        const saved = playerState.escorts ?? [];
        if (roster && sameContracts(roster.contracts, saved)) {
            return;
        }
        entity.components.set(EscortRosterComponent, {
            contracts: saved.map(contract => ({ ...contract })),
        });
    },
});

function sameContracts(
    a: readonly EscortContract[],
    b: readonly EscortContract[],
): boolean {
    return a.length === b.length && a.every((contract, index) =>
        contract.id === b[index].id
        && contract.shipId === b[index].shipId
        && contract.dailyPay === b[index].dailyPay);
}

export const EscortPlugin: Plugin = {
    name: 'EscortPlugin',
    build(world) {
        world.addComponent(EscortRosterComponent);
        world.addComponent(HiredEscortComponent);
        world.addComponent(EscortOrderComponent);
        world.addComponent(EscortOrderNoticeComponent);
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
        deltaMaker.addComponent(EscortOrderComponent, {
            componentType: EscortOrderData,
        });
        world.addSystem(SyncEscortRoster);
        world.addSystem(PlayerEscortCommandInputSystem);
        world.addSystem(SpawnHiredEscorts);
        world.addSystem(FollowEscortOwner);
        world.addSystem(EscortDefenseSystem);
        world.addSystem(HandleEscortDestruction);
        world.addSystem(RemoveDismissedEscorts);
    },
    remove(world) {
        world.removeSystem(SyncEscortRoster);
        world.removeSystem(PlayerEscortCommandInputSystem);
        world.removeSystem(SpawnHiredEscorts);
        world.removeSystem(FollowEscortOwner);
        world.removeSystem(EscortDefenseSystem);
        world.removeSystem(HandleEscortDestruction);
        world.removeSystem(RemoveDismissedEscorts);
    },
};
