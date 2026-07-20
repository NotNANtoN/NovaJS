import { Entity } from 'nova_ecs/entity';
import { getDefaultGameDate } from 'novadatainterface/player_start_data';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { addDays, dayNumber } from '../nova_plugin/calendar.js';
import { CargoComponent } from '../nova_plugin/cargo_plugin.js';
import { runCronsForDays } from '../nova_plugin/cron_logic.js';
import {
    MissionContext,
    MissionEvent,
    MissionMachineryContext,
    MissionWorkingState,
    processLanding,
    stellarInfoOf,
} from '../nova_plugin/mission_logic.js';
import { ControlBitsComponent } from '../nova_plugin/ncb_plugin.js';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin.js';
import {
    CreditsComponent,
    CronStatesComponent,
    GameDateComponent,
    MissionsComponent,
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
        public shipId: string) {
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
            activeMissions: this.state.missions,
            freeCargoSpace: this.state.cargoCapacity - cargoUsedTons,
            random: Math.random,
            getGovt: id => this.universe.getGovt(id),
            currentDay: this.currentDay,
            records: this.state.records,
            combatRating: this.entity.components
                .get(CombatRatingComponent)?.kills ?? 0,
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
        return new MissionSession(entity, universe, planetId,
            cargoCapacity, shipId);
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
 * Landing bookkeeping for the docked player entity: advances the date
 * by one day (landing takes a day in EV Nova), then processes every
 * active mission against this stellar — deadline failures, travel
 * legs, and completion with payment. Returns the events for the UI.
 */
export async function processEntityLanding(entity: Entity,
    gameData: SimulationGameDataInterface, universe: MissionUniverse,
    planetId: string): Promise<MissionEvent[]> {
    // A landing advances the player's calendar by one day (and runs
    // any crons that fire on it).
    await advanceEntityDate(entity, 1, universe);

    const session = await MissionSession.create(
        entity, gameData, universe, planetId);
    processLanding(session.machinery, planetId, session.currentDay,
        session.outfits);
    return session.commit();
}

/**
 * Advances the player's calendar by `days`, evaluating crön events
 * for each day passed. Runs player-locally while the entity is
 * outside the simulation (docked, or during the jump handoff); the
 * mutated components sync to peers with the re-added entity.
 */
export async function advanceEntityDate(entity: Entity, days: number,
    universe: MissionUniverse): Promise<void> {
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
        runCronsForDays(universe.crons, cronStates, bits,
            fromDay, fromDay + days);
        entity.components.set(ControlBitsComponent, bits);
        entity.components.set(CronStatesComponent, cronStates);
    } catch (e) {
        console.warn('Cron evaluation failed:', e);
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
