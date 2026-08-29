import * as t from 'io-ts';
import { Emit, EmitNow, Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { EcsEvent } from 'nova_ecs/events';
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
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { System } from 'nova_ecs/system';
import { Query } from 'nova_ecs/query';
import { ControlStateEvent } from './control_state_event';
import { DisabledComponent } from './death_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { ArmorComponent } from './health_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { PlayerStateComponent } from './player_state';
import { ShipDataComponent } from './ship_plugin';
import { TargetComponent } from './target_component';
import { BoardingNoticeComponent } from './boarding_plugin';
import { hasArrived, inTransferRange } from './flight_controller';
import { PlatformResource } from './platform_plugin';
import { SoundEvent } from './sound_event';

export const ENERGY_TRANSFER_RANGE = 300;
export const ENERGY_TRANSFER_AMOUNT = 100;

export const EnergyTransferRequest = t.type({
    target: t.string,
    sequence: t.number,
});
export type EnergyTransferRequest = t.TypeOf<typeof EnergyTransferRequest>;
export const EnergyTransferRequestComponent =
    new Component<EnergyTransferRequest>('EnergyTransferRequestComponent');

export const EnergyTransferOutcome = t.type({
    target: t.string,
    sequence: t.number,
    amount: t.number,
});
export type EnergyTransferOutcome = t.TypeOf<typeof EnergyTransferOutcome>;
export const EnergyTransferOutcomeComponent =
    new Component<EnergyTransferOutcome>('EnergyTransferOutcomeComponent');

replicationPolicies.register(EnergyTransferRequestComponent, {
    codec: EnergyTransferRequest,
    authority: 'owning-client',
});
replicationPolicies.register(EnergyTransferOutcomeComponent, {
    codec: EnergyTransferOutcome,
    authority: 'server',
});

const TargetShipsQuery = new Query([
    UUID,
    MovementStateComponent,
    Optional(PlayerStateComponent),
    Optional(ShipDataComponent),
    Optional(DisabledComponent),
    Optional(DestructionStartedComponent),
    Optional(ArmorComponent),
] as const, 'TargetShipsQuery');

export const PlayerEnergyTransferInputSystem = new System({
    name: 'PlayerEnergyTransferInput',
    events: [ControlStateEvent],
    args: [
        ControlStateEvent,
        TargetComponent,
        MovementStateComponent,
        Optional(PlayerStateComponent),
        Optional(EnergyTransferRequestComponent),
        TargetShipsQuery,
        PlatformResource,
        GetEntity,
        PlayerShipSelector,
    ] as const,
    step(controlState, target, movement, playerState, request, targets,
        platform, entity) {
        if (platform !== 'browser' || controlState.get('transferEnergy') !== 'start') {
            return;
        }
        const targetUuid = target.target;
        if (!targetUuid) {
            entity.components.set(BoardingNoticeComponent,
                { text: 'No ship targeted to transfer energy.' });
            return;
        }

        const candidate = targets.find(t => t[0] === targetUuid && !t[5]);
        if (!candidate) {
            entity.components.set(BoardingNoticeComponent,
                { text: 'Target ship is not available.' });
            return;
        }

        if (!inTransferRange(movement, candidate[1], ENERGY_TRANSFER_RANGE)) {
            entity.components.set(BoardingNoticeComponent,
                { text: 'Too far away to transfer energy.' });
            return;
        }

        const fuel = playerState?.fuel ?? 0;
        if (fuel <= 0) {
            entity.components.set(BoardingNoticeComponent,
                { text: 'Insufficient energy to transfer.' });
            return;
        }

        entity.components.set(EnergyTransferRequestComponent, {
            target: targetUuid,
            sequence: (request?.sequence ?? 0) + 1,
        });
    },
});

export const ServerEnergyTransferSystem = new System({
    name: 'ServerEnergyTransferSystem',
    args: [
        EnergyTransferRequestComponent,
        PlayerStateComponent,
        MovementStateComponent,
        MultiplayerData,
        TargetShipsQuery,
        PlatformResource,
        Optional(DestructionStartedComponent),
        Optional(ArmorComponent),
        UUID,
        GetEntity,
        Entities,
        Emit,
    ] as const,
    step(request, sourcePlayer, movement, multiplayer, targets, platform,
        destructionStarted, armor, uuid, entity, entities, emit) {
        if (platform !== 'node' || multiplayer.owner === 'server'
            || destructionStarted || armor && armor.current <= 0) {
            return;
        }

        const candidate = targets.find(t => t[0] === request.target && t[0] !== uuid && !t[5]);
        if (!candidate || !inTransferRange(movement, candidate[1], ENERGY_TRANSFER_RANGE)) {
            entity.components.delete(EnergyTransferRequestComponent);
            return;
        }

        const availableFuel = sourcePlayer.fuel ?? 0;
        if (availableFuel <= 0) {
            entity.components.delete(EnergyTransferRequestComponent);
            return;
        }

        const transferAmount = Math.min(ENERGY_TRANSFER_AMOUNT, availableFuel);
        sourcePlayer.fuel = availableFuel - transferAmount;

        const targetPlayer = candidate[2];
        const targetShipData = candidate[3];
        const targetEntity = entities.get(request.target);

        if (targetPlayer) {
            const currentTargetFuel = targetPlayer.fuel ?? 0;
            const maxCap = targetShipData?.fuelCapacity || 500;
            targetPlayer.fuel = Math.min(maxCap, currentTargetFuel + transferAmount);

            // Notify recipient
            if (targetEntity) {
                const senderName = sourcePlayer.pilotName ? `Capt. ${sourcePlayer.pilotName}` : 'a friendly ship';
                targetEntity.components.set(BoardingNoticeComponent, {
                    text: `Received ${transferAmount} energy from ${senderName}.`,
                });
            }
        }

        // Notify sender
        const recipientName = targetPlayer?.pilotName
            ? `Capt. ${targetPlayer.pilotName}`
            : (targetShipData?.name || 'target ship');
        entity.components.set(BoardingNoticeComponent, {
            text: `Transferred ${transferAmount} energy to ${recipientName}.`,
        });

        emit(SoundEvent, { id: 'nova:150' });
        entity.components.delete(EnergyTransferRequestComponent);
    },
});

export const EnergyTransferPlugin: Plugin = {
    name: 'EnergyTransferPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        world.addComponent(EnergyTransferRequestComponent);
        deltaMaker.addComponent(EnergyTransferRequestComponent, {
            componentType: EnergyTransferRequest,
        });
        world.addComponent(EnergyTransferOutcomeComponent);
        deltaMaker.addComponent(EnergyTransferOutcomeComponent, {
            componentType: EnergyTransferOutcome,
        });
        world.addSystem(PlayerEnergyTransferInputSystem);
        world.addSystem(ServerEnergyTransferSystem);
    },
    remove(world) {
        world.removeSystem(PlayerEnergyTransferInputSystem);
        world.removeSystem(ServerEnergyTransferSystem);
    },
};
