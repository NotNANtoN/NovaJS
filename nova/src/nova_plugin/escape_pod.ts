import { OutfitData } from 'novadatainterface/OutiftData';
import { ShipData } from 'novadatainterface/ShipData';
import { OutfitsState } from './outfit_plugin';
import { PersistentPlayerState } from './player_state';

export const BASIC_ESCAPE_POD_SHIP_ID = 'nova:128';

/**
 * The Bible reserves dësc 13999 as the "Message shown after the player uses
 * an escape pod." This is the unpadded text of retail resource 13999.
 */
export const ESCAPE_POD_RETAIL_MESSAGE =
    'After several weeks of sensory deprivation as you drift aimlessly in '
    + 'space, trying to stay sane in the tiny little cabin of your escape pod, '
    + 'a passing prospector picks up your distress beacon and is kind enough '
    + 'to come to your rescue.  You slowly make your way back to civilization, '
    + 'where you work several dreary odd jobs to scratch up enough money to '
    + 'buy a new ship and once again begin roaming the spaceways...';

/** STR# 2002, string 277, is retail's pilot-death wording. */
export function killedPilotMessage(pilotName: string): string {
    return `${pilotName} has been killed`;
}

export function findEscapePodOutfit(
    outfits: ReadonlyMap<string, { readonly count: number }>,
    getOutfit: (id: string) =>
        Pick<OutfitData, 'isEscapePod'> | undefined,
): string | undefined {
    for (const [id, state] of outfits) {
        if (state.count > 0 && getOutfit(id)?.isEscapePod) {
            return id;
        }
    }
    return undefined;
}

export interface EscapePodRecovery {
    readonly playerState: PersistentPlayerState;
    readonly outfits: OutfitsState;
}

/**
 * Return the persisted pilot and ship inventory after an escape-pod rescue.
 * Pilot history is copied unchanged; ship cargo, including mission cargo, is
 * gone. Zeroing mission cargo metadata prevents legacy-save migration from
 * recreating destroyed cargo on the next load.
 */
export function recoverPilotAfterEscapePod(
    state: PersistentPlayerState,
    basicHull: Pick<
        ShipData,
        'id' | 'cargoCapacity' | 'fuelCapacity' | 'outfits'
    >,
): EscapePodRecovery {
    return {
        playerState: {
            ...state,
            shipId: basicHull.id,
            cargoCapacity: basicHull.cargoCapacity,
            holds: [],
            fuel: basicHull.fuelCapacity,
            activeMissions: state.activeMissions.map(mission => mission.cargo
                ? {
                    ...mission,
                    cargo: {
                        ...mission.cargo,
                        quantity: 0,
                    },
                }
                : { ...mission }),
        },
        outfits: new Map(Object.entries(basicHull.outfits)
            .map(([id, count]) => [id, { count }])),
    };
}

export const PERS_ESCAPE_POD_FLAG = 0x0002;
export const GOVERNMENT_SUPPRESS_PERS_ESCAPE_POD_FLAG = 0x0100;

export type PersEscapePodDisposition = 'none' | 'launch' | 'suppress';

/**
 * Bible: "'pers' ships of this govt won't use escape pod, but will act as if
 * they did." Suppression hides the launch; it does not kill the persistent
 * pilot.
 */
export function persEscapePodDisposition(
    persFlags: number,
    governmentFlags: number,
): PersEscapePodDisposition {
    if (!(persFlags & PERS_ESCAPE_POD_FLAG)) {
        return 'none';
    }
    return governmentFlags & GOVERNMENT_SUPPRESS_PERS_ESCAPE_POD_FLAG
        ? 'suppress' : 'launch';
}
