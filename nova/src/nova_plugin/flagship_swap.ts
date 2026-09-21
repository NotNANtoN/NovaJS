import { Entity } from 'nova_ecs/entity';
import { EscortContract, PlayerState, PlayerStateComponent } from './player_state';
import { ShipComponent } from './ship_plugin';
import { CombatAuthorityComponent } from './combat_resources';

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
