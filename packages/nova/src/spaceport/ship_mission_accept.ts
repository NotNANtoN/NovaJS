import { Entity } from 'nova_ecs/entity';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { CargoComponent } from '../nova_plugin/cargo_plugin.js';
import { AcceptedMission } from '../nova_plugin/mission_accept.js';
import { acceptOffer, MissionOffer } from '../nova_plugin/mission_logic.js';
import {
    ActiveMissionType, CreditsComponent,
    GameDateComponent, MissionsComponent,
} from '../nova_plugin/player_state_plugin.js';
import {
    ActiveRanksComponent, ControlBitsComponent,
} from '../nova_plugin/ncb_plugin.js';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin.js';
import {
    CombatRatingComponent, LegalRecordsComponent,
} from '../nova_plugin/reputation_plugin.js';
import { ShipComponent } from '../nova_plugin/ship_plugin.js';
import { MissionSession } from './mission_session.js';
import { MissionUniverse } from './mission_universe.js';

/**
 * ============================================================================
 * Turning an in-flight accept into an input record
 * ============================================================================
 *
 * The problem: `MissionSession` is the ONLY correct implementation of
 * "what does accepting this mission do" — it runs OnAccept's set string
 * with all its Sxxx/Axxx/Fxxx/Gxxx/Kxxx operators, applies reputation,
 * loads start-time cargo, advances the date, and handles auto-abort — and
 * it works by mutating an Entity and committing to it. In flight there is
 * no entity the client may commit to: the display's copy is a one-way
 * mirror the next simulation frame overwrites.
 *
 * The resolution, and the reason this file is short: run the real
 * machinery against a DETACHED COPY of the player's state, then DIFF the
 * copy against what we started with. The diff is the delta set the input
 * record carries (mission_accept.ts), so the sim applies exactly what the
 * docked path would have written — without this module having to know
 * what a set string can do. Anything a future set-string operator learns
 * to change is picked up for free, as long as it lands in one of the
 * components below.
 *
 * WHAT THE COPY MUST CARRY is everything MissionSession reads or writes,
 * which is enumerated once in `detachPlayerState`. A component missing
 * from that list would make the session see an empty value and diff to a
 * wrong delta, so it is written as an explicit list rather than a
 * best-effort clone.
 *
 * DETERMINISM. The rolls here (AvailRandom, destination choice, <SN>) are
 * plain `Math.random` on the owning client, exactly as the docked path
 * and `buildMissionShipSpawns` roll theirs — the RESULT is baked into the
 * record, so every peer applies the same numbers. Nothing in this file
 * runs inside the simulation.
 */

/** Everything MissionSession reads or writes on the player's entity. */
function detachPlayerState(player: Entity): Entity {
    const copy = new Entity(player.name);
    const ship = player.components.get(ShipComponent);
    if (ship) {
        copy.components.set(ShipComponent, { ...ship });
    }
    const date = player.components.get(GameDateComponent);
    if (date) {
        copy.components.set(GameDateComponent, { ...date });
    }
    const credits = player.components.get(CreditsComponent);
    copy.components.set(CreditsComponent,
        { credits: credits?.credits ?? 0 });
    const missions = player.components.get(MissionsComponent);
    copy.components.set(MissionsComponent, new Map(
        [...(missions ?? [])].map(([id, active]) => [id, { ...active }])));
    copy.components.set(CargoComponent,
        new Map(player.components.get(CargoComponent) ?? []));
    copy.components.set(ControlBitsComponent,
        new Set(player.components.get(ControlBitsComponent) ?? []));
    copy.components.set(ActiveRanksComponent,
        new Set(player.components.get(ActiveRanksComponent) ?? []));
    copy.components.set(LegalRecordsComponent,
        new Map(player.components.get(LegalRecordsComponent) ?? []));
    const rating = player.components.get(CombatRatingComponent);
    if (rating) {
        copy.components.set(CombatRatingComponent, { ...rating });
    }
    const outfits = player.components.get(OutfitsStateComponent);
    copy.components.set(OutfitsStateComponent, new Map(
        [...(outfits ?? [])].map(([id, state]) => [id, { ...state }])));
    return copy;
}

/** Signed differences between two count maps, dropping the zeroes. */
function diffCounts(before: ReadonlyMap<string, number>,
    after: ReadonlyMap<string, number>): [string, number][] {
    const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
    const deltas: [string, number][] = [];
    for (const key of keys) {
        const delta = (after.get(key) ?? 0) - (before.get(key) ?? 0);
        if (delta !== 0) {
            deltas.push([key, delta]);
        }
    }
    return deltas;
}

/** Members added to / removed from a set. */
function diffSet<T>(before: ReadonlySet<T>, after: ReadonlySet<T>):
    { added: T[], removed: T[] } {
    return {
        added: [...after].filter(x => !before.has(x)),
        removed: [...before].filter(x => !after.has(x)),
    };
}

/** The record, plus the texts the popup shows after accepting. */
export interface ShipMissionAccept {
    record: AcceptedMission;
    /** The mission as it ended up, for the briefing's substitutions. */
    active: ReturnType<typeof missionsAfter>;
}

function missionsAfter(copy: Entity, missionId: string) {
    return copy.components.get(MissionsComponent)?.get(missionId);
}

/**
 * Accepts `offer` against a detached copy of the player's state and
 * returns the input record that reproduces it in the simulation, or null
 * when the accept was refused (a full hold, the 16-mission cap).
 *
 * `player` is the DISPLAY world's mirror of the player's ship; it is read
 * and never written, so the mirror stays a mirror.
 */
export async function buildShipMissionAccept(player: Entity,
    offer: MissionOffer, gameData: SimulationGameDataInterface,
    universe: MissionUniverse, offeredBy: string | undefined,
    ships: { uuid: string, entity: unknown }[] = [],
): Promise<ShipMissionAccept | null> {
    const copy = detachPlayerState(player);
    // '<in-flight>' is the sentinel the existing in-flight mission upkeep
    // already uses (mission_session's processInFlightMissions); it makes
    // offerContext fall back to a neutral stellar.
    const session = await MissionSession.create(
        copy, gameData, universe, '<in-flight>');
    const before = detachPlayerState(copy);
    const result = acceptOffer(session.machinery, offer, session.outfits);
    if (!result.accepted) {
        return null;
    }
    session.commit();

    const creditsBefore = before.components.get(CreditsComponent)!.credits;
    const creditsAfter = copy.components.get(CreditsComponent)!.credits;
    const bits = diffSet(before.components.get(ControlBitsComponent)!,
        copy.components.get(ControlBitsComponent)!);
    const ranks = diffSet(before.components.get(ActiveRanksComponent)!,
        copy.components.get(ActiveRanksComponent)!);
    const cargo = diffCounts(before.components.get(CargoComponent)!,
        copy.components.get(CargoComponent)!);
    const outfitCounts = (entity: Entity) => new Map(
        [...(entity.components.get(OutfitsStateComponent) ?? [])]
            .map(([id, state]) => [id, state.count] as const));
    const outfits = diffCounts(outfitCounts(before), outfitCounts(copy));

    const active = missionsAfter(copy, offer.data.id);
    // An auto-abort mission never becomes active (mission_logic), so
    // there is no ActiveMission to carry — but its EFFECTS still are.
    // The sim's idempotence check keys on the mission id, so an
    // auto-abort record with no mission would apply its deltas every
    // time it replayed. Guard it out here rather than teaching the sim
    // about a mission shape it never sees.
    if (!active) {
        return null;
    }

    return {
        active,
        record: {
            missionId: offer.data.id,
            mission: ActiveMissionType.encode(active),
            ...(offeredBy ? { offeredBy } : {}),
            ...(creditsAfter !== creditsBefore
                ? { creditsDelta: creditsAfter - creditsBefore } : {}),
            ...(bits.added.length ? { bitsSet: bits.added } : {}),
            ...(bits.removed.length ? { bitsCleared: bits.removed } : {}),
            ...(ranks.added.length ? { ranksGranted: ranks.added } : {}),
            ...(ranks.removed.length ? { ranksRevoked: ranks.removed } : {}),
            ...(cargo.length ? { cargoDelta: cargo } : {}),
            ...(outfits.length ? { outfitsDelta: outfits } : {}),
            ...(ships.length ? { ships: ships as never } : {}),
        },
    };
}
