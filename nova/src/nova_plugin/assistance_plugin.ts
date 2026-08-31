import * as t from 'io-ts';
import {
    Entities,
    GetEntity,
    GetWorld,
    UUID,
} from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Entity } from 'nova_ecs/entity';
import {
    MovementPhysicsComponent,
    MovementStateComponent,
} from 'nova_ecs/plugins/movement_plugin';
import {
    MultiplayerData,
    replicationPolicies,
} from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { System } from 'nova_ecs/system';
import { DisabledComponent } from './death_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { approachTarget } from './flight_controller';
import {
    ASSISTANCE_FUEL,
    assistanceDecision,
    assistanceGenerosity,
    AssistanceDecision,
    hailRelation,
    payForAssistance,
    receiveAssistanceFuel,
    receiveAssistanceRepair,
} from './comms';
import {
    BOARDING_STANDOFF,
    BOARDING_TOLERANCE,
    isBoardingTransferReady,
} from './boarding_plugin';
import {
    GovernmentFlags,
    GovernmentRelationResource,
    GovernmentRelationStore,
} from './govt_relations';
import { isCriminal, recordFor } from './legal_record';
import { HiredEscortComponent } from './escort_plugin';
import {
    FollowAI,
    NpcAIComponent,
    NpcPurposeAI,
    ShootAllWeaponsAI,
} from './npc_plugin';
import { ArmorComponent } from './health_plugin';
import { JumpStateComponent } from './jump_plugin';
import { PlayerStateComponent } from './player_state';
import { PlatformResource } from './platform_plugin';
import { ShipDataComponent } from './ship_plugin';
import { TargetComponent } from './target_component';
import { GovtComponent } from './npc_components';
import { WeaponsStateComponent } from './weapons_state';

const AssistanceAction = t.union([
    t.literal('request'),
    t.literal('accept'),
]);
export type AssistanceAction = t.TypeOf<typeof AssistanceAction>;

const AssistanceRequestCodec = t.type({
    helper: t.string,
    sequence: t.number,
    action: AssistanceAction,
});
export type AssistanceRequest = t.TypeOf<typeof AssistanceRequestCodec>;
export const AssistanceRequestComponent =
    new Component<AssistanceRequest>('AssistanceRequestComponent');

const AssistanceOrderCodec = t.type({
    player: t.string,
    sequence: t.number,
    expiresAt: t.number,
});
export type AssistanceOrder = t.TypeOf<typeof AssistanceOrderCodec>;
export const AssistanceOrderComponent =
    new Component<AssistanceOrder>('AssistanceOrderComponent');

export const AssistanceOutcomePhase = t.union([
    t.literal('approaching'),
    t.literal('completed'),
    t.literal('failed'),
]);
export type AssistanceOutcomePhase = t.TypeOf<typeof AssistanceOutcomePhase>;

export const AssistanceFailureReason = t.union([
    t.literal('invalid-request'),
    t.literal('invalid-helper'),
    t.literal('invalid-player'),
    t.literal('not-stranded'),
    t.literal('hostile'),
    t.literal('refused'),
    t.literal('payment-required'),
    t.literal('cannot-afford'),
    t.literal('busy'),
    t.literal('timeout'),
    t.literal('helper-destroyed'),
    t.literal('player-destroyed'),
    t.literal('helper-jumped'),
    t.literal('player-jumped'),
    t.literal('helper-left-system'),
    t.literal('player-left-system'),
]);
export type AssistanceFailureReason = t.TypeOf<typeof AssistanceFailureReason>;

const AssistanceOutcomeCodec = t.intersection([
    t.type({
        helper: t.string,
        sequence: t.number,
        phase: AssistanceOutcomePhase,
    }),
    t.partial({
        reason: AssistanceFailureReason,
    }),
]);
export type AssistanceOutcome = t.TypeOf<typeof AssistanceOutcomeCodec>;
export const AssistanceOutcomeComponent =
    new Component<AssistanceOutcome>('AssistanceOutcomeComponent');

export const ASSISTANCE_TIMEOUT_MS = 60_000;
const ROADSIDE_ASSISTANCE_FLAG = 0x0010;

replicationPolicies.register(AssistanceRequestComponent, {
    codec: AssistanceRequestCodec,
    authority: 'owning-client',
});
replicationPolicies.register(AssistanceOutcomeComponent, {
    codec: AssistanceOutcomeCodec,
    authority: 'server',
});

function setOutcome(
    entity: Entity,
    helper: string,
    sequence: number,
    phase: AssistanceOutcomePhase,
    reason?: AssistanceFailureReason,
): void {
    entity.components.set(AssistanceOutcomeComponent, {
        helper,
        sequence,
        phase,
        ...(reason ? { reason } : {}),
    });
}

function clearOrder(helper: Entity): void {
    helper.components.delete(AssistanceOrderComponent);
    const target = helper.components.get(TargetComponent);
    if (target) {
        target.target = undefined;
    }
}

function isValidRequest(request: AssistanceRequest): boolean {
    return typeof request.helper === 'string'
        && request.helper.length > 0
        && Number.isSafeInteger(request.sequence)
        && request.sequence > 0
        && (request.action === 'request' || request.action === 'accept');
}

function isStranded(
    state: { fuel?: number },
    fuelCapacity: number,
    disabled: boolean,
): boolean {
    return disabled || fuelCapacity > 0
        && (state.fuel ?? 0) < ASSISTANCE_FUEL;
}

function decisionFailure(
    outcome: AssistanceDecision['outcome'],
): AssistanceFailureReason {
    switch (outcome) {
        case 'notInTrouble':
            return 'not-stranded';
        case 'mocked':
            return 'hostile';
        case 'refused':
            return 'refused';
        case 'wantsPayment':
            return 'payment-required';
        case 'granted':
            return 'invalid-request';
    }
}

function authoritativeDecision(
    playerUuid: string,
    helperUuid: string,
    playerState: {
        fuel?: number,
        fuelCapacity: number,
        disabled: boolean,
        legalRecords?: Record<string, number>,
    },
    helper: Entity,
    governments: GovernmentRelationStore | undefined,
): AssistanceDecision | undefined {
    const governmentRef = helper.components.get(GovtComponent);
    const government = governmentRef
        ? governments?.getCached(governmentRef.id)
        : undefined;
    if (governmentRef && !government) {
        return undefined;
    }

    const record = government
        ? recordFor(
            playerState.legalRecords,
            String(government.id),
            government,
        )
        : 0;
    const hostile = helper.components.get(TargetComponent)?.target
        === playerUuid;
    const flags = government?.flags ?? 0;
    return assistanceDecision({
        relation: government
            ? hailRelation({
                record,
                crimeTolerance: government.crimeTolerance ?? 0,
                hostile,
                alwaysHostile: Boolean(flags
                    & (GovernmentFlags.alwaysAttacksPlayer
                        | GovernmentFlags.xenophobic))
                    || isCriminal(record, government.crimeTolerance ?? 0),
            })
            : 'neutral',
        hostile,
        record,
        fuel: playerState.fuel ?? 0,
        fuelCapacity: playerState.fuelCapacity,
        disabled: playerState.disabled,
        roadsideAssistance: Boolean(
            government?.flags2 && (government.flags2
                & ROADSIDE_ASSISTANCE_FLAG)),
        isEscort: helper.components.has(HiredEscortComponent),
        generosity: assistanceGenerosity(playerUuid, helperUuid),
    });
}

function finishOrder(
    helper: Entity,
    helperUuid: string,
    order: AssistanceOrder,
    entities: Map<string, Entity>,
    phase: 'completed' | 'failed',
    reason?: AssistanceFailureReason,
): void {
    clearOrder(helper);
    const player = entities.get(order.player);
    const outcome = player?.components.get(AssistanceOutcomeComponent);
    if (player && (!outcome
        || outcome.helper === helperUuid
        && outcome.sequence <= order.sequence)) {
        setOutcome(player, helperUuid, order.sequence, phase, reason);
    }
}

export const AssistanceApproachSystem = new System({
    name: 'AssistanceApproachSystem',
    after: [NpcPurposeAI, FollowAI, ShootAllWeaponsAI],
    args: [
        AssistanceOrderComponent,
        MovementStateComponent,
        MovementPhysicsComponent,
        Optional(TargetComponent),
        Optional(WeaponsStateComponent),
        Entities,
        MultiplayerData,
        PlatformResource,
        NpcAIComponent,
        Optional(DisabledComponent),
        Optional(DestructionStartedComponent),
        Optional(ArmorComponent),
        Optional(JumpStateComponent),
        UUID,
        TimeResource,
        GetEntity,
    ] as const,
    step(
        order,
        movement,
        physics,
        target,
        weapons,
        entities,
        multiplayer,
        platform,
        _npc,
        disabled,
        destructionStarted,
        armor,
        jumpState,
        uuid,
        time,
        helper,
    ) {
        if (platform !== 'node' || multiplayer.owner !== 'server') {
            return;
        }

        const player = entities.get(order.player);
        const playerState = player?.components.get(PlayerStateComponent);
        const playerMovement =
            player?.components.get(MovementStateComponent);
        const playerShip = player?.components.get(ShipDataComponent);
        const playerArmor = player?.components.get(ArmorComponent);
        const playerDisabled =
            player?.components.get(DisabledComponent);
        const playerDestruction =
            player?.components.get(DestructionStartedComponent);
        const playerJump = player?.components.get(JumpStateComponent);
        const playerOutcome =
            player?.components.get(AssistanceOutcomeComponent);

        if (playerOutcome && (playerOutcome.helper !== uuid
            || playerOutcome.sequence !== order.sequence
            || playerOutcome.phase !== 'approaching')) {
            clearOrder(helper);
            return;
        }
        if (!player || !playerState || !playerMovement || !playerShip) {
            finishOrder(
                helper, uuid, order, entities, 'failed', 'invalid-player');
            return;
        }
        if (playerDestruction || playerArmor && playerArmor.current <= 0) {
            finishOrder(
                helper, uuid, order, entities, 'failed',
                'player-destroyed');
            return;
        }
        if (playerJump) {
            finishOrder(
                helper, uuid, order, entities, 'failed', 'player-jumped');
            return;
        }
        if (destructionStarted || armor && armor.current <= 0) {
            finishOrder(
                helper, uuid, order, entities, 'failed',
                'helper-destroyed');
            return;
        }
        if (jumpState) {
            finishOrder(
                helper, uuid, order, entities, 'failed', 'helper-jumped');
            return;
        }
        if (disabled) {
            finishOrder(
                helper, uuid, order, entities, 'failed', 'invalid-helper');
            return;
        }
        if (!isStranded(
            playerState,
            playerShip.fuelCapacity,
            Boolean(playerDisabled),
        )) {
            finishOrder(
                helper, uuid, order, entities, 'failed', 'not-stranded');
            return;
        }
        if (time.time >= order.expiresAt) {
            finishOrder(
                helper, uuid, order, entities, 'failed', 'timeout');
            return;
        }

        for (const weapon of weapons?.values() ?? []) {
            weapon.firing = false;
            weapon.target = undefined;
        }
        if (target) {
            target.target = order.player;
        }

        if (isBoardingTransferReady(movement, playerMovement)) {
            if (playerDisabled) {
                if (!playerArmor) {
                    finishOrder(
                        helper, uuid, order, entities, 'failed',
                        'invalid-player');
                    return;
                }
                playerArmor.current = receiveAssistanceRepair(
                    playerArmor.max);
            } else {
                playerState.fuel = receiveAssistanceFuel(
                    playerState.fuel ?? 0,
                    playerShip.fuelCapacity,
                );
            }
            finishOrder(helper, uuid, order, entities, 'completed');
            return;
        }

        const command = approachTarget(movement, playerMovement, physics, {
            standoff: BOARDING_STANDOFF,
            tolerance: BOARDING_TOLERANCE,
        });
        movement.turnTo = command.turnTo;
        movement.accelerating = command.accelerating;
        movement.turnBack = command.turnBack;
        if (command.turnTo === null && !command.turnBack) {
            movement.turning = 0;
        }
    },
});

export const AssistanceRequestSystem = new System({
    name: 'AssistanceRequestSystem',
    before: [AssistanceApproachSystem],
    args: [
        AssistanceRequestComponent,
        PlayerStateComponent,
        ShipDataComponent,
        MultiplayerData,
        Optional(DisabledComponent),
        Optional(DestructionStartedComponent),
        Optional(ArmorComponent),
        Optional(JumpStateComponent),
        Optional(AssistanceOutcomeComponent),
        Entities,
        TimeResource,
        PlatformResource,
        UUID,
        GetEntity,
        GetWorld,
    ] as const,
    step(
        request,
        playerState,
        shipData,
        multiplayer,
        disabled,
        destructionStarted,
        armor,
        jumpState,
        outcome,
        entities,
        time,
        platform,
        uuid,
        player,
        world,
    ) {
        if (platform !== 'node' || multiplayer.owner === 'server') {
            return;
        }
        if (outcome && outcome.helper === request.helper
            && outcome.sequence >= request.sequence) {
            return;
        }
        if (!isValidRequest(request)) {
            setOutcome(
                player, request.helper, request.sequence, 'failed',
                'invalid-request');
            return;
        }
        if (destructionStarted || armor && armor.current <= 0) {
            setOutcome(
                player, request.helper, request.sequence, 'failed',
                'player-destroyed');
            return;
        }
        if (jumpState) {
            setOutcome(
                player, request.helper, request.sequence, 'failed',
                'player-jumped');
            return;
        }
        const governments = world.resources.get(
            GovernmentRelationResource);

        const helper = entities.get(request.helper);
        const helperMultiplayer = helper?.components.get(MultiplayerData);
        const helperArmor = helper?.components.get(ArmorComponent);
        const helperJump = helper?.components.get(JumpStateComponent);
        const helperDestruction =
            helper?.components.get(DestructionStartedComponent);
        if (!helper) {
            setOutcome(
                player, request.helper, request.sequence, 'failed',
                'helper-left-system');
            return;
        }
        if (!helper.components.has(NpcAIComponent)
            || helperMultiplayer?.owner !== 'server'
            || !helper.components.has(MovementStateComponent)
            || !helper.components.has(MovementPhysicsComponent)) {
            setOutcome(
                player, request.helper, request.sequence, 'failed',
                'invalid-helper');
            return;
        }
        if (helperDestruction || helperArmor && helperArmor.current <= 0) {
            setOutcome(
                player, request.helper, request.sequence, 'failed',
                'helper-destroyed');
            return;
        }
        if (helperJump) {
            setOutcome(
                player, request.helper, request.sequence, 'failed',
                'helper-jumped');
            return;
        }

        const existingOrder =
            helper.components.get(AssistanceOrderComponent);
        if (existingOrder) {
            if (existingOrder.player === uuid
                && existingOrder.sequence === request.sequence) {
                setOutcome(
                    player, request.helper, request.sequence, 'approaching');
            } else {
                setOutcome(
                    player, request.helper, request.sequence, 'failed',
                    'busy');
            }
            return;
        }

        const decision = authoritativeDecision(
            uuid,
            request.helper,
            {
                fuel: playerState.fuel ?? 0,
                fuelCapacity: shipData.fuelCapacity,
                disabled: Boolean(disabled),
                legalRecords: playerState.legalRecords,
            },
            helper,
            governments,
        );
        if (!decision) {
            return;
        }
        if (request.action === 'request'
            && decision.outcome !== 'granted') {
            setOutcome(
                player, request.helper, request.sequence, 'failed',
                decisionFailure(decision.outcome));
            return;
        }
        if (request.action === 'accept'
            && decision.outcome !== 'granted'
            && decision.outcome !== 'wantsPayment') {
            setOutcome(
                player, request.helper, request.sequence, 'failed',
                decisionFailure(decision.outcome));
            return;
        }
        if (decision.outcome === 'wantsPayment') {
            if (request.action !== 'accept') {
                setOutcome(
                    player, request.helper, request.sequence, 'failed',
                    'payment-required');
                return;
            }
            const payment = payForAssistance(
                Number.isFinite(playerState.credits)
                    ? Math.max(0, playerState.credits) : 0,
                decision.price,
            );
            if (!payment.paid) {
                setOutcome(
                    player, request.helper, request.sequence, 'failed',
                    'cannot-afford');
                return;
            }
            playerState.credits = payment.credits;
        }

        helper.components.set(AssistanceOrderComponent, {
            player: uuid,
            sequence: request.sequence,
            expiresAt: time.time + ASSISTANCE_TIMEOUT_MS,
        });
        const helperTarget = helper.components.get(TargetComponent);
        if (helperTarget) {
            helperTarget.target = uuid;
        }
        setOutcome(
            player, request.helper, request.sequence, 'approaching');
    },
});

export const AssistanceLifecycleSystem = new System({
    name: 'AssistanceLifecycleSystem',
    after: [AssistanceApproachSystem],
    args: [
        AssistanceOutcomeComponent,
        Optional(PlayerStateComponent),
        Optional(ShipDataComponent),
        Optional(DisabledComponent),
        Optional(DestructionStartedComponent),
        Optional(ArmorComponent),
        Optional(JumpStateComponent),
        Entities,
        TimeResource,
        PlatformResource,
        UUID,
    ] as const,
    step(
        outcome,
        playerState,
        shipData,
        disabled,
        destructionStarted,
        armor,
        jumpState,
        entities,
        time,
        platform,
        uuid,
    ) {
        if (platform !== 'node' || outcome.phase !== 'approaching') {
            return;
        }
        if (!playerState || !shipData) {
            failFromPlayerState(
                outcome, uuid, entities, 'invalid-player');
            return;
        }
        if (destructionStarted || armor && armor.current <= 0) {
            failFromPlayerState(
                outcome, uuid, entities, 'player-destroyed');
            return;
        }
        if (jumpState) {
            failFromPlayerState(outcome, uuid, entities, 'player-jumped');
            return;
        }
        if (!isStranded(
            playerState,
            shipData.fuelCapacity,
            Boolean(disabled),
        )) {
            failFromPlayerState(outcome, uuid, entities, 'not-stranded');
            return;
        }

        const helper = entities.get(outcome.helper);
        const order = helper?.components.get(AssistanceOrderComponent);
        if (!helper) {
            setOutcome(
                entities.get(uuid)!, outcome.helper, outcome.sequence,
                'failed', 'helper-left-system');
            return;
        }
        if (!order || order.player !== uuid
            || order.sequence !== outcome.sequence) {
            setOutcome(
                entities.get(uuid)!, outcome.helper, outcome.sequence,
                'failed', 'invalid-helper');
            return;
        }
        if (!helper.components.has(NpcAIComponent)
            || helper.components.get(MultiplayerData)?.owner !== 'server'
            || !helper.components.has(MovementStateComponent)
            || !helper.components.has(MovementPhysicsComponent)) {
            clearOrder(helper);
            setOutcome(
                entities.get(uuid)!, outcome.helper, outcome.sequence,
                'failed', 'invalid-helper');
            return;
        }
        if (time.time >= order.expiresAt) {
            finishOrder(
                helper, outcome.helper, order, entities, 'failed', 'timeout');
        }
    },
});

function failFromPlayerState(
    outcome: AssistanceOutcome,
    uuid: string,
    entities: Map<string, Entity>,
    reason: AssistanceFailureReason,
): void {
    const helper = entities.get(outcome.helper);
    const order = helper?.components.get(AssistanceOrderComponent);
    if (helper && order && order.player === uuid
        && order.sequence === outcome.sequence) {
        finishOrder(helper, outcome.helper, order, entities, 'failed', reason);
        return;
    }
    const player = entities.get(uuid);
    if (player) {
        setOutcome(player, outcome.helper, outcome.sequence, 'failed', reason);
    }
}

export const AssistancePlugin: Plugin = {
    name: 'AssistancePlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        world.addComponent(AssistanceRequestComponent);
        deltaMaker.addComponent(AssistanceRequestComponent, {
            componentType: AssistanceRequestCodec,
        });
        world.addComponent(AssistanceOrderComponent);
        world.addComponent(AssistanceOutcomeComponent);
        deltaMaker.addComponent(AssistanceOutcomeComponent, {
            componentType: AssistanceOutcomeCodec,
        });
        world.addSystem(AssistanceRequestSystem);
        world.addSystem(AssistanceApproachSystem);
        world.addSystem(AssistanceLifecycleSystem);
    },
    remove(world) {
        world.removeSystem(AssistanceRequestSystem);
        world.removeSystem(AssistanceApproachSystem);
        world.removeSystem(AssistanceLifecycleSystem);
    },
};
