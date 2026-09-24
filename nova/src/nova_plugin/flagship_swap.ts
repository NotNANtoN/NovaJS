import { Entity } from 'nova_ecs/entity';
import { GetEntity } from 'nova_ecs/arg_types';
import { System } from 'nova_ecs/system';
import { Optional } from 'nova_ecs/optional';
import { Component } from 'nova_ecs/component';
import { EscortContract, PlayerState, PlayerStateComponent, setCargoCapacity } from './player_state';
import { ShipComponent, ShipDataComponent } from './ship_plugin';
import { CombatAuthorityComponent } from './combat_resources';
import { PlayerShipSelector } from './player_ship_plugin';
import { PlatformResource } from './platform_plugin';
import { GameDataResource } from './game_data_resource';

export interface FlagshipTransferResult {
    previousShipId: string;
    newShipId: string;
    newEscortContract: EscortContract;
}

/**
 * Atomically transfers the player's flagship to a new vessel hull.
 * Reassigns the previous flagship into the player's escort fleet,
 * updates the ECS ShipComponent, persists the new PlayerState, and
 * commits the server CombatAuthority if present.
 */
export function transferFlagship(
    playerState: PlayerState,
    entity: Entity,
    newShipId: string,
    playerUuid: string,
    maxEscorts = 6,
): FlagshipTransferResult {
    const previousShipId = playerState.shipId;
    playerState.shipId = newShipId;
    entity.components.set(ShipComponent, { id: newShipId });

    const newEscortContract: EscortContract = {
        id: `capture-${playerUuid}-${Date.now()}`,
        shipId: previousShipId,
        dailyPay: 10,
    };

    const currentEscorts = playerState.escorts ?? [];
    if (currentEscorts.length < maxEscorts) {
        playerState.escorts = [...currentEscorts, newEscortContract];
    }
    entity.components.set(PlayerStateComponent, playerState);

    const auth = entity.components.get(CombatAuthorityComponent);
    if (auth) {
        auth.balance.shipId = newShipId;
        auth.commit();
    }

    return {
        previousShipId,
        newShipId,
        newEscortContract,
    };
}

const HullRefreshComponent = new Component<{ id: string }>('HullRefresh');

/**
 * The server can hand a pilot a new hull mid-flight (commandeering a boarded
 * ship). Replicated component deltas are applied silently, so the providers
 * keyed on `Ship` (hull data, sprite, physics, outfits) would keep the old
 * hull until the entity is rebuilt on landing. Re-set the component once,
 * non-silently, whenever the loaded hull data no longer matches it.
 */
export const RefreshChangedHullSystem = new System({
    name: 'RefreshChangedHullSystem',
    args: [ShipComponent, Optional(ShipDataComponent),
        Optional(HullRefreshComponent), GetEntity] as const,
    step(ship, shipData, refreshed, entity) {
        if (!shipData || shipData.id === ship.id) {
            if (refreshed) entity.components.delete(HullRefreshComponent);
            return;
        }
        if (refreshed?.id === ship.id) return;
        entity.components.set(HullRefreshComponent, { id: ship.id });
        entity.components.set(ShipComponent, { id: ship.id });
    },
});

/**
 * The owner adopts a hull the server assigned through its PlayerState, and
 * keeps the pilot's cargo capacity in step with the hull being flown.
 */
export const AdoptServerHullSystem = new System({
    name: 'AdoptServerHullSystem',
    args: [PlayerShipSelector, PlayerStateComponent, ShipComponent,
        Optional(ShipDataComponent), PlatformResource, GameDataResource,
        GetEntity] as const,
    step(_player, state, ship, shipData, platform, gameData, entity) {
        if (platform !== 'browser' || !state.shipId) return;
        if (ship.id !== state.shipId) {
            entity.components.set(ShipComponent, { id: state.shipId });
            return;
        }
        const capacity = shipData?.id === state.shipId
            ? shipData.cargoCapacity
            : gameData.data.Ship.getCached?.(state.shipId)?.cargoCapacity;
        if (capacity !== undefined && state.cargoCapacity !== Math.floor(capacity)) {
            setCargoCapacity(state, capacity);
        }
    },
});
