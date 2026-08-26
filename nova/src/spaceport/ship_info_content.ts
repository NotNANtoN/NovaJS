import {
    cargoTons,
    formatGameDate,
    PlayerState,
} from '../nova_plugin/player_state';

/** One "Label: value" row of the pilot status pane. */
function row(label: string, value: string): string {
    return `${label}: ${value}`;
}

export function shipInfoFacts(
    state: PlayerState | undefined,
    shipTypeName: string | undefined,
    systemName: string | undefined,
): string {
    if (!state) {
        return 'Pilot information is not available.';
    }
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
    ].join('\n');
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
