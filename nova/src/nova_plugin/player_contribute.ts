import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { resourceId } from '../common/resource_id';
import { Bits64, playerContribute } from './contribute';
import type { OutfitsState } from './outfit_plugin';

export interface PlayerContributeInput {
    shipId: string | undefined;
    outfits: OutfitsState | undefined;
    /** Numeric ränk ids (PlayerState.activeRanks). */
    activeRanks?: readonly number[];
    /** Crön ids whose events are currently active (see activeCronIds). */
    activeCrons?: readonly (string | number)[];
}

interface ContributeGettable {
    get(id: string): Promise<{ contribute?: readonly number[] }>;
}

async function tryGet(
    gettable: ContributeGettable | undefined,
    id: string | number,
): Promise<{ contribute?: readonly number[] } | undefined> {
    if (!gettable) {
        return undefined;
    }
    try {
        return await gettable.get(resourceId(id));
    } catch {
        return undefined;
    }
}

/**
 * The player's combined Contribute (EV Nova Bible, mïsn/outf/shïp Require):
 * the OR of the current ship, every outfit held, every active ränk and every
 * active crön. Missing gettables or unknown ids contribute nothing.
 */
export async function loadPlayerContribute(
    gameData: GameDataInterface,
    input: PlayerContributeInput,
): Promise<Bits64> {
    const data = gameData.data as unknown as {
        Ship?: ContributeGettable;
        Outfit?: ContributeGettable;
        Rank?: ContributeGettable;
        Cron?: ContributeGettable;
    };
    const outfitEntries = [...(input.outfits ?? new Map()).entries()]
        .filter(([, value]) => (value?.count ?? 0) > 0);
    const [ship, outfits, ranks, crons] = await Promise.all([
        input.shipId ? tryGet(data.Ship, input.shipId) : undefined,
        Promise.all(outfitEntries.map(async ([id, value]) =>
            [await tryGet(data.Outfit, id), value.count] as const)),
        Promise.all((input.activeRanks ?? []).map(id => tryGet(data.Rank, id))),
        Promise.all((input.activeCrons ?? []).map(id => tryGet(data.Cron, id))),
    ]);
    return playerContribute({ ship, outfits, ranks, crons });
}
