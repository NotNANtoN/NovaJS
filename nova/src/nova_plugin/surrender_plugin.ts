import * as t from 'io-ts';
import { Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData, replicationPolicies } from 'nova_ecs/plugins/multiplayer_plugin';
import { System } from 'nova_ecs/system';
import { BoardingInventoryComponent, BoardingSetupSystem } from './boarding_plugin';
import { DisabledComponent } from './death_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { ENERGY_TRANSFER_RANGE } from './energy_transfer_plugin';
import { ArmorComponent } from './health_plugin';
import { JumpStateComponent } from './jump_plugin';
import { NpcAIComponent } from './npc_plugin';
import { PlayerStateComponent } from './player_state';
import { PlatformResource } from './platform_plugin';

const SurrenderRequest = t.type({ target: t.string, sequence: t.number });
export const SurrenderRequestComponent = new Component<t.TypeOf<typeof SurrenderRequest>>('SurrenderRequestComponent');
const SurrenderOutcome = t.intersection([
    t.type({ target: t.string, sequence: t.number,
        status: t.union([t.literal('paid'), t.literal('rejected')]), amount: t.number }),
    t.partial({ reason: t.string }),
]);
export const SurrenderOutcomeComponent = new Component<t.TypeOf<typeof SurrenderOutcome>>('SurrenderOutcomeComponent');
const SurrenderClaimedComponent = new Component<boolean>('SurrenderClaimedComponent');
const SurrenderSequenceComponent = new Component<number>('SurrenderSequenceComponent');

replicationPolicies.register(SurrenderRequestComponent, { codec: SurrenderRequest, authority: 'owning-client' });
replicationPolicies.register(SurrenderOutcomeComponent, { codec: SurrenderOutcome, authority: 'server' });
replicationPolicies.register(SurrenderClaimedComponent, { codec: t.boolean, authority: 'local-only' });
replicationPolicies.register(SurrenderSequenceComponent, { codec: t.number, authority: 'local-only' });

export const SurrenderSystem = new System({
    name: 'SurrenderSystem',
    after: [BoardingSetupSystem],
    args: [SurrenderRequestComponent, PlayerStateComponent, MultiplayerData,
        PlatformResource, GetEntity, Entities, UUID, Optional(MovementStateComponent)] as const,
    step(request, state, multiplayer, platform, player, entities, uuid, movement) {
        if (platform !== 'node' || multiplayer.owner === 'server') return;
        if (!Number.isSafeInteger(request.sequence) || request.sequence <= 0) return;
        if (request.sequence <= (player.components.get(SurrenderSequenceComponent) ?? 0)) return;
        player.components.set(SurrenderSequenceComponent, request.sequence);
        const reject = (reason: string) => player.components.set(SurrenderOutcomeComponent, {
            target: request.target, sequence: request.sequence, status: 'rejected', amount: 0, reason,
        });
        if (!movement || player.components.get(DisabledComponent)
            || player.components.has(DestructionStartedComponent)
            || player.components.has(JumpStateComponent)
            || (player.components.get(ArmorComponent)?.current ?? 1) <= 0
            || !Number.isFinite(state.credits)) {
            reject('player-unavailable');
            return;
        }
        const target = entities.get(request.target);
        if (!target || request.target === uuid || !target.components.has(NpcAIComponent)
            || target.components.get(MultiplayerData)?.owner !== 'server'
            || target.components.has(PlayerStateComponent)) {
            reject('invalid-target');
            return;
        }
        if (!target.components.get(DisabledComponent)
            || target.components.has(DestructionStartedComponent)
            || target.components.has(JumpStateComponent)
            || (target.components.get(ArmorComponent)?.current ?? 1) <= 0) {
            reject('target-unavailable');
            return;
        }
        const targetMovement = target.components.get(MovementStateComponent);
        const distance = targetMovement
            ? Math.hypot(movement.position.x - targetMovement.position.x,
                movement.position.y - targetMovement.position.y) : Infinity;
        // Use the existing ship-transfer range; no retail hail range is assumed.
        if (!Number.isFinite(distance) || distance > ENERGY_TRANSFER_RANGE) {
            reject('out-of-range');
            return;
        }
        if (target.components.get(SurrenderClaimedComponent)) {
            reject('already-surrendered');
            return;
        }
        const inventory = target.components.get(BoardingInventoryComponent);
        if (!inventory || !Number.isFinite(inventory.credits) || inventory.credits < 1) {
            reject('no-credits');
            return;
        }
        // Draw from the same purse as boarding, never mint another reward.
        const amount = Math.min(5_000, Math.floor(inventory.credits));
        target.components.set(SurrenderClaimedComponent, true);
        inventory.credits -= amount;
        state.credits += amount;
        player.components.set(SurrenderOutcomeComponent, {
            target: request.target, sequence: request.sequence, status: 'paid', amount,
        });
    },
});

export const SurrenderPlugin: Plugin = {
    name: 'SurrenderPlugin',
    build(world) {
        const delta = world.resources.get(DeltaResource);
        if (!delta) throw new Error('Expected delta maker resource to exist');
        world.addComponent(SurrenderClaimedComponent);
        world.addComponent(SurrenderSequenceComponent);
        world.addComponent(SurrenderRequestComponent);
        world.addComponent(SurrenderOutcomeComponent);
        delta.addComponent(SurrenderRequestComponent, { componentType: SurrenderRequest });
        delta.addComponent(SurrenderOutcomeComponent, { componentType: SurrenderOutcome });
        world.addSystem(SurrenderSystem);
    },
    remove(world) {
        world.removeSystem(SurrenderSystem);
    },
};
