import { WeaponData } from 'novadatainterface/WeaponData';
import { Emit, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { EcsEvent } from 'nova_ecs/events';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { Time, TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Provide } from 'nova_ecs/provide';
import { System } from 'nova_ecs/system';
import { mod } from '../util/mod';
import { ControlStateEvent } from './control_state_event';
import {
    WeaponEntries,
    WeaponLocalState,
    WeaponsComponent,
    WeaponsLocalState,
} from './fire_weapon_plugin';
import { GameDataResource } from './game_data_resource';
import { PlatformResource } from './platform_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { WeaponsState, WeaponsStateComponent, WeaponState } from './weapons_state';
import { ArmorComponent } from './health_plugin';
import { DestructionStartedComponent } from './destruction_state';

/**
 * Avoid an accidental large projectile burst after a stalled tab or server.
 * Simultaneous weapons still fire a complete salvo, so the limit is approximate
 * when a single salvo contains more than this many projectiles.
 */
export const MAX_WEAPON_PROJECTILES_PER_STEP = 16;

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
    args: [WeaponsStateComponent, WeaponsComponent,
        TimeResource, UUID, WeaponEntries,
        Optional(DestructionStartedComponent),
        Optional(ArmorComponent)] as const,
    step(weaponsState, weaponsLocalState, time, uuid, weaponEntries,
        destructionStarted, armor) {
        if (destructionStarted !== undefined || armor && armor.current <= 0) {
            clearWeaponFiringState(weaponsState, weaponsLocalState);
            return;
        }
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
                if (weapon.data.fireSimultaneously) {
                    for (let copy = 0; copy < count; copy++) {
                        fired = weapon.fireFromEntity(uuid) !== undefined || fired;
                    }
                } else {
                    fired = weapon.fireFromEntity(uuid) !== undefined;
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

        world.addComponent(WeaponsStateComponent);
        world.addSystem(WeaponsSystem);
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
