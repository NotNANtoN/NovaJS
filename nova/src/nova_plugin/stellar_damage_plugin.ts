/**
 * Multiplayer stellar destruction: the ROOM shares the fight, each PILOT owns
 * the outcome (see stellar_destruction.ts).
 *
 * Destroyable stellars (spöb Strength > 0) carry a server-held damage pool
 * that only planet-type weapons can reach (hit_types.ts). When it breaks,
 * every player who damaged it records the destruction in their own
 * PlayerState, the pool resets so everyone else keeps the stellar, and a
 * replicated counter lets every client play the ExplodType explosion.
 */
import { plainSnapshot } from 'nova_ecs/draft_snapshot';
import { Entities } from 'nova_ecs/arg_types';
import { Entity } from 'nova_ecs/entity';
import { EntityMap } from 'nova_ecs/entity_map';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { System } from 'nova_ecs/system';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { PlanetData } from 'novadatainterface/PlanetData';
import { hasPendingServerDestruction, noteServerMissionBits, noteServerStellarChanges } from './combat_resources';
import { DamagedEvent } from './damage_events';
import { HiredEscortComponent } from './escort_plugin';
import { GameDataResource } from './game_data_resource';
import { stellarDamageAmount } from './hit_types';
import { startPendingNcbMissions } from './mission_plugin';
import { applyGoalRecordingDelta } from './mission_ship_plugin';
import { queuePendingMissionStarts, takePendingMissionStarts } from './ncb_handlers';
import { NcbRuntime, NcbRuntimeResource } from './ncb_runtime';
import { resolveDamageSource } from './npc_hostility';
import { PlanetComponent, PlanetDataComponent } from './planet_plugin';
import { PlatformResource } from './platform_plugin';
import { decodePlayerState, isStellarDestroyed, PlayerState, PlayerStateComponent } from './player_state';
import { DestroyableStellar, recordStellarDestroyed } from './stellar_destruction';
import { StellarBlastCodec, StellarBlastComponent, StellarHealthComponent } from './stellar_blast';
import { sameResourceId } from '../common/resource_id';

export { StellarBlastComponent, StellarHealthComponent } from './stellar_blast';

function isPlayerShip(entity: Entity | undefined): boolean {
    const owner = entity?.components.get(MultiplayerData)?.owner;
    return Boolean(owner && owner !== 'server'
        && entity!.components.has(PlayerStateComponent));
}

/** The player ship credited for damage by `attacker` (itself or its hired escort's owner). */
export function creditedPilot(attacker: string | undefined,
    entities: EntityMap): string | undefined {
    if (!attacker) return undefined;
    const entity = entities.get(attacker);
    if (isPlayerShip(entity)) return attacker;
    const owner = entity?.components.get(HiredEscortComponent)?.ownerUuid;
    return owner && isPlayerShip(entities.get(owner)) ? owner : undefined;
}

function alreadyDestroyedFor(entities: EntityMap, pilot: string, planetId: string): boolean {
    const entity = entities.get(pilot);
    const state = entity?.components.get(PlayerStateComponent);
    const owner = entity?.components.get(MultiplayerData)?.owner;
    return Boolean(state && isStellarDestroyed(state, planetId))
        || Boolean(owner && hasPendingServerDestruction(owner, planetId));
}

function changedStellars(before: PlayerState, after: PlayerState) {
    const ids = new Set([...before.destroyedStellars, ...after.destroyedStellars,
        ...Object.keys(before.stellarRegen ?? {}), ...Object.keys(after.stellarRegen ?? {})]);
    const regenFor = (state: PlayerState, id: string) => Object.entries(state.stellarRegen ?? {})
        .find(([key]) => sameResourceId(key, id))?.[1];
    const destroyedIn = (state: PlayerState, id: string) =>
        state.destroyedStellars.some(entry => sameResourceId(entry, id));
    return [...ids].filter(id => destroyedIn(before, id) !== destroyedIn(after, id)
        || regenFor(before, id) !== regenFor(after, id))
        .map(id => ({ id, destroyed: destroyedIn(after, id), regenAt: regenFor(after, id) }));
}

function changedBits(before: PlayerState, after: PlayerState) {
    return after.missionBits.map((value, bit) => [bit, value] as const)
        .filter(([bit, value]) => (before.missionBits[bit] ?? false) !== value);
}

function noteServerChanges(entity: Entity, before: PlayerState, after: PlayerState) {
    const owner = entity.components.get(MultiplayerData)?.owner;
    if (!owner) return;
    noteServerMissionBits(owner, changedBits(before, after));
    noteServerStellarChanges(owner, changedStellars(before, after));
}

/** A detached deep copy: plainSnapshot returns non-draft values as-is. */
function decodedCopy(state: PlayerState): PlayerState | undefined {
    const decoded = decodePlayerState(JSON.parse(JSON.stringify(plainSnapshot(state))));
    return decoded._tag === 'Right' ? decoded.right : undefined;
}

/**
 * NCB `S` in OnDestroy starts missions, which needs mission data. Run it
 * detached from the step's drafts and write back only its delta.
 */
async function startQueuedMissions(gameData: GameDataInterface, entities: EntityMap,
    pilot: string, ids: number[]): Promise<void> {
    const live = entities.get(pilot)?.components.get(PlayerStateComponent);
    const before = live && decodedCopy(live);
    const working = live && decodedCopy(live);
    if (!before || !working) return;
    queuePendingMissionStarts(working, ids);
    await startPendingNcbMissions(gameData, working, {
        initialPlanetId: working.lastLandedPlanet ?? '',
        initialSystemId: working.currentSystem,
        currentSystemId: working.currentSystem,
    });
    const entity = entities.get(pilot);
    const current = entity?.components.get(PlayerStateComponent);
    if (!entity || !current) return;
    entity.components.set(PlayerStateComponent,
        applyGoalRecordingDelta(current, before, working));
    noteServerChanges(entity, before, working);
}

/**
 * Record a broken stellar in one pilot's PlayerState, synchronously within
 * the step: the state is copied, recorded, and set back as a fresh value so
 * no draft outlives the step. Returns whether the pilot newly destroyed it.
 */
export function recordPilotStellarDestruction(entities: EntityMap, pilot: string,
    planet: DestroyableStellar, gameData: GameDataInterface,
    ncbRuntime?: NcbRuntime): boolean {
    const entity = entities.get(pilot);
    const live = entity?.components.get(PlayerStateComponent);
    const before = live && decodedCopy(live);
    const working = live && decodedCopy(live);
    if (!entity || !before || !working) return false;
    const context = ncbRuntime?.setContext(entity, working)
        ?? { stellar: (id: string) => gameData.data.Planet.getCached(id) };
    if (!recordStellarDestroyed(working, planet, context)) return false;
    const queued = takePendingMissionStarts(working);
    entity.components.set(PlayerStateComponent, working);
    noteServerChanges(entity, before, working);
    if (queued.length > 0) {
        void startQueuedMissions(gameData, entities, pilot, queued).catch(error =>
            console.error(`Could not start OnDestroy missions for ${planet.id}`, error));
    }
    return true;
}

export const StellarDamageSystem = new System({
    name: 'StellarDamageSystem',
    events: [DamagedEvent],
    args: [DamagedEvent, PlanetComponent, StellarHealthComponent,
        StellarBlastComponent, Entities, PlatformResource, GameDataResource,
        Optional(PlanetDataComponent), Optional(NcbRuntimeResource)] as const,
    step({ damage, scale = 1, damager }, planet, health, blast, entities,
        platform, gameData, planetData, ncbRuntime) {
        if (platform !== 'node') {
            return;
        }
        const amount = stellarDamageAmount(damage, scale);
        if (amount <= 0) {
            return;
        }
        const pilot = creditedPilot(resolveDamageSource(damager, entities)?.attacker, entities);
        if (pilot && alreadyDestroyedFor(entities, pilot, planet.id)) {
            // Gone for this pilot; their shots do not touch the shared stellar.
            return;
        }
        if (pilot && !health.attackers.includes(pilot)) {
            health.attackers.push(pilot);
        }
        health.current -= amount;
        if (health.current > 0) {
            return;
        }
        const attackers = [...health.attackers];
        // The shared stellar survives for everyone who did not destroy it.
        health.current = health.max;
        health.attackers = [];
        blast.seq += 1;
        const data: DestroyableStellar = planetData
            ?? gameData.data.Planet.getCached(planet.id) as PlanetData | undefined
            ?? { id: planet.id };
        for (const attacker of attackers) {
            recordPilotStellarDestruction(entities, attacker, data, gameData, ncbRuntime);
        }
    },
});

export const StellarDamagePlugin: Plugin = {
    name: 'StellarDamagePlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        world.addComponent(StellarHealthComponent);
        world.addComponent(StellarBlastComponent);
        deltaMaker.addComponent(StellarBlastComponent, {
            componentType: StellarBlastCodec,
        });
        world.addSystem(StellarDamageSystem);
    },
    remove(world) {
        world.removeSystem(StellarDamageSystem);
    },
};
