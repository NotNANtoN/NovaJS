import * as t from 'io-ts';
import { Component } from 'nova_ecs/component';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { EncodedEntity } from 'nova_ecs/plugins/serializer_plugin';

export const MAX_MISSION_BITS = 10_000;
export const EV_NOVA_START_YEAR = 1177;
export const EV_NOVA_START_MONTH = 10;
export const EV_NOVA_START_DAY = 18;

export const MAX_ACTIVE_MISSIONS = 16;

export const MissionState = t.union([
    t.literal('active'),
    t.literal('completed'),
    t.literal('failed'),
    t.literal('aborted'),
]);
export type MissionState = t.TypeOf<typeof MissionState>;

export const MissionCargo = t.intersection([
    t.type({
        type: t.number,
        quantity: t.number,
    }),
    t.partial({
        pickupDestination: t.string,
    }),
]);
export type MissionCargo = t.TypeOf<typeof MissionCargo>;

const ActiveMission = t.type({
    missionId: t.string,
    state: MissionState,
});
const ActiveMissionDetails = t.intersection([
    ActiveMission,
    t.partial({
        // Optional during decode to keep player files from phase one
        // backward-compatible. New missions always write both fields.
        destination: t.string,
        cargo: MissionCargo,
        acceptedDate: t.number,
    }),
]);
export type ActiveMission = t.TypeOf<typeof ActiveMissionDetails>;

/**
 * A boolean array is used instead of a Set so Immer can track changes and the
 * ECS serializer can send the component between client and server worlds.
 */
export const PlayerStateCodec = t.type({
    credits: t.number,
    missionBits: t.array(t.boolean),
    gameDate: t.number,
    activeMissions: t.array(ActiveMissionDetails),
    shipId: t.string,
    currentSystem: t.string,
});
export type PlayerState = t.TypeOf<typeof PlayerStateCodec>;

export const PlayerStateComponent =
    new Component<PlayerState>('PlayerStateComponent');
export const PlayerStateResource =
    new Resource<PlayerState>('PlayerStateResource');

/**
 * The server-only PlayerStore is provided through this resource without
 * making browser bundles import its Node fs implementation.
 */
export const PlayerStoreResource =
    new Resource<unknown>('PlayerStoreResource');

/**
 * Message sent by the server after the normal communicator UUID handshake.
 * All fields besides uuid are optional so older servers/clients remain
 * compatible with the existing communicator protocol.
 */
export const PlayerData = t.intersection([
    t.type({
        uuid: t.string,
    }),
    t.partial({
        system: t.string,
        playerState: PlayerStateCodec,
        ship: EncodedEntity,
    }),
]);
export type PlayerData = t.TypeOf<typeof PlayerData>;

export function createInitialPlayerState(): PlayerState {
    return {
        credits: 10_000,
        missionBits: new Array<boolean>(MAX_MISSION_BITS).fill(false),
        gameDate: 0,
        activeMissions: [],
        shipId: 'nova:128',
        currentSystem: 'nova:130',
    };
}

export function advanceGameDate(state: PlayerState, days = 1): number {
    if (!Number.isInteger(days) || days < 0) {
        throw new Error('Game date can only advance by a non-negative integer');
    }
    state.gameDate += days;
    return state.gameDate;
}

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_MS = 24 * 60 * 60 * 1000;
const START_DATE_MS = Date.UTC(
    EV_NOVA_START_YEAR, EV_NOVA_START_MONTH - 1, EV_NOVA_START_DAY);

export function formatGameDate(gameDate: number): string {
    if (!Number.isInteger(gameDate) || gameDate < 0) {
        throw new Error('Game date must be a non-negative integer');
    }
    const date = new Date(START_DATE_MS + gameDate * DAY_MS);
    return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} `
        + `${date.getUTCFullYear()} NC`;
}

export const PlayerStatePlugin: Plugin = {
    name: 'PlayerStatePlugin',
    build(world) {
        world.addComponent(PlayerStateComponent);
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        deltaMaker.addComponent(PlayerStateComponent, {
            componentType: PlayerStateCodec,
        });
    },
};

