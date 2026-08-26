import { GovtData } from 'novadatainterface/GovtData';
import {
    cargoTons,
    formatGameDate,
    PlayerState,
} from '../nova_plugin/player_state';
import {
    COMBAT_RATING_LADDER,
    combatRating,
    isCriminal,
    LEGAL_STATUS_LADDER,
    legalStatus,
    recordFor,
} from '../nova_plugin/legal_record';

/** One "Label: value" row of the pilot status pane. */
function row(label: string, value: string): string {
    return `${label}: ${value}`;
}

/** The ladders come from the retail STR# lists when they are loaded. */
export interface StatusLadders {
    combat?: readonly string[];
    legal?: readonly string[];
}

export function shipInfoFacts(
    state: PlayerState | undefined,
    shipTypeName: string | undefined,
    systemName: string | undefined,
    ladders: StatusLadders = {},
): string {
    if (!state) {
        return 'Pilot information is not available.';
    }
    const kills = state.kills ?? 0;
    const rating = combatRating(
        kills, ladders.combat ?? COMBAT_RATING_LADDER);
    return [
        row('Pilot', state.pilotName ?? 'Captain'),
        row('Ship', state.shipName || 'Unnamed'),
        row('Type', shipTypeName ?? state.shipId),
        '',
        row('Credits', `${state.credits.toLocaleString()} cr`),
        row('Date', formatGameDate(state.gameDate)),
        row('System', systemName ?? state.currentSystem),
        '',
        row('Cargo', `${cargoTons(state)} of ${state.cargoCapacity} tons`),
        row('Landings', String(state.landingCount ?? 0)),
        row('Systems seen', String((state.exploredSystems ?? []).length)),
        '',
        row('Combat rating', rating),
        row('Ships destroyed', String(kills)),
    ].join('\n');
}

/**
 * The player's standing with every government that has an opinion. Retail
 * shows one line per government, worst standing first, so a pilot can see at
 * a glance whose space is now dangerous.
 */
export function shipInfoStanding(
    state: PlayerState | undefined,
    governments: ReadonlyMap<string, GovtData>,
    ladders: StatusLadders = {},
): string {
    const heading = 'Legal Record';
    const records = state?.legalRecords ?? {};
    const ladder = ladders.legal ?? LEGAL_STATUS_LADDER;
    const rows = Object.keys(records)
        .map(id => {
            const govt = governments.get(id);
            const record = recordFor(records, id, govt);
            return {
                name: govt?.mediumName || govt?.name || id,
                record,
                tolerance: govt?.crimeTolerance ?? 0,
            };
        })
        .filter(entry => entry.record !== 0)
        .sort((a, b) => a.record - b.record || a.name.localeCompare(b.name))
        .map(entry => {
            const status = legalStatus(entry.record, entry.tolerance, ladder);
            const hunted = isCriminal(entry.record, entry.tolerance)
                ? ' (hunted)' : '';
            return `${entry.name}: ${status}${hunted}`;
        });
    if (rows.length === 0) {
        return [heading, '', 'No government has an opinion of you.'].join('\n');
    }
    return [heading, '', ...rows].join('\n');
}

export function shipInfoOutfits(
    outfits: ReadonlyMap<string, { count: number }> | undefined,
    names: ReadonlyMap<string, string>,
): string {
    if (!outfits || outfits.size === 0) {
        return 'Outfits\n\nNone installed.';
    }
    const lines = [...outfits.entries()]
        .map(([id, held]) => {
            const name = names.get(id) ?? id;
            return held.count > 1 ? `${held.count}x ${name}` : name;
        })
        .sort((a, b) => a.localeCompare(b));
    return ['Outfits', '', ...lines].join('\n');
}

export function shipInfoCargo(state: PlayerState | undefined): string {
    if (!state) {
        return '';
    }
    const holds = (state.holds ?? []).filter(hold => hold.tons > 0);
    if (holds.length === 0) {
        return `Hold empty — ${state.cargoCapacity} tons free`;
    }
    return holds
        .map(hold => `${hold.tons}t ${hold.commodity}${
            hold.isMissionCargo ? ' (mission)' : ''}`)
        .join('   ');
}

export function shipInfoMissions(state: PlayerState | undefined): string {
    const active = (state?.activeMissions ?? [])
        .filter(entry => entry.state === 'active');
    if (active.length === 0) {
        return 'Missions\n\nNone active.';
    }
    return ['Missions', '', ...active.map(entry =>
        entry.missionData && typeof entry.missionData === 'object'
            && 'name' in entry.missionData
            ? String((entry.missionData as { name: unknown }).name)
            : entry.missionId)].join('\n');
}
