import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { Bits64 } from '../nova_plugin/contribute';
import { activeCronIds } from '../nova_plugin/cron_plugin';
import type { OutfitsState } from '../nova_plugin/outfit_plugin';
import { loadPlayerContribute } from '../nova_plugin/player_contribute';
import type { PlayerState } from '../nova_plugin/player_state';

/**
 * The player's Contribute from plain (already snapshotted) state. Callers
 * must pass plainSnapshot copies: this awaits game data, which lets the world
 * step and revoke component drafts.
 */
export function contributeForPlayer(
    gameData: GameDataInterface,
    state: Pick<PlayerState, 'shipId'> & Partial<Pick<PlayerState, 'activeRanks' | 'crons'>>,
    outfits: OutfitsState | undefined,
): Promise<Bits64> {
    return loadPlayerContribute(gameData, {
        shipId: state.shipId,
        outfits,
        activeRanks: state.activeRanks ?? [],
        activeCrons: activeCronIds({ crons: state.crons ?? [] }),
    });
}
