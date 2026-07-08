import * as t from 'io-ts';
import { GetEntity, GetWorld } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { EcsEvent } from "nova_ecs/events";
import { CommunicatorResource } from "nova_ecs/plugins/multiplayer_plugin";
import { System } from "nova_ecs/system";
import { World } from "nova_ecs/world";
import { ControlState } from "./control_state_event.js";
import { ControlEvent } from "./controls_plugin.js";
import { PlayerShipSelector } from "./player_ship_plugin.js";

/**
 * Which peer steers this ship. Synced to every peer, so each peer can
 * apply every peer's control inputs to the right ship — the heart of
 * per-peer input application.
 */
export const ControlledByComponent =
    new Component<{ peerId: string }>('ControlledBy');
export const ControlledByType = t.type({ peerId: t.string });

/**
 * A controlled ship's held-control state. Per-ship (not a global
 * resource): every peer's ship has its own. Not synced — it develops
 * identically on every peer from the same input records.
 */
export const ShipControlStateComponent =
    new Component<ControlState>('ShipControlState');

/**
 * Emitted targeted at a ship when a peer's control events were just
 * applied to it. Edge-triggered systems (landing, target cycling,
 * weapon selection, jumping) listen for this instead of polling.
 */
export const ShipControlEvent = new EcsEvent<undefined>('ShipControlEvent');

/**
 * Applies a peer's control events to the ship it controls. With no
 * peerId (local play before a connection exists), falls back to the
 * PlayerShipSelector ship.
 */
export function applyControlEvents(world: World, peerId: string | undefined,
    events: ControlEvent[]) {
    let targetUuid: string | undefined;
    let targetEntity;
    for (const [uuid, entity] of world.entities) {
        if (peerId !== undefined) {
            if (entity.components.get(ControlledByComponent)?.peerId === peerId) {
                targetUuid = uuid;
                targetEntity = entity;
                break;
            }
        } else if (entity.components.has(PlayerShipSelector)) {
            targetUuid = uuid;
            targetEntity = entity;
            break;
        }
    }
    if (!targetEntity || targetUuid === undefined) {
        return;
    }

    let state = targetEntity.components.get(ShipControlStateComponent);
    if (!state) {
        state = new Map();
        targetEntity.components.set(ShipControlStateComponent, state);
    }
    // Prior edges have been seen: 'start'/'repeat' decay to plain held.
    for (const [action, value] of state) {
        if (value) {
            state.set(action, true);
        }
    }
    for (const { action, state: value } of events) {
        state.set(action, value);
    }
    world.emit(ShipControlEvent, undefined, [targetUuid]);
}

/**
 * Marks the local peer's ship with PlayerShipSelector, derived from
 * ControlledBy. Peer-local: not part of the shared deterministic state
 * (see PEER_LOCAL_COMPONENTS).
 */
export const SetControlledShipSystem = new System({
    name: 'SetControlledShipSystem',
    args: [ControlledByComponent, GetEntity, GetWorld] as const,
    step(controlledBy, entity, world) {
        const localPeer = world.resources.get(CommunicatorResource)?.uuid;
        if (!localPeer) {
            return;
        }
        const isLocal = controlledBy.peerId === localPeer;
        if (isLocal && !entity.components.has(PlayerShipSelector)) {
            entity.components.set(PlayerShipSelector, undefined);
        } else if (!isLocal && entity.components.has(PlayerShipSelector)) {
            entity.components.delete(PlayerShipSelector);
        }
    }
});

/**
 * Components that legitimately differ between peers (local UI markers).
 * Excluded when comparing worlds across peers.
 */
export const PEER_LOCAL_COMPONENTS = new Set([PlayerShipSelector.name]);
