import { Entity } from 'nova_ecs/entity';
import { plainSnapshot } from 'nova_ecs/draft_snapshot';
import { GameData } from '../client/gamedata/GameData';
import {
    acceptMission,
    MissionDestinationOptions,
    ResolvedMissionDestinations,
    startPendingNcbMissions,
} from '../nova_plugin/mission_plugin';
import { evaluateTestExpression } from '../nova_plugin/ncb';
import { ncbTestContext } from '../nova_plugin/ncb_runtime';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin';
import { persLinkMissionFor, PersState } from '../nova_plugin/pers';
import {
    PersComponent,
    PersLinkAcceptedRequestComponent,
} from '../nova_plugin/pers_plugin';
import { PlayerStateComponent } from '../nova_plugin/player_state';
import { ShipDataComponent } from '../nova_plugin/ship_plugin';
import {
    ConcourseMissionOffer,
    getShipboardMissionOffers,
} from './mission_bbs';

/** The replicated përs identity of a hailed or boarded ship. */
export interface PersLinkInfo {
    persId: string;
    linkMission: string | null;
    flags: number;
    activeOn: string;
    state: PersState;
}

/** Plain copy of the ship's PersComponent (replicated to clients). */
export function persLinkInfo(ship: Entity | undefined): PersLinkInfo | undefined {
    const instance = plainSnapshot(ship?.components.get(PersComponent));
    if (!instance) {
        return undefined;
    }
    return {
        persId: instance.data.id,
        linkMission: instance.data.linkMission,
        flags: instance.data.flags,
        activeOn: instance.data.activeOn,
        state: instance.state ?? {},
    };
}

export interface PersLinkOffer {
    offer: ConcourseMissionOffer;
    destinationOptions: (resolved: ResolvedMissionDestinations) => MissionDestinationOptions;
}

/**
 * The përs ship's LinkMission offer for this interaction (mïsn AvailLoc 2),
 * after the përs gates (hail vs board, player ship type, ActiveOn, still
 * active) and the mission's own availability.
 */
export async function findPersLinkOffer(
    gameData: GameData,
    player: Entity,
    info: PersLinkInfo | undefined,
    via: 'hail' | 'board',
    shipUuid: string,
): Promise<PersLinkOffer | undefined> {
    if (!info) {
        return undefined;
    }
    const state = plainSnapshot(player.components.get(PlayerStateComponent));
    if (!state) {
        return undefined;
    }
    const outfits = plainSnapshot(player.components.get(OutfitsStateComponent));
    const missionId = persLinkMissionFor(
        { linkMission: info.linkMission, flags: info.flags, activeOn: info.activeOn },
        {
            via,
            playerAiType: player.components.get(ShipDataComponent)?.inherentAI,
            state: info.state,
            evaluateActiveOn: expression => evaluateTestExpression(
                expression, ncbTestContext(state, outfits)),
        });
    if (!missionId) {
        return undefined;
    }
    const { offers, destinationOptions } = await getShipboardMissionOffers(
        gameData, player, {
            missionId,
            seed: `${state.currentSystem}:${shipUuid}:${state.gameDate}`,
        });
    const offer = offers[0];
    return offer ? { offer, destinationOptions } : undefined;
}

/**
 * Tell the server the pilot accepted this ship's LinkMission so it applies
 * the përs side effects it owns (leave / deactivate).
 */
export function notifyPersLinkAccepted(
    player: Entity,
    shipUuid: string,
    missionId: string,
): void {
    // The server consumes (deletes) the request, so the previous sequence
    // may be gone; a clock-based floor keeps sequences strictly increasing.
    const previous = player.components.get(PersLinkAcceptedRequestComponent);
    player.components.set(PersLinkAcceptedRequestComponent, {
        target: shipUuid,
        missionId,
        sequence: Math.max((previous?.sequence ?? 0) + 1, Date.now()),
    });
}

/**
 * Accept a përs link offer on a copy of the pilot, start any NCB-queued
 * missions, then write the copy back and notify the server. Returns false
 * when the mission could not be accepted.
 */
export async function acceptPersLinkOffer(
    gameData: GameData,
    player: Entity,
    link: PersLinkOffer,
    shipUuid: string,
): Promise<boolean> {
    const state = structuredClone(
        plainSnapshot(player.components.get(PlayerStateComponent)));
    if (!state) {
        return false;
    }
    const options = link.destinationOptions(link.offer.resolved);
    if (!acceptMission(state, link.offer.mission, options)) {
        return false;
    }
    await startPendingNcbMissions(gameData, state, options);
    player.components.set(PlayerStateComponent, state);
    notifyPersLinkAccepted(player, shipUuid, link.offer.mission.id);
    return true;
}
