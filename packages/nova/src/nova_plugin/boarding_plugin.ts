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
    axesAligned, BoardBlockReason, BoardedComponent, BoardedState,
    boardingBlockedReason, BoardingComponent, BoardingState, captureChance,
    creditBooty, fuelTransferAmount, planCargoPlunder,
} from './boarding_component.js';
import { CargoComponent, cargoUsed } from './cargo_plugin.js';
import { DisabledComponent, isBelowDisableThreshold, repairedArmor } from './disabled_component.js';
import { EscortCommandComponent } from './escort_command.js';
import { FiringGroupComponent } from './firing_group.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { GovtComponent } from './govt_component.js';
import { ArmorComponent } from './health_plugin.js';
import { FuelComponent } from './health_plugin.js';
import { FormationComponent, NpcComponent } from './npc_ai_plugin.js';
import { CreditsComponent } from './player_state_plugin.js';
import { applyCrime } from './reputation.js';
import { GovtsResource, LegalRecordsComponent } from './reputation_plugin.js';
import { ShipControlEvent, ShipControlStateComponent } from './ship_control.js';
import { ShipDataComponent, ShipPhysicsComponent } from './ship_plugin.js';
import { TargetComponent } from './target_component.js';

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
        GetEntity, UUID, Entities, Emit] as const,
    step(controls, movement, _shipData, target, boarding, entity, uuid,
        entities, emit) {
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

        entity.components.set(BoardingComponent, {
            target: targetUuid!,
            creditsAvailable: creditBooty(targetShipData!.price),
            cargoTaken: false,
            creditsTaken: false,
            fuelTaken: false,
            capture: 'none',
            crimeApplied: false,
        });
        targetEntity!.components.set(BoardedComponent, { boarder: uuid });
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
    let slot = 0;
    for (const [, e] of entities) {
        if (e.components.get(FormationComponent)?.leader === leaderUuid) {
            slot++;
        }
    }
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
        Optional(LegalRecordsComponent), GetEntity, UUID, Entities,
        RandomResource, Optional(GovtsResource), SimulationGameDataResource,
        Emit] as const,
    step(controls, boarding, shipData, cargo, physics, credits, fuel, records,
        entity, uuid, entities, random, govts, gameData) {
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

        world.addSystem(BoardingGateSystem);
        world.addSystem(BoardingActionSystem);
    },
    remove(world) {
        world.removeSystem(BoardingGateSystem);
        world.removeSystem(BoardingActionSystem);
    },
};
