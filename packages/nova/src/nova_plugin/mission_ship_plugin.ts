import * as t from 'io-ts';
import { Entities, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { EntityMap } from 'nova_ecs/entity_map';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { TimeSystem } from 'nova_ecs/plugins/time_plugin';
import { System } from 'nova_ecs/system';
import { BoardedComponent } from './boarding_component.js';
import { CloakActiveComponent, CloakComponent, isTargetable } from './cloak_plugin.js';
import { DeathEvent } from './death_plugin.js';
import { DisabledComponent } from './disabled_component.js';
import { Missions, MissionsComponent } from './player_state_plugin.js';
import { DeathAISystem } from './npc_plugin.js';
import {
    registerShip,
    shipDeparted,
    shipDied,
    shipDisabled,
    shipObserved,
    shipBoarded,
    ShipObjective,
} from './mission_ship_state.js';

/**
 * ============================================================================
 * Mission special ships in the shared simulation
 * ============================================================================
 *
 * THE MULTIPLAYER DESIGN. A mission belongs to ONE player, but its
 * special ships live in the SHARED deterministic simulation that every
 * peer in the room computes. The split:
 *
 *  - SPAWNING is player-local intent, so it follows the established
 *    pattern for player-initiated sim mutations (hired escorts, the
 *    relaunched player ship): the OWNING player's client builds the
 *    fully-formed ship entities and inserts them through the
 *    input-record addEntity path when the trigger occurs — entering
 *    the mission's resolved ShipSyst (or lifting off into it). The
 *    entities are baked into the record, so the spawn is deterministic
 *    for every peer even though the owner rolled the dude table with
 *    plain randomness. See mission_ship_spawn.ts and browser.ts.
 *
 *  - Each mission ship is tagged with a MissionShipComponent
 *    { mission, owner } so every peer knows whose mission it serves.
 *
 *  - GOAL PROGRESS accrues from shared sim events (deaths, disables,
 *    proximity), evaluated by the systems below identically on every
 *    peer, into the ShipObjective inside the OWNER's MissionsComponent
 *    (which is serializer-registered per-player state riding on the
 *    owner's ship entity). No input records are needed for progress:
 *    determinism makes every peer agree on it.
 *
 *  - DESPAWN. Every mission-ending transition (complete / abort /
 *    fail) happens while the owner is docked — i.e. while the owner's
 *    entity is OUT of the simulation. So "delete mission ships whose
 *    owner is absent" subsumes despawn-on-mission-end, despawn when
 *    the owner jumps away (the ships are respawned by the owner's
 *    client in the next system when the mission calls for it), and
 *    despawn on disconnect. The owner's client clears the objective's
 *    `live` roster before re-inserting its ship (mission_ship_spawn),
 *    so stale uuids from a previous system are never mistaken for
 *    in-system departures.
 *
 * Ships that survive a completed goal linger until the mission ends
 * (see mission_ship_state.ts for the Bible reading).
 */

export const MissionShipType = t.intersection([t.type({
    /** The owning player's active mission id (e.g. 'nova:258'). */
    mission: t.string,
    /** Entity uuid of the owning player's ship. */
    owner: t.string,
}), t.partial({
    /** An AuxShip: mission atmosphere, not part of the goal. */
    aux: t.boolean,
})]);
export type MissionShip = t.TypeOf<typeof MissionShipType>;
export const MissionShipComponent =
    new Component<MissionShip>('MissionShipComponent');

/** How close the owner must get to observe a cloak-capable ship
 * (GOAL_OBSERVE); roughly "visible onscreen". Ships that cannot cloak
 * are observed by mere co-presence in the system, per the Bible. */
export const OBSERVE_RANGE = 1500;

/** The owner's ShipObjective for a mission ship, if everything about
 * it still exists. */
function objectiveOf(missionShip: MissionShip,
    entities: EntityMap): ShipObjective | undefined {
    if (missionShip.aux) {
        return undefined;
    }
    const owner = entities.get(missionShip.owner);
    const missions = owner?.components.get(MissionsComponent);
    return missions?.get(missionShip.mission)?.shipObjective;
}

/**
 * Tracks a mission ship in its owner's objective and evaluates the
 * per-ship conditions that come from co-existence in the sim:
 * registration, disabling, boarding, and observation.
 *
 * MISSION SHIPS ARE BOARDABLE, per the Bible, and two of its seven ship
 * goals are ABOUT boarding them: ShipGoal 2 is "Board them" and ShipGoal
 * 5 is "Rescue them (they start out disabled and stay that way until you
 * board them)". mïsn Flags 0x0001 confirms the mechanic from the other
 * side — "the mission will auto-abort after the special ship is boarded"
 * — and mïsn PickupMode 2 is "Pick up when boarding special ship". So
 * nothing here refuses a boarding; instead a boarding by the OWNER is
 * credited to the goal, closing the shipBoarded seam that
 * mission_ship_state.ts documents.
 *
 * `boarder === owner` is checked because the durable record names
 * whoever spent the hulk's one plunder, and that can be somebody else: a
 * rival player, or (in principle) an NPC pirate. Only the mission's own
 * player boarding it is progress. NPCs cannot in fact reach a mission
 * ship — gövt Flags 0x1000 plunders "non-mission" enemies only, and
 * npcPlunderEligible enforces that — but the goal must not depend on
 * that flag staying the way it is.
 *
 * GOAL_BOARD is still not OFFERED (mission_ship_state's goalSupported):
 * turning board missions on is a content decision, and the sibling
 * GOAL_RESCUE additionally needs the "spawns disabled and stays disabled"
 * mechanic. The evaluation half is now real and specced either way.
 */
const MissionShipTrackSystem = new System({
    name: 'MissionShipTrackSystem',
    args: [MissionShipComponent, UUID, MovementStateComponent,
        Optional(DisabledComponent), Optional(CloakComponent),
        Optional(CloakActiveComponent), Optional(BoardedComponent),
        Entities] as const,
    step(missionShip, uuid, movement, disabled, cloak, cloakActive, boarded,
        entities) {
        const objective = objectiveOf(missionShip, entities);
        if (!objective) {
            return;
        }
        registerShip(objective, uuid);
        if (disabled) {
            shipDisabled(objective, uuid);
        }
        if (boarded?.plundered && boarded.boarder === missionShip.owner) {
            shipBoarded(objective, uuid);
        }
        // Observation: no cloak capability = observed by co-presence
        // (the owner inserted us into their own system); cloak-capable
        // ships must be seen up close while visible.
        if (!cloak) {
            shipObserved(objective, uuid);
        } else if (isTargetable(cloakActive)) {
            const owner = entities.get(missionShip.owner)?.components
                .get(MovementStateComponent);
            if (owner && owner.position.subtract(movement.position)
                .lengthSquared <= OBSERVE_RANGE * OBSERVE_RANGE) {
                shipObserved(objective, uuid);
            }
        }
    },
    after: [TimeSystem],
});

/**
 * A mission ship died: goal bookkeeping (destroy/chase-off progress,
 * disable/escort failure). Must run before DeathAISystem deletes the
 * entity, or the departure sweep would misread the death as a
 * jump-out.
 */
const MissionShipDeathSystem = new System({
    name: 'MissionShipDeathSystem',
    events: [DeathEvent],
    args: [DeathEvent, MissionShipComponent, UUID, Entities] as const,
    step(_death, missionShip, uuid, entities) {
        const objective = objectiveOf(missionShip, entities);
        if (objective) {
            shipDied(objective, uuid);
        }
    },
    before: [DeathAISystem],
});

/**
 * Sweeps each owner's tracked rosters for ships that vanished without
 * a death — NPC jump-outs and flee-departures delete the entity — and
 * credits them as chased off where that's the goal.
 */
const MissionShipDepartureSystem = new System({
    name: 'MissionShipDepartureSystem',
    args: [MissionsComponent, Entities] as const,
    step(missions, entities) {
        for (const active of missions.values()) {
            const objective = active.shipObjective;
            if (!objective || objective.live.size === 0) {
                continue;
            }
            for (const uuid of [...objective.live.keys()]) {
                if (!entities.has(uuid)) {
                    shipDeparted(objective, uuid);
                }
            }
        }
    },
    after: [TimeSystem],
});

/**
 * Deletes mission ships whose owner is gone from the simulation or no
 * longer has the mission (see the despawn design in the module
 * comment).
 */
const MissionShipCleanupSystem = new System({
    name: 'MissionShipCleanupSystem',
    args: [MissionShipComponent, UUID, Entities] as const,
    step(missionShip, uuid, entities) {
        const owner = entities.get(missionShip.owner);
        const missions = owner?.components.get(MissionsComponent);
        if (!missions || !missions.has(missionShip.mission)) {
            entities.delete(uuid);
        }
    },
    after: [TimeSystem],
});

/**
 * Player-loss mission failure (mïsn Flags2 0x0004,
 * failIfPlayerDisabledOrDestroyed). The disabled and destroyed cases
 * are wired below off the shared DisabledComponent / DeathEvent. The
 * sibling mïsn Flags 0x0020 flag, failIfScanned, is NOT modeled: the
 * engine has no cargo-scan mechanic, so there is no scan event to fail
 * on. It stays a parsed-but-inert flag until scanning exists.
 *
 * Marks every active mission with the failIfPlayerDisabledOrDestroyed
 * flag as failed. The flag was frozen onto the ActiveMission at accept
 * time, so the sim never needs the mission game data. Returns whether
 * anything changed (so callers can avoid touching the component
 * needlessly). Idempotent: an already-failed mission stays failed.
 */
function failPlayerMissionsOnLoss(missions: Missions): boolean {
    let changed = false;
    for (const active of missions.values()) {
        if (active.failIfPlayerDisabledOrDestroyed && !active.failed) {
            active.failed = true;
            changed = true;
        }
    }
    return changed;
}

/**
 * Fails the owner's flagged missions when the owner's ship becomes
 * disabled (mïsn Flags2 0x0004). Runs on every peer identically off the
 * shared DisabledComponent; the actual OnFailure/notice happens at the
 * next landing (processLanding reads active.failed), matching how
 * special-ship goal failures surface.
 */
const MissionPlayerDisabledSystem = new System({
    name: 'MissionPlayerDisabledSystem',
    args: [MissionsComponent, DisabledComponent] as const,
    step(missions) {
        failPlayerMissionsOnLoss(missions);
    },
    after: [TimeSystem],
});

/**
 * Fails the owner's flagged missions when the owner's ship is destroyed
 * (mïsn Flags2 0x0004). Runs before DeathAISystem deletes the entity so
 * the mission state — which rides on that same entity — is still
 * mutable. (For players the ship isn't deleted; an escape pod respawns
 * it, carrying the now-failed missions to the next landing.)
 */
const MissionPlayerDeathSystem = new System({
    name: 'MissionPlayerDeathSystem',
    events: [DeathEvent],
    args: [DeathEvent, MissionsComponent] as const,
    step(_death, missions) {
        failPlayerMissionsOnLoss(missions);
    },
    before: [DeathAISystem],
});

export const MissionShipPlugin: Plugin = {
    name: 'MissionShipPlugin',
    build(world) {
        const serializer = world.resources.get(SerializerResource);
        serializer?.addComponent(MissionShipComponent, MissionShipType);
        world.addSystem(MissionShipTrackSystem);
        world.addSystem(MissionShipDeathSystem);
        world.addSystem(MissionShipDepartureSystem);
        world.addSystem(MissionShipCleanupSystem);
        world.addSystem(MissionPlayerDisabledSystem);
        world.addSystem(MissionPlayerDeathSystem);
    },
};
