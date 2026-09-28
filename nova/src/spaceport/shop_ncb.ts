import { Entity } from 'nova_ecs/entity';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { ShipData } from 'novadatainterface/ShipData';
import { resourceId } from '../common/resource_id';
import {
    MissionDestinationOptions,
    startPendingNcbMissions,
} from '../nova_plugin/mission_plugin';
import {
    executeSetOperations,
    NcbOperation,
    parseSetExpression,
} from '../nova_plugin/ncb';
import {
    createNcbHandlers,
    NcbHandlerContext,
    NcbSetSource,
} from '../nova_plugin/ncb_handlers';
import {
    applyCombatReceipt,
    CombatShopResult,
    requestShipGrant,
} from '../nova_plugin/combat_resources';
import type { ShipGrantRequester } from '../nova_plugin/ncb_runtime';
import type { OutfitsState } from '../nova_plugin/outfit_plugin';
import { PlayerState, setCargoCapacity } from '../nova_plugin/player_state';
import { ShipComponent, ShipDataComponent } from '../nova_plugin/ship_plugin';

export interface ShopSetExpressionInput {
    gameData: GameDataInterface;
    state: PlayerState;
    expression: string | undefined;
    /**
     * The dialog's own outfit map. G/D/H act on it in place; it is also the
     * map missions started by S see.
     */
    outfits?: OutfitsState;
    /**
     * oütf OnPurchase/OnSell pass `{ kind: 'outfit', id }` so the server can
     * approve a C/E/H hull change. Ship OnPurchase/OnRetire pass none: the
     * purchase itself was already server-approved.
     */
    source?: NcbSetSource;
    /** The player's ship entity; hull changes also update its ship components. */
    entity?: Entity;
    /**
     * Asks the server to approve a C/E/H hull change from `source`. Defaults
     * to the HTTP combat ledger in a browser. The receipt is applied to
     * `state` (the dialog's copy, which it writes back), and a rejection
     * restores the previous hull.
     */
    requestShipGrant?: ShipGrantRequester;
    /** Called after a server receipt or rejection changed `state`. */
    onStateChanged?: () => void;
    destination?: Partial<MissionDestinationOptions>;
    logger?: (message: string) => void;
}

export interface ShopSetExpressionResult {
    /** Data for the hull the pilot flies after the expression, if it changed. */
    ship?: ShipData;
}

function shipChangeIds(operations: readonly NcbOperation[]): number[] {
    const ids: number[] = [];
    for (const operation of operations) {
        if (operation.type === 'changeShip') {
            ids.push(operation.id);
        } else if (operation.type === 'randomChoice') {
            for (const choice of operation.choices) {
                ids.push(...shipChangeIds(choice));
            }
        }
    }
    return ids;
}

/**
 * Run a shop's control-bit set expression (oütf OnPurchase/OnSell, shïp
 * OnPurchase/OnRetire) with the full NCB operator set, then start any
 * missions it queued with S.
 *
 * Hull defaults for C/E/H are loaded before the synchronous execution so the
 * dialog's outfit map is correct immediately; the runtime's own ship change
 * is asked only to swap the hull and request the server grant.
 */
export async function runShopSetExpression(
    input: ShopSetExpressionInput,
): Promise<ShopSetExpressionResult> {
    const { expression, state, gameData } = input;
    const logger = input.logger ?? (message => console.warn(message));
    if (!expression?.trim()) {
        return {};
    }
    let operations: NcbOperation[];
    try {
        operations = parseSetExpression(expression, { logger });
    } catch (error) {
        logger(`Could not parse set expression '${expression}': ${error}`);
        return {};
    }
    const ships = new Map<string, ShipData>();
    await Promise.all(shipChangeIds(operations).map(async id => {
        try {
            const ship = await gameData.data.Ship.get(resourceId(id));
            ships.set(ship.id, ship);
        } catch (error) {
            logger(`Could not load ship ${id} for '${expression}': ${error}`);
        }
    }));
    const shipDefaults = new Map<string, OutfitsState>([...ships].map(
        ([id, ship]) => [id, new Map(Object.entries(ship.outfits ?? {})
            .map(([outfitId, count]) => [outfitId, { count }]))]));

    const shipBefore = state.shipId;
    const context: NcbHandlerContext = {
        state,
        outfits: input.outfits,
        shipDefaults,
        source: input.source,
        logger,
    };
    try {
        executeSetOperations(operations, state.missionBits, {
            handlers: createNcbHandlers(context),
            logger,
        });
    } catch (error) {
        logger(`Could not execute set expression '${expression}': ${error}`);
    }

    let ship: ShipData | undefined;
    if (state.shipId !== shipBefore) {
        ship = ships.get(state.shipId);
        if (ship) {
            setCargoCapacity(state, ship.cargoCapacity);
            input.entity?.components.set(ShipComponent, { id: ship.id });
            input.entity?.components.set(ShipDataComponent, ship);
        }
        requestGrant(input, state.shipId, shipBefore, logger);
    }

    await startPendingNcbMissions(gameData, state, {
        initialPlanetId: input.destination?.initialPlanetId
            ?? state.lastLandedPlanet,
        initialSystemId: state.currentSystem,
        currentSystemId: state.currentSystem,
        ...input.destination,
        ncb: input.outfits ? { outfits: input.outfits } : undefined,
    });
    return { ship };
}

function defaultRequester(): ShipGrantRequester | undefined {
    return typeof window !== 'undefined' && typeof fetch === 'function'
        ? requestShipGrant : undefined;
}

/**
 * PlayerState.shipId is server-authoritative. Without a source (ship
 * OnPurchase/OnRetire run after an approved purchase) nothing is asked.
 */
function requestGrant(
    input: ShopSetExpressionInput,
    shipId: string,
    previousShip: string,
    logger: (message: string) => void,
): void {
    const request = input.requestShipGrant ?? defaultRequester();
    if (!request || !input.source) {
        return;
    }
    const { state, source } = input;
    void request(state, shipId, source, (result: CombatShopResult) => {
        applyCombatReceipt(state, result);
        input.onStateChanged?.();
    }).catch(error => {
        logger(`Server rejected ship grant ${shipId} from ${source.kind} `
            + `${source.id}: ${error}`);
        if (state.shipId === shipId) {
            state.shipId = previousShip;
            input.entity?.components.set(ShipComponent, { id: previousShip });
        }
        input.onStateChanged?.();
    });
}
