import { GovtData } from 'novadatainterface/govt_data';
import { MissionData } from 'novadatainterface/mission_data';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { FiringGroupComponent } from './firing_group.js';
import { auxShipsMatchSystem, SystemInfo } from './mission_ship_logic.js';
import { MissionShipComponent } from './mission_ship_plugin.js';
import { GOAL_CHASE_OFF, GOAL_ESCORT, shipsToSpawn } from './mission_ship_state.js';
import { FormationComponent, NpcComponent } from './npc_ai_plugin.js';
import {
    INITIAL_SPAWN_HALF_SIZE,
    jumpInState,
    makeNpcShip,
    pickWeighted,
} from './npc_spawn_plugin.js';
import { MissionsComponent } from './player_state_plugin.js';
import { TargetComponent } from './target_component.js';

/**
 * Builds the mission special/aux ships the owning player's client
 * must insert when its ship enters a system — the player-local half
 * of the multiplayer design documented in mission_ship_plugin.ts.
 *
 * Runs on the OWNER'S CLIENT, before the (docked or jumping) player
 * entity is re-inserted into the simulation: it clears the stale
 * `live` rosters ON THE PLAYER ENTITY (so the mutation rides the
 * player's own insertion record) and returns the fully-formed ship
 * entities for the caller to push through the same input-record
 * addEntity path as hired escorts. Plain randomness (dude table
 * picks, spawn placement) is fine here: the resulting entities are
 * baked into the records, so every peer sees identical ships.
 *
 * mïsn ShipStart placement:
 *  - 1 (jump in from hyperspace): jump-in kinematics at the system
 *    edge. The Bible's "short delay" is approximated by the travel
 *    time from the edge (a ships-jumping-in feel without a timer).
 *  - 0 (randomly in the system): scattered in the gameplay box.
 *  - 2 (randomly, cloaked): scattered; spawning pre-cloaked is a
 *    documented gap (NPCs don't manage cloaks yet).
 *  - -1..-16 (on a nav default): nav defaults aren't modeled;
 *    scattered (documented gap).
 *
 * mïsn ShipBehav:
 *  - 0 (always attack the player): spawns aggressed at the owner.
 *  - 1 (protect the player): flies in formation on the owner and
 *    shares the owner's firing group (like hired escorts). Escort-goal
 *    ships behave the same way.
 *  - 2 (destroy enemy stellars): planet bombardment isn't modeled;
 *    standard AI (documented gap).
 *
 * Goal ships other than chase-off targets never auto-depart (their
 * NPC departure timer is pushed past any session); chase-off targets
 * keep natural timers and flee behavior, since leaving is the point.
 */

/** Sim time (ms) that never arrives: suppresses NPC auto-departure.
 * A large finite number (not Infinity) so it survives JSON codecs. */
export const MISSION_SHIP_NO_DEPART_MS = 1e15;

/** What spawn building needs from the mission universe (implemented
 * by spaceport/mission_universe.ts; narrowed here so the sim-side
 * modules never depend on the spaceport). */
export interface MissionShipUniverse {
    getMission(id: string): MissionData | undefined;
    systemIdOfPlanet(planetId: string): string | undefined;
    getGovt(id: string): GovtData | undefined;
    getSystemInfo(systemId: string): SystemInfo | undefined;
}

function scatter(random: () => number): Position {
    return new Position(
        (random() * 2 - 1) * INITIAL_SPAWN_HALF_SIZE,
        (random() * 2 - 1) * INITIAL_SPAWN_HALF_SIZE);
}

interface SpawnContext {
    gameData: SimulationGameDataInterface;
    universe: MissionShipUniverse;
    ownerUuid: string;
    random(): number;
    /** Next free formation slot on the owner. */
    nextSlot: number;
}

/** Builds one mission ship from a dude draw; null if data is missing. */
async function buildShip(ctx: SpawnContext, missionId: string,
    dudeId: string, options: {
        aux: boolean,
        shipStart: number,
        behavior: number,
        goal: number,
        name?: string,
    }): Promise<Entity | null> {
    let dude, shipData;
    try {
        dude = await ctx.gameData.data.Dude.get(dudeId);
        const choice = pickWeighted(dude.ships, { next: ctx.random });
        if (!choice) {
            return null;
        }
        shipData = await ctx.gameData.data.Ship.get(choice.id);
    } catch (e) {
        console.warn(`Mission ship from düde ${dudeId} failed to load:`, e);
        return null;
    }

    const state = options.shipStart === 1
        ? jumpInState(shipData, { next: ctx.random })
        : {
            position: scatter(ctx.random),
            rotation: new Angle(ctx.random() * 2 * Math.PI),
            velocity: new Vector(0, 0),
        };
    const ship = makeNpcShip(shipData, dude.aiType, dude.govt,
        state.position, state.rotation, state.velocity);
    if (options.name) {
        ship.name = options.name;
    }
    ship.components.set(MissionShipComponent, {
        mission: missionId,
        owner: ctx.ownerUuid,
        ...(options.aux ? { aux: true } : {}),
    });
    if (options.aux) {
        return ship;
    }

    const npc = ship.components.get(NpcComponent);
    if (npc && options.goal !== GOAL_CHASE_OFF) {
        // Goal targets must stick around to be fought/observed.
        npc.departAt = MISSION_SHIP_NO_DEPART_MS;
    }
    if (options.behavior === 0 && npc) {
        // Always attack the player: spawn already aggressed.
        npc.aggressor = ctx.ownerUuid;
        ship.components.set(TargetComponent, { target: ctx.ownerUuid });
    } else if (options.behavior === 1 || options.goal === GOAL_ESCORT) {
        // Protect the player / escort cargo: formation on the owner,
        // sharing the owner's firing group (like hired escorts).
        ship.components.set(FormationComponent, {
            leader: ctx.ownerUuid,
            slot: ctx.nextSlot++,
        });
        ship.components.set(FiringGroupComponent,
            { group: ctx.ownerUuid });
    }
    return ship;
}

/**
 * Prepares the mission ships to insert alongside the player entering
 * `systemId`: clears stale rosters on the player entity's missions
 * (call BEFORE the player entity is encoded into its insertion
 * record) and builds the special/aux ships whose spawn triggers
 * match. `firstSlot` continues the owner's formation slot numbering
 * (after hired escorts).
 */
export async function buildMissionShipSpawns(playerEntity: Entity,
    ownerUuid: string, systemId: string,
    gameData: SimulationGameDataInterface, universe: MissionShipUniverse,
    firstSlot = 0, random: () => number = Math.random): Promise<Entity[]> {
    const missions = playerEntity.components.get(MissionsComponent);
    if (!missions || missions.size === 0) {
        return [];
    }
    const ctx: SpawnContext = {
        gameData, universe, ownerUuid, random, nextSlot: firstSlot,
    };
    const system = universe.getSystemInfo(systemId);
    const ships: Entity[] = [];

    for (const [missionId, active] of missions) {
        const mission = universe.getMission(missionId);
        const objective = active.shipObjective;
        if (objective) {
            // The previous system's ships are gone (the owner-absence
            // cleanup deleted them); forget their uuids so they are
            // not misread as departures.
            objective.live = new Map();
            if (objective.systemId === null
                || objective.systemId === systemId) {
                const names = mission?.shipNames ?? [];
                for (let i = shipsToSpawn(objective); i > 0; i--) {
                    const ship = await buildShip(ctx, missionId,
                        objective.dudeId, {
                        aux: false,
                        shipStart: objective.shipStart,
                        behavior: objective.behavior,
                        goal: objective.goal,
                        name: names.length > 0 ? names[
                            Math.floor(random() * names.length)] : undefined,
                    });
                    if (ship) {
                        ships.push(ship);
                    }
                }
            }
        }
        // Aux ships: pure atmosphere, membership-matched per system.
        // Flag 0x0010 (infinite aux ships) is not modeled beyond the
        // once-per-system-entry respawn that naturally happens here.
        if (mission && system && auxShipsMatchSystem(mission, active,
            system, id => universe.systemIdOfPlanet(id),
            id => universe.getGovt(id))) {
            for (let i = 0; i < mission.auxShipCount; i++) {
                const ship = await buildShip(ctx, missionId,
                    mission.auxShipDudeId!, {
                    aux: true,
                    shipStart: 1,
                    behavior: -1,
                    goal: -1,
                });
                if (ship) {
                    ships.push(ship);
                }
            }
        }
    }
    return ships;
}
