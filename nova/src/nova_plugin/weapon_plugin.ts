import { WeaponData, ammoOutfitIds } from 'novadatainterface/WeaponData';
import { Emit, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Entity } from 'nova_ecs/entity';
import { EcsEvent } from 'nova_ecs/events';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import {
    CommunicatorResource,
    InboundMultiplayerPhase,
    MultiplayerData,
    ServerClockOffsetResource,
} from 'nova_ecs/plugins/multiplayer_plugin';
import { Time, TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Provide } from 'nova_ecs/provide';
import { System } from 'nova_ecs/system';
import { mod } from '../util/mod';
import { ControlStateEvent } from './control_state_event';
import {
    FiredShot,
    WeaponEntries,
    WeaponEntry,
    WeaponLocalState,
    WeaponsComponent,
    WeaponsLocalState,
} from './fire_weapon_plugin';
import {
    FireIntent,
    FireIntentComponent,
    FireIntentShot,
    FireLog,
    FireLogComponent,
    FireSyncLocalState,
    FireSyncPlugin,
    getFireSyncLocalState,
    fireLogSequence,
    newFireLogsAfter,
    rememberSpawnedShot,
    loggedShotEntityId,
    makeFireLogShot,
    newShotsAfter,
    pushShot,
} from './fire_sync';
import { GameDataResource } from './game_data_resource';
import { PlatformResource } from './platform_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { WeaponsState, WeaponsStateComponent, WeaponState } from './weapons_state';
import { ArmorComponent } from './health_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { randomShotSeed } from './shot_rng';
import { OutfitsStateComponent } from './outfit_plugin';
import { FireCadence, FireCadenceShotContext } from './fire_cadence';
import { DisabledComponent, PlayerDeathComponent } from './death_plugin';
import { JumpStateComponent } from './jump_plugin';
import { ShipComponent, ShipDataComponent } from './ship_plugin';
import { canPay, withCost, CombatAuthority, CombatAuthorityComponent } from './combat_resources';
import { PlayerStateComponent } from './player_state';
import { SystemIdResource } from './system_id_resource';

// Keep payment data on the entity, not keyed by revocable Immer draft identity.
// Local cadence owns burst boundaries; replay and submunitions bypass this state.
export const WeaponBurstPaymentsComponent =
    new Component<Map<string, Set<number>>>('WeaponBurstPaymentsComponent');

const NpcWeaponFuelComponent = new Component<{ current: number }>('NpcWeaponFuel');
const PlayerBurstPaymentsComponent = new Component<Map<string, { token: number; copies: Set<number> }>>('PlayerBurstPayments');

function fireWithCost(
    entity: Entity,
    weapon: WeaponData,
    platform: 'node' | 'browser',
    owner: string,
    fire: () => FiredShot | undefined,
    paidCopies?: Set<number>,
    copy = 0,
): FiredShot | undefined {
    if (weapon.ammoType === 'unlimited') {
        return fire();
    }
    // Prediction/replay never changes authoritative resource balances.
    if (platform !== 'node' || owner !== 'server') return fire();
    if (paidCopies?.has(copy)) return fire();
    if (weapon.ammoType[0] === 'energy') {
        const cost = weapon.ammoType[1];
        const state = entity.components.get(PlayerStateComponent);
        let tank = entity.components.get(NpcWeaponFuelComponent);
        if (!tank) {
            tank = { current: state?.fuel ?? entity.components.get(ShipDataComponent)?.fuelCapacity ?? 0 };
            entity.components.set(NpcWeaponFuelComponent, tank);
        }
        const fuel = state?.fuel ?? tank.current;
        if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(fuel) || fuel < cost) return undefined;
        const fired = fire();
        if (fired) {
            tank.current = fuel - cost;
            if (state) state.fuel = tank.current;
            paidCopies?.add(copy);
        }
        return fired;
    }
    const outfits = entity.components.get(OutfitsStateComponent);
    const ammoId = ammoOutfitIds(weapon.ammoType).find(id => {
        const count = outfits?.get(id)?.count;
        return Number.isSafeInteger(count) && count! >= 1;
    });
    const ammo = ammoId === undefined ? undefined : outfits?.get(ammoId);
    if (ammoId === undefined || !outfits || !ammo || !Number.isSafeInteger(ammo.count)
        || ammo.count < 1) {
        return undefined;
    }
    const fired = fire();
    if (fired) {
        outfits.set(ammoId, { ...ammo, count: ammo.count - 1 });
        entity.components.set(OutfitsStateComponent, outfits);
        paidCopies?.add(copy);
    }
    return fired;
}

/**
 * Avoid an accidental large projectile burst after a stalled tab or server.
 * Simultaneous weapons still fire a complete salvo, so the limit is approximate
 * when a single salvo contains more than this many projectiles.
 */
export const MAX_WEAPON_PROJECTILES_PER_STEP = 16;

export function worldOwnsWeaponCadence(
    platform: 'node' | 'browser',
    owner: string,
    communicatorUuid: string | undefined,
): boolean {
    return platform === 'node'
        ? owner === 'server'
        : communicatorUuid !== undefined && owner === communicatorUuid;
}

function recordOwnedShot(
    entity: Entity,
    platform: 'node' | 'browser',
    weaponId: string,
    seed: number,
    exitIndex: number,
    fired: FiredShot,
    time: Time,
    sync: FireSyncLocalState,
    intent: FireIntent | undefined,
    log: FireLog | undefined,
): { intent: FireIntent | undefined, log: FireLog | undefined } {
    const seq = sync.nextSeq++;
    rememberSpawnedShot(sync, seq, platform === 'browser');
    const event: FireIntentShot = { seq, weaponId, seed, exitIndex };
    if (fired.target !== undefined) {
        event.target = fired.target;
    }
    if (platform === 'browser') {
        if (intent) {
            pushShot(intent.shots, event);
            entity.components.set(FireIntentComponent, intent);
        } else {
            intent = { shots: [event] };
            entity.components.set(FireIntentComponent, intent);
        }
    } else {
        const logged = makeFireLogShot(
            event, time.time, fired.position, fired.rotation, {
                logSeq: sync.nextLogSeq++,
                sourceVelocity: fired.sourceVelocity,
                target: fired.target,
                inaccuracy: fired.inaccuracy,
            });
        if (log) {
            pushShot(log.shots, logged);
            entity.components.set(FireLogComponent, log);
        } else {
            log = { shots: [logged] };
            entity.components.set(FireLogComponent, log);
        }
    }
    return { intent, log };
}

function fireEventEntityId(
    weapon: { syncAsFireEvent: boolean },
    source: string,
    seq: number,
): { entityId: string } | undefined {
    if (weapon.syncAsFireEvent === false) {
        return undefined;
    }
    return { entityId: loggedShotEntityId(source, seq) };
}

export function clearWeaponFiringState(
    weaponsState: WeaponsState,
    weaponsLocalState: WeaponsLocalState,
): void {
    for (const [id, state] of weaponsState) {
        state.firing = false;
        const localState = weaponsLocalState.get(id);
        localState.shotsOwed = 0;
        localState.burstCount = 0;
        localState.reloadingBurst = false;
        localState.wasFiring = false;
        localState.pressObserved = false;
        localState.releaseAfterStep = false;
    }
}

function getWeaponCount(state: WeaponState) {
    return Math.max(0, Math.floor(state.count));
}

function getBurstLimit(weapon: WeaponData, count: number) {
    if (weapon.burstCount <= 0) {
        return Infinity;
    }

    // A simultaneous firing opportunity is one salvo. Otherwise, every
    // installed copy contributes its own shot to the burst.
    return weapon.burstCount * (weapon.fireSimultaneously ? 1 : count);
}

function addShotsOwed(weapon: WeaponData, state: WeaponState,
    localState: WeaponLocalState, time: Time, reloadingBurst: boolean,
    maxFireCalls: number) {
    const count = getWeaponCount(state);
    const reloadTime = reloadingBurst ? weapon.burstReload : weapon.reload;
    const callsPerReload = reloadingBurst || weapon.fireSimultaneously ? 1 : count;
    const deltaMs = Math.max(0, time.delta_ms);
    const added = reloadTime > 0
        ? callsPerReload * deltaMs / reloadTime
        : maxFireCalls;

    // While the trigger is released, retain at most one ready shot. This
    // preserves the old cooldown behavior without accumulating a backlog that
    // fires all at once when the trigger is pressed again.
    const maxOwed = state.firing
        || weapon.guidance === 'pointDefense'
        || weapon.guidance === 'pointDefenseBeam'
        ? maxFireCalls : 1;
    localState.shotsOwed = Math.min(maxOwed,
        Math.max(0, localState.shotsOwed ?? 1) + added);
}

export const WeaponsSystem = new System({
    name: 'WeaponsSystem',
    after: [InboundMultiplayerPhase],
    args: [WeaponsStateComponent, WeaponsComponent,
        TimeResource, UUID, WeaponEntries,
        Optional(DestructionStartedComponent),
        Optional(ArmorComponent), MultiplayerData, PlatformResource,
        // Only the client worlds have a communicator; the server world and the
        // single-player world run without one.
        Optional(CommunicatorResource), GetEntity,
        Optional(FireIntentComponent), Optional(FireLogComponent)] as const,
    step(weaponsState, weaponsLocalState, time, uuid, weaponEntries,
        destructionStarted, armor, multiplayer, platform, communicator, entity,
        intent, log) {
        if (!worldOwnsWeaponCadence(
            platform, multiplayer.owner, communicator?.uuid)) {
            return;
        }
        if (destructionStarted !== undefined || armor && armor.current <= 0) {
            clearWeaponFiringState(weaponsState, weaponsLocalState);
            return;
        }
        const sync = getFireSyncLocalState(entity, intent, log);
        for (const [id, state] of weaponsState) {
            const localState = weaponsLocalState.get(id);
            if (state.firing) {
                localState.pressObserved = true;
            }

            const weapon = weaponEntries.getCached(id);
            if (!weapon) {
                continue;
            }

            const count = getWeaponCount(state);
            if (count === 0) {
                continue;
            }

            const shouldFire = state.firing
                || weapon.data.guidance === 'pointDefense'
                || weapon.data.guidance === 'pointDefenseBeam';
            const burstLimit = getBurstLimit(weapon.data, count);
            const reloadingBurst = burstLimit !== Infinity
                && localState.burstCount >= burstLimit;
            localState.reloadingBurst = reloadingBurst;

            // For independent copies, count/reload is the firing rate. A
            // simultaneous weapon instead produces one count-sized salvo at
            // each reload interval.
            const maxFireCalls = weapon.data.fireSimultaneously
                ? Math.max(1, Math.floor(
                    MAX_WEAPON_PROJECTILES_PER_STEP / count))
                : MAX_WEAPON_PROJECTILES_PER_STEP;
            addShotsOwed(weapon.data, state, localState, time,
                reloadingBurst, maxFireCalls);

            if (!shouldFire) {
                continue;
            }

            // A burst reload completes as soon as one firing opportunity is
            // owed. Any owed calls after that point belong to the new burst.
            if (reloadingBurst && (localState.shotsOwed ?? 0) >= 1) {
                localState.burstCount = 0;
                localState.reloadingBurst = false;
            }

            let shotsToFire = Math.min(
                Math.floor(localState.shotsOwed ?? 0), maxFireCalls);
            if (burstLimit !== Infinity && !localState.reloadingBurst) {
                shotsToFire = Math.min(shotsToFire,
                    burstLimit - localState.burstCount);
            }

            let firedCalls = 0;
            let fireUnavailable = false;
            for (let i = 0; i < shotsToFire; i++) {
                let fired = false;
                let paidCopies: Set<number> | undefined;
                if (platform === 'node' && multiplayer.owner === 'server'
                    && weapon.data.ammoType !== 'unlimited'
                    && 'oneAmmoPerBurst' in weapon.data
                    && weapon.data.oneAmmoPerBurst && weapon.data.burstCount > 0) {
                    let payments = entity.components.get(WeaponBurstPaymentsComponent);
                    if (!payments) {
                        payments = new Map();
                        entity.components.set(WeaponBurstPaymentsComponent, payments);
                    }
                    if (localState.burstCount === 0 || !payments.has(id)) {
                        payments.set(id, new Set());
                    }
                    paidCopies = payments.get(id);
                }
                if (weapon.data.fireSimultaneously) {
                    for (let copy = 0; copy < count; copy++) {
                        const seed = randomShotSeed();
                        const shot = fireWithCost(entity, weapon.data,
                            platform, multiplayer.owner,
                            () => weapon.fireFromEntityDetailed(
                                uuid, seed, true, undefined,
                                fireEventEntityId(weapon, uuid, sync.nextSeq),
                            ), paidCopies, copy);
                        fired = shot !== undefined || fired;
                        if (shot && weapon.syncAsFireEvent !== false) {
                            ({ intent, log } = recordOwnedShot(
                                entity, platform, id, seed,
                                localState.exitIndex, shot, time,
                                sync, intent, log));
                        }
                    }
                } else {
                    const seed = randomShotSeed();
                    const shot = fireWithCost(entity, weapon.data,
                        platform, multiplayer.owner,
                        () => weapon.fireFromEntityDetailed(
                            uuid, seed, true, undefined,
                            fireEventEntityId(weapon, uuid, sync.nextSeq),
                        ), paidCopies, localState.burstCount % count);
                    fired = shot !== undefined;
                    if (shot && weapon.syncAsFireEvent !== false) {
                        ({ intent, log } = recordOwnedShot(
                            entity, platform, id, seed,
                            localState.exitIndex, shot, time,
                            sync, intent, log));
                    }
                }

                // Guidance can make a weapon unavailable (for example, a
                // turret without a target). Keep the owed shot for a later
                // step rather than treating it as fired.
                if (!fired) {
                    fireUnavailable = true;
                    break;
                }

                firedCalls++;
                if (weapon.data.burstCount) {
                    localState.burstCount++;
                }
            }
            if (burstLimit !== Infinity && localState.burstCount >= burstLimit
                && !localState.reloadingBurst) {
                // Remaining normal-reload credit cannot carry through the
                // burst pause.
                localState.shotsOwed = 0;
            } else {
                localState.shotsOwed = Math.max(0,
                    (localState.shotsOwed ?? 0) - firedCalls);
                if (fireUnavailable) {
                    // Do not build a multi-shot backlog while guidance or a
                    // projectile queue temporarily makes the weapon unusable.
                    // Keep a whole ready opportunity: using 1 - EPSILON here
                    // makes floor() return zero forever when a blocked weapon
                    // becomes available without another positive time step
                    // (for example while a paused client is being resumed).
                    localState.shotsOwed = Math.min(localState.shotsOwed, 1);
                }
            }
        }
    }
});

// Retained for callers displaying an abuse ceiling. Authoritative intent firing
// uses FireCadence below, not arrival-time rate/spacing rejection.
export function weaponShotRateCeiling(
    weapon: WeaponData,
    installedCount: number,
): number {
    const count = Math.max(1, Math.floor(installedCount));
    const reload = Math.max(1, weapon.reload);
    const sustained = Math.ceil(1000 / reload) * count;
    const burst = weapon.burstCount > 0
        ? weapon.burstCount * count : count;
    return Math.min(240, Math.max(count, sustained + burst));
}


function validFireIntent(shot: FireIntentShot): boolean {
    return Number.isSafeInteger(shot.seq) && shot.seq > 0
        && Number.isInteger(shot.seed)
        && shot.seed >= 0 && shot.seed <= 0xffff_ffff
        && Number.isSafeInteger(shot.exitIndex) && shot.exitIndex >= 0
        && typeof shot.weaponId === 'string'
        && (shot.target === undefined || typeof shot.target === 'string');
}

/** Non-draftable, non-replicated state survives wire buffer removal and world transfer. */
export class ServerFireCadenceState {
    now = -Infinity;
    readonly cadence = new FireCadence<FireIntentShot>(() => this.now);
    boundary: string | undefined;
    blocked = false;
    hadIntent = false;
    invalidated = false;
    activeWeapons = new Set<string>();
    highestIntentSeq = 0;
    nextLogSeq = 1;
}

// The token-scoped authority outlives room entities and reconnects. Recreating
// an entity must not reset its firing debt or reaccept the old intent buffer.
const pilotCadences = new WeakMap<CombatAuthority, ServerFireCadenceState>();

export const ServerFireCadenceComponent =
    new Component<ServerFireCadenceState>('ServerFireCadenceComponent');

function watchFireCadenceLifecycle(entity: Entity, state: ServerFireCadenceState): void {
    // Latch even transient add/remove transitions between server ticks. Callbacks
    // retain only the non-draftable local state, never component values or Time.
    entity.components.events.add.subscribe(([component]) => {
        if (component === DestructionStartedComponent || component === PlayerDeathComponent
            || component === JumpStateComponent || component === DisabledComponent) {
            state.invalidated = true;
        }
    });
    entity.components.events.delete.subscribe(deleted => {
        for (const [component] of deleted) {
            if (component === FireIntentComponent || component === WeaponsStateComponent
                || component === ShipComponent || component === MultiplayerData
                || component === DestructionStartedComponent || component === PlayerDeathComponent
                || component === JumpStateComponent || component === DisabledComponent) {
                state.invalidated = true;
            }
        }
    });
}

/**
 * Integration point for authoritative player costs. The scheduler supplies stable
 * per-copy burst context, and debits cadence only if this returns a FiredShot.
 * Keep payments keyed by weapon ID + context.burstToken + context.copy; do not use
 * firstInBurst alone (a copy's first shot can be unavailable). NPC fireWithCost is
 * intentionally separate and unchanged.
 */
export function fireScheduledIntent(
    entity: Entity, weapon: WeaponEntry, source: string, shot: FireIntentShot,
    context: FireCadenceShotContext,
): FiredShot | undefined {
    // Even a prepaid burst requires a live flight authority (not a landed or
    // retired pilot). Unlimited also gates asynchronous ledger initialization.
    if (!canPay(entity, 'unlimited')) return undefined;
    const fire = () => weapon.fireFromEntityDetailed(source, shot.seed, true, shot.exitIndex, {
        entityId: loggedShotEntityId(source, shot.seq), target: shot.target,
    });
    const data = weapon.data;
    if (!('oneAmmoPerBurst' in data) || !data.oneAmmoPerBurst || data.burstCount <= 0) {
        return withCost(entity, data.ammoType, fire);
    }
    let payments = entity.components.get(PlayerBurstPaymentsComponent);
    if (!payments) {
        payments = new Map();
        entity.components.set(PlayerBurstPaymentsComponent, payments);
    }
    let payment = payments.get(data.id);
    if (!payment || payment.token !== context.burstToken) {
        payment = { token: context.burstToken, copies: new Set() };
        payments.set(data.id, payment);
    }
    if (payment.copies.has(context.copy)) return fire();
    // Reserve on the first successful shot, rather than retail's end-of-burst
    // debit. Partial bursts cannot become free through cancellation/reconnect.
    const fired = withCost(entity, data.ammoType, fire);
    if (fired) payment.copies.add(context.copy);
    return fired;
}

export const ServerFireIntentSystem = new System({
    name: 'ServerFireIntentSystem',
    after: [WeaponsSystem],
    args: [
        Optional(FireIntentComponent),
        Optional(WeaponsStateComponent),
        MultiplayerData,
        PlatformResource,
        WeaponEntries,
        TimeResource,
        UUID,
        GetEntity,
        Optional(FireLogComponent),
        Optional(SystemIdResource),
    ] as const,
    step(intent, weapons, multiplayer, platform, weaponEntries, time, uuid,
        entity, log, systemId) {
        if (platform !== 'node') return;
        let local = entity.components.get(ServerFireCadenceComponent);
        const authority = entity.components.get(CombatAuthorityComponent);
        const shared = authority && pilotCadences.get(authority);
        if (!local && !weapons) return;
        if (shared && shared !== local) {
            local = shared;
            local.invalidated = true;
            entity.components.set(ServerFireCadenceComponent, local);
            watchFireCadenceLifecycle(entity, local);
        } else if (!local) {
            local = new ServerFireCadenceState();
            entity.components.set(ServerFireCadenceComponent, local);
            watchFireCadenceLifecycle(entity, local);
        }
        if (authority && !shared) pilotCadences.set(authority, local);
        // Store only a primitive clock reading. Time/GetWorld/component drafts
        // must never escape this synchronous step through a scheduler closure.
        if (!Number.isFinite(time.time)) {
            local.cadence.clearPending();
            return;
        }
        local.now = Math.max(local.now, time.time);
        const sync = getFireSyncLocalState(entity, intent, log);
        sync.highestIntentSeq = Math.max(sync.highestIntentSeq, local.highestIntentSeq);
        sync.nextLogSeq = Math.max(sync.nextLogSeq, local.nextLogSeq);
        const player = entity.components.get(PlayerStateComponent);
        const boundary = JSON.stringify([
            multiplayer.owner, entity.components.get(ShipComponent)?.id,
            player?.shipId, player?.currentSystem, player?.diedAt,
            player?.landingCount, systemId,
        ]);
        const blocked = multiplayer.owner === 'server' || !weapons
            || entity.components.has(DestructionStartedComponent)
            || entity.components.has(PlayerDeathComponent)
            || entity.components.has(JumpStateComponent)
            || entity.components.get(DisabledComponent) === true
            || (entity.components.get(ArmorComponent)?.current ?? 1) <= 0;
        const invalidate = blocked || local.blocked || local.invalidated
            || (local.boundary !== undefined && local.boundary !== boundary);
        local.invalidated = false;
        local.boundary = boundary;
        local.blocked = blocked;
        if (invalidate || (local.hadIntent && !intent)) {
            local.cadence.clearPending();
        }
        local.hadIntent = intent !== undefined;

        const active = new Set<string>();
        if (!invalidate) {
            for (const [id, installed] of weapons ?? []) {
                const weapon = weaponEntries.getCached(id);
                if (!weapon || weapon.syncAsFireEvent === false) continue;
                try {
                    local.cadence.setWeapon(id, {
                        reload: weapon.data.reload,
                        burstReload: weapon.data.burstReload,
                        burstCount: weapon.data.burstCount,
                        fireSimultaneously: weapon.data.fireSimultaneously,
                        count: installed.count,
                    });
                    if (installed.count > 0) active.add(id);
                } catch (error) {
                    // Bad owner-writable inventory or capacity exhaustion must
                    // fail closed, not crash a server tick or refill old debt.
                    if (!(error instanceof RangeError)) throw error;
                    local.cadence.clearPending(id);
                }
            }
        }
        for (const id of local.activeWeapons) {
            if (!active.has(id)) local.cadence.clearPending(id);
        }
        local.activeWeapons = active;

        for (const shot of newShotsAfter(intent?.shots ?? [], sync.highestIntentSeq)) {
            if (!validFireIntent(shot)) continue;
            // Includes blocked, unknown, full and eventually expired intents.
            // A retained/re-added wire buffer must never resurrect them.
            sync.highestIntentSeq = shot.seq;
            local.highestIntentSeq = shot.seq;
            if (invalidate || !active.has(shot.weaponId)) continue;
            const snapshot: FireIntentShot = {
                seq: shot.seq, weaponId: shot.weaponId,
                seed: shot.seed, exitIndex: shot.exitIndex,
            };
            if (shot.target !== undefined) snapshot.target = shot.target;
            local.cadence.enqueue(shot.weaponId, snapshot);
        }
        // Drain every tick, independent of network arrivals and trigger state.
        for (const id of active) {
            const weapon = weaponEntries.getCached(id)!;
            local.cadence.drain(id, (shot, at, context) => {
                const fired = fireScheduledIntent(entity, weapon, uuid, shot, context);
                if (!fired) return false;
                rememberSpawnedShot(sync, shot.seq);
                const logged = makeFireLogShot(shot, at, fired.position, fired.rotation, {
                    logSeq: sync.nextLogSeq++,
                    sourceVelocity: fired.sourceVelocity,
                    target: fired.target,
                    inaccuracy: fired.inaccuracy,
                });
                if (log) {
                    pushShot(log.shots, logged);
                } else {
                    log = { shots: [logged] };
                }
                entity.components.set(FireLogComponent, log);
                local!.nextLogSeq = sync.nextLogSeq;
                return true;
            });
        }
    },
});

export const FireLogSpawnSystem = new System({
    name: 'FireLogSpawnSystem',
    after: [WeaponsSystem, ServerFireIntentSystem],
    args: [
        FireLogComponent,
        WeaponEntries,
        TimeResource,
        UUID,
        GetEntity,
        Optional(FireIntentComponent),
        Optional(ServerClockOffsetResource),
    ] as const,
    step(log, weaponEntries, time, uuid, entity, intent, serverClockOffset) {
        const sync = getFireSyncLocalState(entity, intent, log);
        const clockOffset = serverClockOffset?.offset ?? 0;
        for (const shot of newFireLogsAfter(log.shots, sync.highestLogSeq)) {
            const logSeq = fireLogSequence(shot);
            sync.nextSeq = Math.max(sync.nextSeq, shot.seq + 1);
            sync.nextLogSeq = Math.max(sync.nextLogSeq, logSeq + 1);
            const spawned = sync.spawnedSeqs.delete(shot.seq);
            if (spawned || (shot.seq >= sync.lowestPredictedSeq
                && shot.seq <= sync.highestPredictedSeq)) {
                sync.highestLogSeq = logSeq;
                continue;
            }
            const weapon = weaponEntries.getCached(shot.weaponId);
            if (!weapon) {
                break;
            }
            if (weapon.syncAsFireEvent === false) {
                sync.highestLogSeq = logSeq;
                continue;
            }
            const mappedShot = clockOffset !== 0
                ? { ...shot, at: shot.at + clockOffset }
                : shot;
            weapon.fireFromLog(uuid, mappedShot, time.time);
            sync.highestLogSeq = logSeq;

            if ((globalThis as any).debugCombat || (globalThis as any).novaDebug?.debugCombat) {
                console.log(`[Combat Remote] Spawned shot seq=${shot.seq} weapon=${shot.weaponId} from ${uuid} at (${Math.round(shot.position.x)}, ${Math.round(shot.position.y)})`);
            }
        }

    },
});

/**
 * Apply the trigger for one weapon.
 *
 * A browser delivers keydown and keyup independently of the simulation, so a
 * quick tap can begin and end between two steps. Releasing the intent
 * immediately in that case throws the shot away entirely, and because `firing`
 * is what gets replicated, the server never learns about the tap either. Hold
 * the release until one step has observed the press.
 */
export function applyWeaponTrigger(state: WeaponState,
    localState: WeaponLocalState, pressed: boolean) {
    if (pressed) {
        state.firing = true;
        localState.releaseAfterStep = false;
        return;
    }
    if (state.firing && !localState.pressObserved) {
        localState.releaseAfterStep = true;
        return;
    }
    state.firing = false;
    localState.releaseAfterStep = false;
    localState.pressObserved = false;
}

/**
 * Clears a held trigger one step after the press was simulated. This runs only
 * in the browser: the server's copy of `firing` is replicated intent and is
 * never latched locally.
 */
export const ReleaseWeaponTriggerSystem = new System({
    name: 'ReleaseWeaponTrigger',
    args: [WeaponsStateComponent, WeaponsComponent] as const,
    after: [WeaponsSystem],
    step(weaponsState, weaponsLocalState) {
        for (const [id, state] of weaponsState) {
            const localState = weaponsLocalState.get(id);
            if (localState.releaseAfterStep && localState.pressObserved) {
                state.firing = false;
                localState.releaseAfterStep = false;
                localState.pressObserved = false;
            }
        }
    },
});

type ActiveSecondary = {
    secondary: string | null /* id */,
};

export const ActiveSecondaryWeapon =
    new Component<ActiveSecondary>('ActiveSecondaryWeapon');

const ActiveSecondaryProvider = Provide({
    name: "ActiveSecondaryProvider",
    provided: ActiveSecondaryWeapon,
    args: [PlayerShipSelector] as const,
    factory: () => ({ secondary: null }),
});

export const ChangeSecondaryEvent = new EcsEvent<ActiveSecondary>('ChangeSecondaryEvent');

const ControlPlayerWeapons = new System({
    name: 'ControlPlayerWeapons',
    events: [ControlStateEvent],
    args: [ControlStateEvent, WeaponsStateComponent, WeaponsComponent,
        ActiveSecondaryWeapon, Emit, GameDataResource,
        Optional(DestructionStartedComponent), Optional(ArmorComponent),
        PlayerShipSelector] as const,
    step(controlState, weaponsState, weaponsLocalState, activeSecondary, emit,
        gameData, destructionStarted, armor) {
        if (destructionStarted !== undefined || armor && armor.current <= 0) {
            clearWeaponFiringState(weaponsState, weaponsLocalState);
            return;
        }
        for (const [id, weaponState] of weaponsState) {
            applyWeaponTrigger(weaponState, weaponsLocalState.get(id), false);
        }

        // TODO: Store this somewhere?
        const secondaryWeapons = [
            undefined, // for when no weapon is selected
            ...[...weaponsState].filter(([id]) => {
                return gameData.data.Weapon.getCached(id)?.fireGroup === 'secondary';
            }).map(([id]) => id)
        ];

        let secondary: WeaponState | undefined;
        let secondaryIndex = 0;
        if (activeSecondary.secondary) {
            secondary = weaponsState.get(activeSecondary.secondary);
            secondaryIndex = secondaryWeapons.indexOf(activeSecondary.secondary);
        }

        let changedSecondary = false;

        if (controlState.get('resetSecondary') === 'start') {
            secondaryIndex = 0;
            changedSecondary = true;
        } else if (controlState.get('previousSecondary') === 'start') {
            secondaryIndex--;
            changedSecondary = true;
        } else if (controlState.get('nextSecondary') === 'start') {
            secondaryIndex++;
            changedSecondary = true;
        }

        secondaryIndex = mod(secondaryIndex, secondaryWeapons.length);
        activeSecondary.secondary = secondaryWeapons[secondaryIndex] ?? null;

        if (changedSecondary) {
            emit(ChangeSecondaryEvent, activeSecondary);
        }

        if (activeSecondary.secondary) {
            secondary = weaponsState.get(activeSecondary.secondary);
        }

        if (secondary && activeSecondary.secondary) {
            applyWeaponTrigger(secondary,
                weaponsLocalState.get(activeSecondary.secondary),
                Boolean(controlState.get('fireSecondary')));
        }

        const firing = Boolean(controlState.get('firePrimary'));
        for (const [id, weaponState] of weaponsState) {
            if (gameData.data.Weapon.getCached(id)?.fireGroup === 'primary') {
                applyWeaponTrigger(weaponState,
                    weaponsLocalState.get(id), firing);
            }
        }
    }
});

export const WeaponPlugin: Plugin = {
    name: 'WeaponPlugin',
    build(world) {
        const gameData = world.resources.get(GameDataResource);
        if (!gameData) {
            throw new Error('missing gameData');
        }

        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }

        world.addPlugin(FireSyncPlugin);
        world.addComponent(WeaponsStateComponent);
        // Deliberately not registered with DeltaResource: payments are local.
        world.addComponent(WeaponBurstPaymentsComponent);
        world.addComponent(PlayerBurstPaymentsComponent);
        world.addComponent(NpcWeaponFuelComponent);
        world.addComponent(ServerFireCadenceComponent);
        world.addSystem(WeaponsSystem);
        world.addSystem(ServerFireIntentSystem);
        world.addSystem(FireLogSpawnSystem);
        const platform = world.resources.get(PlatformResource);
        if (platform === 'browser') {
            world.addSystem(ActiveSecondaryProvider);
            world.addSystem(ControlPlayerWeapons);
            world.addSystem(ReleaseWeaponTriggerSystem);
        }
        deltaMaker.addComponent(WeaponsStateComponent, {
            componentType: WeaponsState
        });
    }
}
