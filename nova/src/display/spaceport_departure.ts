import { Entity } from 'nova_ecs/entity';
import { EncodedEntity } from 'nova_ecs/plugins/serializer_plugin';
import {
    PersistentPlayerState,
    PlayerStateComponent,
    PlayerStorePort,
} from '../nova_plugin/player_state';

/**
 * The landing snapshot is encoded before the spaceport opens, so it cannot
 * contain anything bought at the Outfitter or Shipyard. Refreshing the stored
 * ship on departure is what makes a purchase survive a reload; without it the
 * stored ship stays a landing behind.
 */
export async function persistDeparture(
    store: PlayerStorePort,
    token: string | undefined,
    ship: Entity,
    landingState: PersistentPlayerState | undefined,
    encode: (entity: Entity) => EncodedEntity,
): Promise<void> {
    if (!token) {
        return;
    }
    // A shipyard purchase replaces the entity, so its own state outranks the
    // state captured when the pilot landed.
    const state = ship.components.get(PlayerStateComponent) ?? landingState;
    if (!state) {
        return;
    }
    try {
        await store.save(token, state, encode(ship));
    } catch (error) {
        console.error('Departure ship save failed', error);
    }
}
