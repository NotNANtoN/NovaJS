import { loadPilotProfile, PilotProfile } from '../title/client_prefs.js';
import { rankConversationName } from '../nova_plugin/rank_logic.js';
import { MissionUniverse } from './mission_universe.js';

/**
 * The player-identity wildcard values (<PN>, <PNN>, <PSN>, <PST>, and the
 * rank tags <PRK>/<SRK>/<PSR>) for expandMissionText, from the active pilot
 * profile, the player's current hull, and their active ränks.
 *
 * The ship NAME follows the convention the title screen and the sigma
 * reference screenshot use ("Are you Matt, Captain of the Starbridge
 * 525?"): the hull's type name plus the pilot's stable ship number.
 */
export interface PlayerIdentitySubs {
    playerName?: string;
    playerNickname?: string;
    playerShipName?: string;
    playerShipType?: string;
    rankName?: string;
    rankShortName?: string;
}

export async function playerIdentitySubs(universe: MissionUniverse,
    shipId?: string,
    /** Profile override for tests; defaults to the stored pilot profile. */
    profileOverride?: PilotProfile,
    /** The player's active ränks, for <PRK>/<SRK>/<PSR>. */
    ranks?: Iterable<string>): Promise<PlayerIdentitySubs> {
    const profile = profileOverride ?? loadPilotProfile();
    const shipType = shipId
        ? await universe.shipTypeName(shipId) : undefined;
    const getRank = (id: string) => universe.getRank(id);
    return {
        playerName: profile?.name || undefined,
        playerNickname: profile?.nickname || undefined,
        playerShipName: shipType
            ? `${shipType} ${profile?.shipNumber ?? 1}` : undefined,
        playerShipType: shipType,
        rankName: rankConversationName(ranks, getRank, false),
        rankShortName: rankConversationName(ranks, getRank, true),
    };
}
