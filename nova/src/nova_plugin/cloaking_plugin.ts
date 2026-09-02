import * as t from 'io-ts';
import { Emit, Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Entity } from 'nova_ecs/entity';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { replicationPolicies } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { System } from 'nova_ecs/system';
import { ControlStateEvent } from './control_state_event';
import { GameDataResource } from './game_data_resource';
import { OutfitsStateComponent } from './outfit_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { SoundEvent } from './sound_event';
import { WeaponsStateComponent } from './weapons_state';

export const CLOAK_TRANSITION_MS = 600;
export const CLOAKED_ALPHA = 0.12;

export const CloakStateCodec = t.type({
    cloaked: t.boolean,
    transitionStartedAt: t.number,
    alpha: t.number,
});
export type CloakState = t.TypeOf<typeof CloakStateCodec>;
export const CloakStateComponent = new Component<CloakState>('CloakStateComponent');

replicationPolicies.register(CloakStateComponent, {
    codec: CloakStateCodec,
    authority: 'entity-owner',
});

export const CloakDeviceComponent = new Component<{ canCloak: boolean }>('CloakDeviceComponent');

export function computeCloakAlpha(
    cloaked: boolean,
    startedAt: number,
    now: number,
    durationMs = CLOAK_TRANSITION_MS,
): number {
    const elapsed = Math.max(0, now - startedAt);
    const progress = Math.min(1, elapsed / durationMs);
    if (cloaked) {
        // Fading into cloak: 1.0 -> CLOAKED_ALPHA
        return 1.0 - progress * (1.0 - CLOAKED_ALPHA);
    } else {
        // Uncloaking: CLOAKED_ALPHA -> 1.0
        return CLOAKED_ALPHA + progress * (1.0 - CLOAKED_ALPHA);
    }
}

/**
 * Grants CloakDeviceComponent if the ship has any outfit with cloak capability.
 */
export const CloakDeviceProvider = new System({
    name: 'CloakDeviceProvider',
    args: [OutfitsStateComponent, GameDataResource, GetEntity] as const,
    step(outfits, gameData, entity) {
        let canCloak = false;
        for (const [id, { count }] of outfits) {
            if (count <= 0) continue;
            const outfitData = gameData.data.Outfit?.getCached(id);
            if (outfitData?.cloak) {
                canCloak = true;
                break;
            }
        }
        if (canCloak) {
            if (!entity.components.has(CloakDeviceComponent)) {
                entity.components.set(CloakDeviceComponent, { canCloak: true });
            }
        } else {
            entity.components.delete(CloakDeviceComponent);
        }
    },
});

/**
 * Handles player Cloak toggle (KeyC).
 */
export const PlayerCloakControlSystem = new System({
    name: 'PlayerCloakControlSystem',
    events: [ControlStateEvent],
    args: [
        ControlStateEvent,
        Optional(CloakDeviceComponent),
        Optional(CloakStateComponent),
        TimeResource,
        Emit,
        GetEntity,
        PlayerShipSelector,
    ] as const,
    step(controlState, device, cloakState, time, emit, entity) {
        if (controlState.get('cloak') !== 'start' || !device?.canCloak) {
            return;
        }

        const willCloak = !(cloakState?.cloaked ?? false);
        const newState: CloakState = {
            cloaked: willCloak,
            transitionStartedAt: time.time,
            alpha: willCloak ? 1.0 : CLOAKED_ALPHA,
        };
        entity.components.set(CloakStateComponent, newState);

        // Retail snd 381: Cloak On, snd 380: Cloak Off
        emit(SoundEvent, { id: willCloak ? 'nova:381' : 'nova:380' });
    },
});

/**
 * Automatically drops cloak when firing weapons.
 */
export const DecloakOnFireSystem = new System({
    name: 'DecloakOnFireSystem',
    args: [
        WeaponsStateComponent,
        Optional(CloakStateComponent),
        TimeResource,
        Emit,
        GetEntity,
    ] as const,
    step(weapons, cloakState, time, emit, entity) {
        if (!cloakState?.cloaked) {
            return;
        }
        let isFiring = false;
        for (const [, state] of weapons) {
            if (state.firing) {
                isFiring = true;
                break;
            }
        }
        if (isFiring) {
            cloakState.cloaked = false;
            cloakState.transitionStartedAt = time.time;
            entity.components.set(CloakStateComponent, cloakState);
            emit(SoundEvent, { id: 'nova:380' }); // Cloak Off
        }
    },
});

/**
 * Updates alpha over transition time.
 */
export const CloakAlphaSystem = new System({
    name: 'CloakAlphaSystem',
    args: [CloakStateComponent, TimeResource] as const,
    step(cloakState, time) {
        cloakState.alpha = computeCloakAlpha(
            cloakState.cloaked,
            cloakState.transitionStartedAt,
            time.time,
        );
    },
});

export const CloakingPlugin: Plugin = {
    name: 'CloakingPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected DeltaMaker to exist');
        }
        world.addComponent(CloakStateComponent);
        world.addComponent(CloakDeviceComponent);
        deltaMaker.addComponent(CloakStateComponent, {
            componentType: CloakStateCodec,
        });
        if (world.resources.has(GameDataResource)) {
            world.addSystem(CloakDeviceProvider);
        }
        world.addSystem(PlayerCloakControlSystem);
        world.addSystem(DecloakOnFireSystem);
        world.addSystem(CloakAlphaSystem);
    },
};
