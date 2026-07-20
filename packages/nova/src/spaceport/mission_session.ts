import { Entity } from 'nova_ecs/entity';
import { getDefaultGameDate } from 'novadatainterface/player_start_data';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { addDays, dayNumber } from '../nova_plugin/calendar.js';
import { CargoComponent } from '../nova_plugin/cargo_plugin.js';
import { runCronsForDays } from '../nova_plugin/cron_logic.js';
import {
    failExpiredMissions,
    MissionContext,
    MissionEvent,
    MissionMachineryContext,
    MissionWorkingState,
    processLanding,
    runMissionSetString,
    runPendingShipDone,
    stellarInfoOf,
} from '../nova_plugin/mission_logic.js';
import { ControlBitsComponent } from '../nova_plugin/ncb_plugin.js';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin.js';
import {
    CreditsComponent,
    CronStatesComponent,
    GameDateComponent,
    MissionsComponent,
    PendingMissionNoticesComponent,
} from '../nova_plugin/player_state_plugin.js';
import { CombatRatingComponent, LegalRecordsComponent } from '../nova_plugin/reputation_plugin.js';
import { ShipComponent, ShipPhysicsComponent } from '../nova_plugin/ship_plugin.js';
import { WeaponsStateComponent } from '../nova_plugin/weapons_state.js';
import { MissionUniverse } from './mission_universe.js';

/**
 * A player-local editing session over the mission-related components
 * of the (docked, out-of-simulation) player entity: working copies of
 * missions, cargo, credits, bits, and outfits, plus the machinery
 * context mission_logic.ts operates on. Commit writes the copies back
 * to the entity — the same pattern the outfitter uses.
 */
export class MissionSession {
    readonly state: MissionWorkingState;
    readonly outfits: Map<string, number>;
    readonly machinery: MissionMachineryContext;
    readonly currentDay: number;

    private constructor(private entity: Entity,
        private universe: MissionUniverse,
        public planetId: string,
        cargoCapacity: number,
        public shipId: string,
        private shipGovt: string | null,
        private playerContribute: bigint) {
        this.currentDay = dayNumber(
            entity.components.get(GameDateComponent) ?? getDefaultGameDate());

        this.state = {
            missions: new Map(entity.components.get(MissionsComponent) ?? []),
            cargo: new Map(entity.components.get(CargoComponent) ?? []),
            credits: {
                credits: entity.components.get(CreditsComponent)?.credits ?? 0,
            },
            bits: new Set(entity.components.get(ControlBitsComponent) ?? []),
            cargoCapacity,
            dateAdvance: 0,
            events: [],
            records: new Map(
                entity.components.get(LegalRecordsComponent) ?? []),
        };
        this.outfits = new Map([...entity.components.get(OutfitsStateComponent)
            ?? []].map(([id, { count }]) => [id, count]));

        const session = this;
        this.machinery = {
            state: this.state,
            getMission: id => universe.getMission(id),
            offerContext: () => session.offerContext(),
            // Player-local: only resulting state reaches the sim.
            random: Math.random,
            allGovts: () => universe.govts(),
        };
    }

    private offerContext(): MissionContext {
        const planet = this.universe.getPlanet(this.planetId);
        const cargoUsedTons = [...this.state.cargo.values()]
            .reduce((a, b) => a + b, 0);
        return {
            stellar: planet ? stellarInfoOf(planet) : {
                id: this.planetId, govt: null,
                uninhabited: false, canLand: true,
            },
            stellarCandidates: this.universe.stellarCandidates,
            bits: this.state.bits,
            shipId: this.shipId,
            shipGovt: this.shipGovt,
            activeMissions: this.state.missions,
            freeCargoSpace: this.state.cargoCapacity - cargoUsedTons,
            random: Math.random,
            getGovt: id => this.universe.getGovt(id),
            currentDay: this.currentDay,
            records: this.state.records,
            combatRating: this.entity.components
                .get(CombatRatingComponent)?.kills ?? 0,
            playerContribute: this.playerContribute,
            systems: this.universe.systemInfos,
            systemIdOfStellar: id => this.universe.systemIdOfPlanet(id),
        };
    }

    static async create(entity: Entity,
        gameData: SimulationGameDataInterface,
        universe: MissionUniverse, planetId: string):
        Promise<MissionSession> {
        await universe.load();
        const shipId = entity.components.get(ShipComponent)?.id ?? 'default';
        const cargoCapacity = await computeCargoCapacity(entity, gameData);
        // The ship's inherent gövt gates the AvailShipType ship-govt
        // ranges (2128+/3128+); missing ship data leaves it unrestricted.
        let shipGovt: string | null = null;
        try {
            shipGovt = (await gameData.data.Ship.get(shipId)).inherentGovt;
        } catch {
            // Unknown ship: the ship-govt ranges simply don't match.
        }
        // The ship + outfit Contribute mask gates the mïsn Require field.
        const playerContribute =
            await computePlayerContribute(entity, gameData);
        return new MissionSession(entity, universe, planetId,
            cargoCapacity, shipId, shipGovt, playerContribute);
    }

    /** Writes the working copies back onto the entity. */
    commit(): MissionEvent[] {
        const entity = this.entity;
        entity.components.set(MissionsComponent, this.state.missions);
        entity.components.set(CargoComponent, this.state.cargo);
        entity.components.set(CreditsComponent,
            { credits: this.state.credits.credits });
        entity.components.set(ControlBitsComponent, this.state.bits);
        if (this.state.records) {
            entity.components.set(LegalRecordsComponent, this.state.records);
        }

        const previousOutfits = entity.components.get(OutfitsStateComponent);
        const outfitsChanged = !previousOutfits
            || previousOutfits.size !== this.outfits.size
            || [...this.outfits].some(([id, count]) =>
                previousOutfits.get(id)?.count !== count);
        if (outfitsChanged) {
            entity.components.set(OutfitsStateComponent, new Map(
                [...this.outfits]
                    .filter(([, count]) => count > 0)
                    .map(([id, count]) => [id, { count }])));
            // Re-derived from the new outfits (see spaceport.ts).
            entity.components.delete(WeaponsStateComponent);
            entity.components.delete(ShipPhysicsComponent);
        }

        // DatePostInc effects.
        if (this.state.dateAdvance > 0) {
            const date = entity.components.get(GameDateComponent)
                ?? getDefaultGameDate();
            entity.components.set(GameDateComponent,
                addDays(date, this.state.dateAdvance));
        }
        return this.state.events;
    }

    /**
     * Runs a mission NCB set string (an outfit's OnPurchase/OnSell, say)
     * against this session's working state, with the mission operators
     * Sxxx/Axxx/Fxxx and outfit grants Gxxx/Dxxx all wired to the real
     * machinery. `missionPrefix` scopes numeric ids to the running
     * resource's plug-in. Call commit() afterwards to persist.
     */
    runMissionSet(expression: string, missionPrefix: string): void {
        runMissionSetString(this.machinery, expression, missionPrefix,
            this.outfits);
    }
}

/**
 * A ship's total cargo capacity in tons: the hull's freeCargo plus any
 * freeCargo granted by its outfits.
 */
export async function computeCargoCapacity(entity: Entity,
    gameData: SimulationGameDataInterface): Promise<number> {
    const shipId = entity.components.get(ShipComponent)?.id ?? 'default';
    let cargoCapacity = 0;
    try {
        const shipData = await gameData.data.Ship.get(shipId);
        cargoCapacity = shipData.physics.freeCargo;
        const outfitsState = entity.components.get(OutfitsStateComponent);
        if (outfitsState) {
            for (const [outfitId, { count }] of outfitsState) {
                const outfit = await gameData.data.Outfit.get(outfitId);
                cargoCapacity +=
                    (outfit.physics.freeCargo ?? 0) * count;
            }
        }
    } catch (e) {
        console.warn('Failed to compute cargo capacity:', e);
    }
    return Math.max(0, cargoCapacity);
}

/**
 * The player's combined Contribute mask: the ship's Contribute OR'd
 * with each owned outfit's Contribute (per the EVN Bible's shared
 * Contribute/Require mechanic). Used to gate crön Require. Contribute
 * fields are stored as hex strings; a malformed one is treated as 0.
 */
export async function computePlayerContribute(entity: Entity,
    gameData: SimulationGameDataInterface): Promise<bigint> {
    const parseMask = (hex: string | undefined): bigint => {
        try {
            return BigInt(hex ?? '0x0');
        } catch {
            return 0n;
        }
    };
    let contribute = 0n;
    try {
        const shipId = entity.components.get(ShipComponent)?.id ?? 'default';
        contribute = parseMask((await gameData.data.Ship.get(shipId))
            .contribute);
        const outfitsState = entity.components.get(OutfitsStateComponent);
        if (outfitsState) {
            for (const [outfitId, { count }] of outfitsState) {
                if (count > 0) {
                    contribute |= parseMask(
                        (await gameData.data.Outfit.get(outfitId)).contribute);
                }
            }
        }
    } catch (e) {
        console.warn('Failed to compute player contribute:', e);
    }
    return contribute;
}

/**
 * Landing bookkeeping for the docked player entity: advances the date
 * by one day (landing takes a day in EV Nova), then processes every
 * active mission against this stellar — deadline failures, travel
 * legs, and completion with payment. Returns the events for the UI,
 * including any notices queued from mid-flight failures (deadlines that
 * expired during jumps, sim-marked disable/destroy failures).
 */
export async function processEntityLanding(entity: Entity,
    gameData: SimulationGameDataInterface, universe: MissionUniverse,
    planetId: string): Promise<MissionEvent[]> {
    // A landing advances the player's calendar by one day (and runs
    // any crons that fire on it, and fails any now-expired missions).
    await advanceEntityDate(entity, 1, universe, gameData);

    // Notices queued while the player was in flight surface here first.
    const pending = drainPendingMissionNotices(entity);

    const session = await MissionSession.create(
        entity, gameData, universe, planetId);
    processLanding(session.machinery, planetId, session.currentDay,
        session.outfits);
    return [...pending, ...session.commit()];
}

/**
 * Removes and returns the mission notices queued on the entity from
 * mid-flight failures (see PendingMissionNoticesComponent).
 */
export function drainPendingMissionNotices(entity: Entity): MissionEvent[] {
    const pending = entity.components.get(PendingMissionNoticesComponent);
    if (!pending || pending.length === 0) {
        return [];
    }
    entity.components.set(PendingMissionNoticesComponent, []);
    return pending.map(notice => ({
        missionId: notice.missionId,
        missionName: notice.missionName,
        type: notice.type as MissionEvent['type'],
        text: notice.text,
        payment: notice.payment,
    }));
}

/**
 * Advances the player's calendar by `days`, evaluating crön events for
 * each day passed and — when `gameData` is supplied — failing any
 * mission whose deadline has now passed (or which the shared sim marked
 * failed), so an in-flight deadline fails the moment it expires rather
 * than waiting for the next landing. Failure notices are queued on the
 * entity (PendingMissionNoticesComponent) for the next spaceport
 * screen. Runs player-locally while the entity is outside the
 * simulation (docked, or during the jump handoff); the mutated
 * components sync to peers with the re-added entity.
 */
export async function advanceEntityDate(entity: Entity, days: number,
    universe: MissionUniverse,
    gameData?: SimulationGameDataInterface): Promise<void> {
    ensurePlayerStateComponents(entity);
    if (days <= 0) {
        return;
    }
    const date = entity.components.get(GameDateComponent)!;
    const fromDay = dayNumber(date);
    entity.components.set(GameDateComponent, addDays(date, days));

    try {
        await universe.load();
        const bits = new Set(entity.components.get(ControlBitsComponent)!);
        const cronStates =
            new Map(entity.components.get(CronStatesComponent)!);
        // The player's ship + outfit Contribute mask gates cron Require
        // (needs game data; without it crons see no contributions).
        const contribute = gameData
            ? await computePlayerContribute(entity, gameData)
            : 0n;
        runCronsForDays(universe.crons, cronStates, bits,
            fromDay, fromDay + days, Math.random, contribute);
        entity.components.set(ControlBitsComponent, bits);
        entity.components.set(CronStatesComponent, cronStates);
    } catch (e) {
        console.warn('Cron evaluation failed:', e);
    }

    // In-flight mission upkeep: fail now-expired / sim-flagged missions
    // and run OnShipDone for goals the sim just completed. Needs the game
    // data for set strings and reputation, so it's skipped for the bare
    // (gameData-less) callers.
    if (gameData) {
        try {
            await processInFlightMissions(entity, gameData, universe);
        } catch (e) {
            console.warn('In-flight mission evaluation failed:', e);
        }
    }
}

/**
 * In-flight mission upkeep at a date advance (jump or landing), before
 * any landing is processed:
 *  - fails missions whose deadline has passed or which the shared sim
 *    marked failed (running OnFailure), and
 *  - runs OnShipDone for missions whose ship goal the sim just completed
 *    (shipDonePending), so it fires at the first player-local
 *    opportunity rather than only at a landing.
 * Any resulting notices are queued for the next spaceport screen. A
 * no-op — skipping the session build — when nothing is due, so the
 * common date advance stays cheap.
 */
async function processInFlightMissions(entity: Entity,
    gameData: SimulationGameDataInterface,
    universe: MissionUniverse): Promise<void> {
    const missions = entity.components.get(MissionsComponent);
    if (!missions || missions.size === 0) {
        return;
    }
    const currentDay = dayNumber(
        entity.components.get(GameDateComponent) ?? getDefaultGameDate());
    const anyDue = [...missions.values()].some(active =>
        active.failed
        || (active.deadlineDay !== null && currentDay > active.deadlineDay)
        || active.shipObjective?.shipDonePending);
    if (!anyDue) {
        return;
    }
    const session = await MissionSession.create(
        entity, gameData, universe, '<in-flight>');
    // OnShipDone first: a goal that completed can influence a mission
    // that then fails (e.g. an OnShipDone that starts a timed follow-up).
    runPendingShipDone(session.machinery, session.outfits);
    failExpiredMissions(session.machinery, currentDay, session.outfits);
    const events = session.commit();
    if (events.length > 0) {
        const existing =
            entity.components.get(PendingMissionNoticesComponent) ?? [];
        entity.components.set(PendingMissionNoticesComponent,
            [...existing, ...events.map(e => ({
                missionId: e.missionId,
                missionName: e.missionName,
                type: e.type,
                text: e.text,
                payment: e.payment,
            }))]);
    }
}

/**
 * Gives the entity the player-state components missions rely on if it
 * doesn't have them yet (fresh pilots get theirs from the chär data
 * in browser.ts; this is the safety net for older saves).
 */
export function ensurePlayerStateComponents(entity: Entity): void {
    if (!entity.components.get(GameDateComponent)) {
        entity.components.set(GameDateComponent, getDefaultGameDate());
    }
    if (!entity.components.get(CreditsComponent)) {
        entity.components.set(CreditsComponent, { credits: 0 });
    }
    if (!entity.components.get(MissionsComponent)) {
        entity.components.set(MissionsComponent, new Map());
    }
    if (!entity.components.get(CargoComponent)) {
        entity.components.set(CargoComponent, new Map());
    }
    if (!entity.components.get(ControlBitsComponent)) {
        entity.components.set(ControlBitsComponent, new Set());
    }
    if (!entity.components.get(CronStatesComponent)) {
        entity.components.set(CronStatesComponent, new Map());
    }
    if (!entity.components.get(LegalRecordsComponent)) {
        entity.components.set(LegalRecordsComponent, new Map());
    }
    if (!entity.components.get(CombatRatingComponent)) {
        entity.components.set(CombatRatingComponent, { kills: 0 });
    }
}
