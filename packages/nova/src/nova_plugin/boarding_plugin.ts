import * as t from 'io-ts';
import { Emit, Entities, GetEntity, UUID } from 'nova_ecs/arg_types';
import { Entity } from 'nova_ecs/entity';
import { EntityMap } from 'nova_ecs/entity_map';
import { EcsEvent } from 'nova_ecs/events';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { RandomResource } from 'nova_ecs/plugins/random_plugin';
import { SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { System } from 'nova_ecs/system';
import { registerSimulationBridgeEvent } from '../communication/simulation_bridge_events.js';
import {
    AmmoOutfitInfo, axesAligned, BoardBlockReason, BoardedComponent,
    BoardedState, boardingBlockedReason, BoardingComponent, BoardingState,
    captureChance, creditBooty, fuelTransferAmount, planAmmoPlunder,
    planCargoPlunder,
} from './boarding_component.js';
import { CargoComponent, cargoUsed } from './cargo_plugin.js';
import { OutfitsState, OutfitsStateComponent } from './outfit_plugin.js';
import { WeaponsState, WeaponsStateComponent } from './weapons_state.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { DisabledComponent, isBelowDisableThreshold, repairedArmor } from './disabled_component.js';
import { EscortCommandComponent } from './escort_command.js';
import { FiringGroupComponent } from './firing_group.js';
import { isInFlock } from './flock.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { GovtComponent } from './govt_component.js';
import { ArmorComponent } from './health_plugin.js';
import { ShieldComponent } from './health_plugin.js';
import { FuelComponent } from './health_plugin.js';
import {
    formationsIn, FormationComponent, nextFormationSlot, NpcComponent,
} from './npc_ai_plugin.js';
import { CreditsComponent } from './player_state_plugin.js';
import { applyCrime } from './reputation.js';
import { GovtsResource, LegalRecordsComponent } from './reputation_plugin.js';
import { ShipControlEvent, ShipControlStateComponent } from './ship_control.js';
import { ShipDataComponent, ShipPhysicsComponent } from './ship_plugin.js';
import { PlayerSoundEvent } from './sound_plugin.js';
import { TargetComponent } from './target_component.js';

/** Interface beep when a plunder session opens (snd nova:390), heard only
 * by the boarding player (emitted targeted at the boarder). */
const BOARD_SOUND = 'nova:390';

/**
 * Player-initiated boarding and plundering of disabled ships. See
 * boarding_component.ts for the Bible reference, the components, the
 * tuning constants, and the pure helpers. This module owns the two sim
 * systems and the "boarding blocked" feedback event.
 *
 *  - BoardingGateSystem: the 'board' key. Validates the disabled /
 *    close / slow / axis-aligned gate against the selected target and
 *    either opens a plunder session (BoardingComponent on the boarder +
 *    BoardedComponent on the victim) or emits BoardingBlockedEvent for
 *    the status line.
 *  - BoardingActionSystem: the plunder-dialog actions (take cargo /
 *    credits / fuel, attempt capture, take the capture as an escort,
 *    done). Every action is a replayed control input, so all transfers
 *    and the seeded capture roll happen identically on every peer.
 *
 * The DIALOG is display-side (display/boarding_plugin.ts); it opens and
 * closes by watching the synced BoardingComponent, and its buttons emit
 * these plunder control actions back into the sim. Boarding by NPCs is
 * out of scope (player-initiated only); the gate is only ever reached
 * through the player's control events.
 */

/**
 * Emitted (targeted at the boarding ship) when a board attempt is
 * rejected — mirrors LandingBlockedEvent. Consumed display-side by the
 * status line (status_message_plugin.ts). Never mutates the simulation.
 */
export const BoardingBlockedEvent =
    new EcsEvent<{ reason: BoardBlockReason }>('BoardingBlockedEvent');
export const BoardingBlockedEventType = t.type({
    reason: t.union([
        t.literal('noTarget'), t.literal('notDisabled'), t.literal('noCrew'),
        t.literal('tooFar'), t.literal('tooFast'), t.literal('notAligned')]),
});
registerSimulationBridgeEvent({ event: BoardingBlockedEvent });

/**
 * Emitted (targeted at the boarding ship) when boarding one of your OWN
 * disabled flock members repairs it in place instead of opening a
 * plunder session. Consumed display-side by the status line
 * (status_message_plugin.ts); never mutates the simulation.
 */
export const EscortRepairedEvent =
    new EcsEvent<Record<string, never>>('EscortRepairedEvent');
export const EscortRepairedEventType = t.type({});
registerSimulationBridgeEvent({ event: EscortRepairedEvent });

/**
 * Builds the planAmmoPlunder inputs from live entities + game data: the
 * victim's outfit counts, the boarder's ammo rounds keyed by weapon, and the
 * ammo-outfit resolver (weapon + capacity, gated on the boarder mounting a
 * launcher for that weapon). Shared by the gate (to freeze ammoAvailable) and
 * the plunder action (to move the rounds), so both agree on what is takeable.
 */
function ammoPlunderInputs(boarderOutfits: OutfitsState | undefined,
    boarderWeapons: WeaponsState | undefined,
    victimOutfits: OutfitsState | undefined,
    gameData: SimulationGameDataInterface) {
    const victim = new Map<string, number>();
    for (const [id, state] of victimOutfits ?? []) {
        victim.set(id, state.count);
    }
    const boarderRoundsByWeapon = new Map<string, number>();
    for (const [id, state] of boarderOutfits ?? []) {
        const weaponId = gameData.data.Outfit.getCached(id)?.ammoFor;
        if (weaponId) {
            boarderRoundsByWeapon.set(weaponId,
                (boarderRoundsByWeapon.get(weaponId) ?? 0) + state.count);
        }
    }
    const info = (outfitId: string): AmmoOutfitInfo | undefined => {
        const outfit = gameData.data.Outfit.getCached(outfitId);
        const weaponId = outfit?.ammoFor;
        if (!weaponId) {
            return undefined;
        }
        // The boarder must mount a launcher for this weapon to hold its ammo.
        const launcher = boarderWeapons?.get(weaponId);
        if (!launcher || launcher.count <= 0) {
            return undefined;
        }
        const weapon = gameData.data.Weapon.getCached(weaponId);
        const capacity = weapon && weapon.maxAmmo > 0
            ? weapon.maxAmmo * launcher.count
            : (outfit.max > 0 ? outfit.max : Infinity);
        return { ammoFor: weaponId, capacity };
    };
    return { victim, boarderRoundsByWeapon, info };
}

/**
 * The 'board' key. With a disabled ship selected and the boarder pulled
 * alongside (close, matched speed, axis-aligned), opens a plunder
 * session; otherwise reports why on the status line. A session already
 * open, or a target already being boarded, is left alone.
 */
const BoardingGateSystem = new System({
    name: 'BoardingGateSystem',
    events: [ShipControlEvent] as const,
    args: [ShipControlStateComponent, MovementStateComponent,
        ShipDataComponent, TargetComponent, Optional(BoardingComponent),
        Optional(OutfitsStateComponent), Optional(WeaponsStateComponent),
        GetEntity, UUID, Entities, SimulationGameDataResource, Emit] as const,
    step(controls, movement, _shipData, target, boarding, boarderOutfits,
        boarderWeapons, entity, uuid, entities, gameData, emit) {
        if (controls.get('board') !== 'start') {
            return;
        }
        // One session at a time.
        if (boarding) {
            return;
        }

        const targetUuid = target.target;
        const targetEntity =
            targetUuid !== undefined && targetUuid !== uuid
                ? entities.get(targetUuid) : undefined;
        const targetShipData = targetEntity?.components.get(ShipDataComponent);
        const targetMovement =
            targetEntity?.components.get(MovementStateComponent);

        // A ship someone is already plundering can't be boarded again
        // (it has already yielded its booty). Treated as "nothing to
        // board" for feedback purposes.
        if (targetEntity?.components.has(BoardedComponent)) {
            emit(BoardingBlockedEvent, { reason: 'notDisabled' }, [uuid]);
            return;
        }

        const distanceSquared = targetMovement
            ? targetMovement.position.subtract(movement.position).lengthSquared
            : Infinity;
        const relSpeedSquared = targetMovement
            ? targetMovement.velocity.subtract(movement.velocity).lengthSquared
            : Infinity;
        const aligned = !!targetMovement
            && axesAligned(movement.rotation, targetMovement.rotation);

        const reason = boardingBlockedReason({
            hasTarget: !!targetEntity && !!targetShipData && !!targetMovement,
            targetDisabled: !!targetEntity?.components.has(DisabledComponent),
            targetCrew: targetShipData?.crew ?? 0,
            distanceSquared,
            relSpeedSquared,
            aligned,
        });
        if (reason) {
            emit(BoardingBlockedEvent, { reason }, [uuid]);
            return;
        }

        // Boarding your OWN disabled flock member (a hired or captured
        // escort, or one of your bay fighters) does NOT plunder it: it
        // repairs it in place. The boarding gate above still applies
        // (close, slow, axis-aligned). Restore armor just above the
        // disable threshold — ShipDisableSystem then lifts
        // DisabledComponent, so the escort resumes formation — and
        // shields to full, matching the hail-assist repair
        // (hail_plugin.ts). Report it on the status line; no plunder
        // session opens.
        if (isInFlock(targetUuid!, uuid, u => entities.get(u))) {
            const targetArmor = targetEntity!.components.get(ArmorComponent);
            if (targetArmor && isBelowDisableThreshold(
                targetArmor, targetShipData!.disableArmorFraction)) {
                targetArmor.current = repairedArmor(
                    targetArmor.max, targetShipData!.disableArmorFraction);
            }
            const targetShield = targetEntity!.components.get(ShieldComponent);
            if (targetShield) {
                targetShield.current = targetShield.max;
            }
            targetEntity!.components.delete(DisabledComponent);
            emit(EscortRepairedEvent, {}, [uuid]);
            return;
        }

        // Freeze the compatible ammo the boarder could take (same inputs the
        // plunderAmmo action uses), so the dialog can show/grey Ammo.
        const { victim, boarderRoundsByWeapon, info } = ammoPlunderInputs(
            boarderOutfits, boarderWeapons,
            targetEntity!.components.get(OutfitsStateComponent), gameData);
        const ammoAvailable = planAmmoPlunder(victim, boarderRoundsByWeapon, info)
            .reduce((sum, [, rounds]) => sum + rounds, 0);

        entity.components.set(BoardingComponent, {
            target: targetUuid!,
            creditsAvailable: creditBooty(targetShipData!.price),
            ammoAvailable,
            cargoTaken: false,
            creditsTaken: false,
            fuelTaken: false,
            ammoTaken: false,
            capture: 'none',
            crimeApplied: false,
        });
        targetEntity!.components.set(BoardedComponent, { boarder: uuid });
        // Local boarding beep for the boarding player only.
        emit(PlayerSoundEvent, { id: BOARD_SOUND }, [uuid]);
    },
});

/**
 * Turns a captured disabled hulk into the boarder's escort: it joins
 * the formation flock, hands its brain to the escort-command framework
 * (which suppresses its native hostile AI), shares the boarder's
 * firing group, sheds its government (so it reads as a neutral friendly
 * like a hired escort), and is patched back above its disable threshold
 * so it can fly. Mirrors the component set spawnHiredEscorts stamps
 * (browser.ts), applied to a live entity rather than a fresh one.
 */
function convertToEscort(target: Entity,
    leaderUuid: string, leaderOwner: string | undefined,
    entities: EntityMap): void {
    const slot = nextFormationSlot(formationsIn(entities), leaderUuid);
    target.components.set(FormationComponent, { leader: leaderUuid, slot });
    target.components.set(EscortCommandComponent, { command: 'formation' });
    target.components.set(FiringGroupComponent, { group: leaderUuid });
    target.components.delete(GovtComponent);
    target.components.delete(BoardedComponent);
    if (leaderOwner !== undefined) {
        target.components.set(MultiplayerData, { owner: leaderOwner });
    }
    // Clear leftover hostility so a reverted-to-NPC escort (leader lost)
    // isn't still gunning for the ex-owner.
    const npc = target.components.get(NpcComponent);
    if (npc) {
        npc.aggressor = undefined;
    }
    const targetTarget = target.components.get(TargetComponent);
    if (targetTarget) {
        targetTarget.target = undefined;
    }
    // Bring it back online: restore armor above the disable threshold
    // and drop DisabledComponent so DisabledMovementSystem stops braking
    // it and the escort/formation systems can steer it.
    const shipData = target.components.get(ShipDataComponent);
    const armor = target.components.get(ArmorComponent);
    if (armor && shipData
        && isBelowDisableThreshold(armor, shipData.disableArmorFraction)) {
        armor.current = repairedArmor(armor.max, shipData.disableArmorFraction);
    }
    target.components.delete(DisabledComponent);
}

/**
 * The plunder-dialog actions. Each is idempotent (a per-action flag or
 * the capture state guards a repeated control edge), so a replayed input
 * never double-applies. All arithmetic is deterministic; the capture
 * roll draws once from the seeded RandomResource.
 */
const BoardingActionSystem = new System({
    name: 'BoardingActionSystem',
    events: [ShipControlEvent] as const,
    args: [ShipControlStateComponent, BoardingComponent, ShipDataComponent,
        CargoComponent, ShipPhysicsComponent, CreditsComponent, FuelComponent,
        Optional(LegalRecordsComponent), Optional(OutfitsStateComponent),
        Optional(WeaponsStateComponent), GetEntity, UUID, Entities,
        RandomResource, Optional(GovtsResource), SimulationGameDataResource,
        Emit] as const,
    step(controls, boarding, shipData, cargo, physics, credits, fuel, records,
        boarderOutfits, boarderWeapons, entity, uuid, entities, random, govts,
        gameData) {
        const target = entities.get(boarding.target);

        // Charges the BoardPenalty crime once per session, the first
        // time the player takes booty or attempts capture ("pirating").
        const chargeCrime = () => {
            if (boarding.crimeApplied) {
                return;
            }
            boarding.crimeApplied = true;
            const govtId = target?.components.get(GovtComponent)?.id;
            if (records && govtId) {
                const govtData = gameData.data.Govt.getCached(govtId);
                if (govtData) {
                    applyCrime(records, govtData, 'board', govts ?? []);
                }
            }
        };

        // Done, or the target vanished: end the session.
        if (controls.get('plunderDone') === 'start' || !target) {
            entity.components.delete(BoardingComponent);
            return;
        }

        // Take the captured ship as an escort (capture-assignment
        // dialog). Ends the session.
        if (controls.get('plunderCaptureEscort') === 'start'
            && boarding.capture === 'succeeded') {
            const owner = entity.components.get(MultiplayerData)?.owner;
            convertToEscort(target, uuid, owner, entities);
            boarding.capture = 'assigned';
            entity.components.delete(BoardingComponent);
            return;
        }

        // The remaining actions need the victim to still be a boardable
        // hulk; a repair or a stray killing blow ends the session.
        if (!target.components.has(DisabledComponent)) {
            entity.components.delete(BoardingComponent);
            return;
        }

        if (controls.get('plunderCargo') === 'start' && !boarding.cargoTaken) {
            boarding.cargoTaken = true;
            const targetCargo = target.components.get(CargoComponent);
            if (targetCargo) {
                const free = physics.freeCargo - cargoUsed(cargo);
                for (const [key, tons] of planCargoPlunder(targetCargo, free)) {
                    cargo.set(key, (cargo.get(key) ?? 0) + tons);
                    const left = (targetCargo.get(key) ?? 0) - tons;
                    if (left > 0) {
                        targetCargo.set(key, left);
                    } else {
                        targetCargo.delete(key);
                    }
                }
            }
            chargeCrime();
        }

        if (controls.get('plunderCredits') === 'start'
            && !boarding.creditsTaken) {
            boarding.creditsTaken = true;
            credits.credits += boarding.creditsAvailable;
            chargeCrime();
        }

        if (controls.get('plunderFuel') === 'start' && !boarding.fuelTaken) {
            boarding.fuelTaken = true;
            const targetFuel = target.components.get(FuelComponent);
            if (targetFuel) {
                const moved = fuelTransferAmount(
                    targetFuel.current, fuel.current, fuel.max);
                fuel.current += moved;
                targetFuel.current -= moved;
            }
            chargeCrime();
        }

        if (controls.get('plunderAmmo') === 'start' && !boarding.ammoTaken) {
            boarding.ammoTaken = true;
            const targetOutfits = target.components.get(OutfitsStateComponent);
            if (boarderOutfits && targetOutfits) {
                const { victim, boarderRoundsByWeapon, info } = ammoPlunderInputs(
                    boarderOutfits, boarderWeapons, targetOutfits, gameData);
                for (const [outfitId, rounds] of
                    planAmmoPlunder(victim, boarderRoundsByWeapon, info)) {
                    // Move rounds of the SAME ammo outfit: remove from the
                    // victim, add to the boarder's stock (in-place count
                    // edits, like weapon_plugin's consumeAmmo).
                    const victimState = targetOutfits.get(outfitId);
                    if (victimState) {
                        victimState.count -= rounds;
                        if (victimState.count <= 0) {
                            targetOutfits.delete(outfitId);
                        }
                    }
                    const boarderState = boarderOutfits.get(outfitId);
                    if (boarderState) {
                        boarderState.count += rounds;
                    } else {
                        boarderOutfits.set(outfitId, { count: rounds });
                    }
                }
            }
            chargeCrime();
        }

        if (controls.get('plunderCapture') === 'start'
            && boarding.capture !== 'succeeded') {
            const targetCrew =
                target.components.get(ShipDataComponent)?.crew ?? 0;
            // Bible: a 0-crew boarder can't capture. Marines (ModType 25)
            // would add to the boarder's effective crew here — a
            // documented seam (unparsed), so the raw shïp Crew is used.
            const chance = captureChance(shipData.crew, targetCrew);
            boarding.capture = random.next() < chance ? 'succeeded' : 'failed';
            chargeCrime();
        }
    },
});

export const BoardingPlugin: Plugin = {
    name: 'BoardingPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        world.addComponent(BoardingComponent);
        world.addComponent(BoardedComponent);
        // Delta registration also registers the serializer, so both ride
        // wire snapshots, rollback snapshots, and the display sync.
        deltaMaker.addComponent(BoardingComponent, {
            componentType: BoardingState,
        });
        deltaMaker.addComponent(BoardedComponent, {
            componentType: BoardedState,
        });
        world.resources.get(SerializerResource)?.addEvent(
            BoardingBlockedEvent, BoardingBlockedEventType);
        world.resources.get(SerializerResource)?.addEvent(
            EscortRepairedEvent, EscortRepairedEventType);

        world.addSystem(BoardingGateSystem);
        world.addSystem(BoardingActionSystem);
    },
    remove(world) {
        world.removeSystem(BoardingGateSystem);
        world.removeSystem(BoardingActionSystem);
    },
};
