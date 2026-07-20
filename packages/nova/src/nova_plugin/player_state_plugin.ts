import * as t from 'io-ts';
import { Component } from 'nova_ecs/component';
import { map } from 'nova_ecs/datatypes/map';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { ShipObjectiveType } from './mission_ship_state.js';

/**
 * Serializable per-player gameplay state: the game date, credits, and
 * mission/cron progress. Like the control bits (ncb_plugin.ts), these
 * live on the player's ship entity and follow the player across ship
 * trades and system jumps.
 *
 * Almost nothing inside the simulation reads or writes these
 * components: the date advances at jump/landing transitions and
 * missions change while docked, both of which happen player-locally
 * while the entity is outside the simulation world (the
 * spaceport/outfitter commit pattern). The one exception is the
 * ShipObjective inside an ActiveMission: mission special-ship goal
 * progress accrues from SHARED sim events (deaths, disables), so the
 * shared goal systems (mission_ship_plugin.ts) mutate it identically
 * on every peer. The components are serializer-registered so they
 * ride through rollback snapshots, wire snapshots, and multiplayer
 * sync unchanged.
 */

export const GameDateType = t.type({
    /** Day of the month, 1-31. */
    day: t.number,
    /** Month, 1-12. */
    month: t.number,
    year: t.number,
});
export type GameDateState = t.TypeOf<typeof GameDateType>;
export const GameDateComponent = new Component<GameDateState>('GameDate');

export const CreditsType = t.type({
    credits: t.number,
});
export type Credits = t.TypeOf<typeof CreditsType>;
export const CreditsComponent = new Component<Credits>('Credits');

/**
 * The runtime state of one accepted mission. Static data stays in
 * MissionData (fetched by id); this records only what the player has
 * done with it. Random choices (destination, cargo quantity) are
 * resolved at accept time and frozen here.
 */
export const ActiveMissionType = t.intersection([t.type({
    /** MissionData id, e.g. 'nova:128'. */
    id: t.string,
    /** Absolute day number (calendar.ts) when the mission was accepted. */
    acceptedDay: t.number,
    /** Planet id where the mission was accepted. */
    acceptedAt: t.string,
    /** Resolved travel destination planet id, or null for none. */
    travelPlanet: t.union([t.string, t.null]),
    /** Resolved return-for-payment planet id, or null for none. */
    returnPlanet: t.union([t.string, t.null]),
    /** Resolved cargo type (0-255), or -1 for none. */
    cargoType: t.number,
    /** Resolved cargo quantity in tons; 0 when no cargo. */
    cargoQty: t.number,
    /** Whether the mission cargo is currently aboard. */
    cargoLoaded: t.boolean,
    /** Whether the travel destination has been visited (and its cargo
     * pickup/drop-off performed). */
    travelDone: t.boolean,
    /** Absolute day number after which the mission fails, or null. */
    deadlineDay: t.union([t.number, t.null]),
}), t.partial({
    /**
     * Special-ship goal progress (mission_ship_state.ts). Absent for
     * missions without special ships. The shared sim's goal systems
     * mutate this identically on every peer.
     */
    shipObjective: ShipObjectiveType,
})]);
export type ActiveMission = t.TypeOf<typeof ActiveMissionType>;

/** EV Nova allows at most 16 concurrently active missions. */
export const MAX_ACTIVE_MISSIONS = 16;

/** Active missions keyed by mission id (a mission can't be active twice). */
export const MissionsType = map(t.string, ActiveMissionType);
export type Missions = t.TypeOf<typeof MissionsType>;
export const MissionsComponent = new Component<Missions>('Missions');

/**
 * Per-player crön progress. `nextEligible` throttles re-activation
 * (postHoldoff); `phaseStart` is the day the current phase began.
 */
export const CronStateType = t.type({
    /** 'idle' | 'pre' (activated, holding off) | 'active'. */
    phase: t.union([t.literal('idle'), t.literal('pre'), t.literal('active')]),
    /** Absolute day the current phase began. */
    phaseStart: t.number,
    /** First absolute day the cron may activate (again). */
    nextEligible: t.number,
});
export type CronState = t.TypeOf<typeof CronStateType>;

export const CronStatesType = map(t.string, CronStateType);
export type CronStates = t.TypeOf<typeof CronStatesType>;
export const CronStatesComponent = new Component<CronStates>('CronStates');

export const PlayerStatePlugin: Plugin = {
    name: 'PlayerStatePlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        deltaMaker.addComponent(GameDateComponent, {
            componentType: GameDateType,
        });
        deltaMaker.addComponent(CreditsComponent, {
            componentType: CreditsType,
        });
        deltaMaker.addComponent(MissionsComponent, {
            componentType: MissionsType,
        });
        deltaMaker.addComponent(CronStatesComponent, {
            componentType: CronStatesType,
        });
    }
};
