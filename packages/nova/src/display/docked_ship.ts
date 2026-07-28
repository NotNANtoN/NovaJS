import { Entity } from 'nova_ecs/entity';
import { Resource } from 'nova_ecs/resource';

/**
 * A live snapshot of the docked player's spendable state, pushed by whichever
 * spaceport venue is open so the status bar tracks a transaction *before* it
 * commits back to the entity. Every field is optional: an unset field falls
 * back to the docked entity's own components (e.g. the Refuel button mutates
 * the entity directly, so it needs no override here).
 *
 * Where each field lives mid-transaction, by venue:
 *  - Trade center: working `TradeWorkingState` (cargo + credits + capacity),
 *    committed to the entity only on Done. Provides credits, cargo, capacity.
 *  - Outfitter: working `{ credits }` object (shared with its mission
 *    session), committed on Done. Provides credits.
 *  - Bar (gambling / hiring): the bar's `MissionSession.state.credits`
 *    working object, committed on Leave. Provides credits.
 *  - Refuel: mutates the entity's Credits/Fuel components in place, so it
 *    needs no override — the status bar reads them off the entity.
 */
export interface DockedLiveStatus {
    /** Working credit balance (trade center / outfitter / bar-gambling). */
    credits?: number;
    /** Working cargo hold (trade center). */
    cargo?: ReadonlyMap<string, number>;
    /** Working cargo capacity in tons, when an outfit changed it. */
    cargoCapacity?: number;
    /** Working fuel, for a venue that ever tracks it off-entity. */
    fuel?: { current: number; max: number };
}

/**
 * The player ship while docked. It is out of the display world (removed from
 * the simulation on landing), held by the spaceport menu, so the status bar's
 * draw systems — which normally resolve the in-world PlayerShipSelector
 * entity — read it from here instead. `liveStatus`, when set by the open
 * venue, overrides the entity's own components per-transaction.
 */
export class DockedShip {
    /** Set by the spaceport while a venue is open; cleared when it closes. */
    liveStatus?: () => DockedLiveStatus;
    constructor(public readonly entity: Entity) { }
}

/**
 * A mutable holder so the dock/launch systems can set and clear the docked
 * ship without creating or deleting the resource itself (it stays present for
 * the whole display world's life). `current` is undefined while in flight.
 */
export interface DockedShipHolder {
    current?: DockedShip;
}

export const DockedShipResource =
    new Resource<DockedShipHolder>('DockedShip');
