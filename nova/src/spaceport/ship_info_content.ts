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
 * The player's standing wherever they have actually changed it.
 *
 * A crime spreads to a government's allies and enemies, so the record map ends
 * up holding an entry for nearly every government, most of them still sitting
 * at the InitialRecord they started from. Listing those says nothing, and
 * retail ships several distinct gövts sharing one medium name, so the same
 * "Federation: No Convictions" line would appear many times over. Only
 * standings the pilot has moved are shown, one line per name, worst first, so
 * the list stays inside its pane.
 */
export const SHIP_INFO_STANDING_LIMIT = 8;

export function shipInfoStanding(
    state: PlayerState | undefined,
    governments: ReadonlyMap<string, GovtData>,
    ladders: StatusLadders = {},
): string {
    const heading = 'Legal Record';
    const records = state?.legalRecords ?? {};
    const ladder = ladders.legal ?? LEGAL_STATUS_LADDER;
    const worstByName = new Map<string, {
        name: string;
        record: number;
        tolerance: number;
    }>();
    for (const id of Object.keys(records)) {
        const govt = governments.get(id);
        const record = recordFor(records, id, govt);
        if (record === (govt?.initialRecord ?? 0)) {
            continue;
        }
        const name = govt?.mediumName || govt?.name || id;
        const existing = worstByName.get(name);
        if (!existing || record < existing.record) {
            worstByName.set(name, {
                name,
                record,
                tolerance: govt?.crimeTolerance ?? 0,
            });
        }
    }
    const ranked = [...worstByName.values()]
        .sort((a, b) => a.record - b.record || a.name.localeCompare(b.name));
    const rows = ranked.slice(0, SHIP_INFO_STANDING_LIMIT).map(entry => {
        const status = legalStatus(entry.record, entry.tolerance, ladder);
        const hunted = isCriminal(entry.record, entry.tolerance)
            ? ' (hunted)' : '';
        return `${entry.name}: ${status}${hunted}`;
    });
    if (rows.length === 0) {
        return [heading, '', 'No government has an opinion of you.'].join('\n');
    }
    const hidden = ranked.length - rows.length;
    if (hidden > 0) {
        rows.push(`and ${hidden} more`);
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

/**
 * Name a hold's contents.
 *
 * Mission cargo is filed under the mission's own id, which is no use to a
 * pilot reading their hold. The mission says what it is carrying in its
 * CargoType, which the Bible describes as a "Specific cargo type" in the range
 * 0-255, and STR# 4000 "All Cargo" names those types in order.
 */
export function cargoHoldLabel(
    hold: { commodity: string; isMissionCargo?: boolean },
    missions: readonly { missionId: string; cargo?: { type: number } }[] = [],
    cargoNames: readonly string[] = [],
): string {
    if (!hold.isMissionCargo) {
        return hold.commodity;
    }
    const carried = missions.find(
        mission => mission.missionId === hold.commodity)?.cargo?.type;
    const named = carried === undefined || carried < 0
        ? undefined
        : cargoNames[carried];
    if (named) {
        return named;
    }
    // Some holds already carry a readable commodity. Only a resource or
    // procedural id, which always contains a colon, needs replacing.
    return hold.commodity.includes(':') ? 'mission cargo' : hold.commodity;
}

export function shipInfoCargo(
    state: PlayerState | undefined,
    cargoNames: readonly string[] = [],
): string {
    if (!state) {
        return '';
    }
    const holds = (state.holds ?? []).filter(hold => hold.tons > 0);
    if (holds.length === 0) {
        return `Hold empty — ${state.cargoCapacity} tons free`;
    }
    const missions = state.activeMissions ?? [];
    return holds
        .map(hold => `${hold.tons}t ${cargoHoldLabel(hold, missions, cargoNames)}${
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
