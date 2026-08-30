import * as t from 'io-ts';
import { Emit, Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import {
    MovementStateComponent,
} from 'nova_ecs/plugins/movement_plugin';
import {
    MultiplayerData,
    replicationPolicies,
} from 'nova_ecs/plugins/multiplayer_plugin';
import { System } from 'nova_ecs/system';
import { v4 as uuid } from 'uuid';
import { ControlStateEvent } from './control_state_event';
import { EntityBudgetResource, reserveEntity } from './entity_budget';
import { PlatformResource } from './platform_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { PlayerStateComponent, releaseCargo } from './player_state';
import { BoardingNoticeComponent } from './boarding_plugin';
import { makeOre } from './asteroid_plugin';

export const JettisonRequest = t.type({
    sequence: t.number,
});
export type JettisonRequest = t.TypeOf<typeof JettisonRequest>;
export const JettisonRequestComponent =
    new Component<JettisonRequest>('JettisonRequestComponent');

replicationPolicies.register(JettisonRequestComponent, {
    codec: JettisonRequest,
    authority: 'owning-client',
});

export const PlayerJettisonInputSystem = new System({
    name: 'PlayerJettisonInput',
    events: [ControlStateEvent],
    args: [
        ControlStateEvent,
        Optional(PlayerStateComponent),
        Optional(JettisonRequestComponent),
        PlatformResource,
        GetEntity,
        PlayerShipSelector,
    ] as const,
    step(controlState, playerState, request, platform, entity) {
        if (platform !== 'browser' || controlState.get('jettison') !== 'start') {
            return;
        }
        const hasCargo = playerState?.holds.some(h => !h.isMissionCargo && h.tons > 0);
        if (!hasCargo) {
            entity.components.set(BoardingNoticeComponent,
                { text: 'No standard cargo in holds to jettison.' });
            return;
        }
        entity.components.set(JettisonRequestComponent, {
            sequence: (request?.sequence ?? 0) + 1,
        });
        entity.components.set(BoardingNoticeComponent,
            { text: 'Jettisoned cargo canister.' });
    },
});

export const ServerJettisonSystem = new System({
    name: 'ServerJettisonSystem',
    args: [
        JettisonRequestComponent,
        PlayerStateComponent,
        MovementStateComponent,
        MultiplayerData,
        PlatformResource,
        Entities,
        EntityBudgetResource,
        UUID,
        GetEntity,
    ] as const,
    step(request, playerState, movement, multiplayer, platform, entities, budget, playerUuid, entity) {
        if (platform !== 'node' || multiplayer.owner === 'server') {
            return;
        }
        const hold = playerState.holds.find(h => !h.isMissionCargo && h.tons > 0);
        if (!hold) {
            entity.components.delete(JettisonRequestComponent);
            return;
        }

        const removed = releaseCargo(playerState, hold.commodity, 1);
        if (removed <= 0) {
            entity.components.delete(JettisonRequestComponent);
            return;
        }

        const backwards = movement.rotation.getUnitVector().scale(-45);
        const dropPos = new Position(
            movement.position.x + backwards.x,
            movement.position.y + backwards.y,
        );

        const ore = makeOre('nova:128', hold.commodity, removed, dropPos);
        ore.components.set(MultiplayerData, { owner: 'server' });
        if (reserveEntity(budget, ore, 'asteroid')) {
            entities.set(uuid(), ore);
        }

        entity.components.delete(JettisonRequestComponent);
    },
});

export const JettisonPlugin: Plugin = {
    name: 'JettisonPlugin',
    build(world) {
        world.addComponent(JettisonRequestComponent);
        const deltaMaker = world.resources.get(DeltaResource);
        if (deltaMaker) {
            deltaMaker.addComponent(JettisonRequestComponent, {
                componentType: JettisonRequest,
            });
        }
        world.addSystem(PlayerJettisonInputSystem);
        world.addSystem(ServerJettisonSystem);
    },
    remove(world) {
        world.removeSystem(PlayerJettisonInputSystem);
        world.removeSystem(ServerJettisonSystem);
    },
};
