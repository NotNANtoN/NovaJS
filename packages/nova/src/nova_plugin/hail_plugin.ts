import * as t from 'io-ts';
import { GovtData } from 'novadatainterface/govt_data';
import { Entities, GetEntity } from 'nova_ecs/arg_types';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { MovementState, MovementStateComponent, MovementSystem } from 'nova_ecs/plugins/movement_plugin';
import { SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { TimeResource, TimeSystem } from 'nova_ecs/plugins/time_plugin';
import { System } from 'nova_ecs/system';
import { World } from 'nova_ecs/world';
import { DisabledComponent } from './disabled_component.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { GovtComponent } from './govt_component.js';
import { JumpComponent } from './jump_plugin.js';
import { AssistingComponent, AssistingType } from './hail_component.js';
import { ArmorComponent, FuelComponent, ShieldComponent } from './health_plugin.js';
import {
    bribeAmount,
    canRequestAssistance,
    shipTakesBribes,
} from './hail.js';
import { shipDisposition } from './iff_plugin.js';
import { NpcComponent, NpcSteeringSystem } from './npc_ai_plugin.js';
import { ShootAllWeaponsComponent } from './npc_plugin.js';
import { CreditsComponent } from './player_state_plugin.js';
import { GovtsResource, LegalRecordsComponent } from './reputation_plugin.js';
import { findControlledEntity } from './ship_control.js';
import { ShipComponent } from './ship_plugin.js';
import { TargetComponent } from './target_component.js';

/**
 * ============================================================================
 * Hailing — the simulation side (deterministic)
 * ============================================================================
 *
 * The comms DIALOG is client-side (display/hail_dialog_plugin.ts), but every
 * simulation effect a hail can cause — repairing/refuelling the player,
 * deducting bribe credits, an NPC "coming to assist", a bribed ship breaking
 * off — MUST flow through the deterministic input path so it resolves
 * identically on every peer. A hail action arrives as a `{ kind: 'hail' }`
 * SimulationInput record (simulation_input.ts), applied by `applyHail` below
 * on every peer at the same tick, exactly like setTarget / self-destruct.
 *
 * No randomness is used: eligibility and the bribe amount are pure functions
 * of synced state (govt flags, the player's records, credits), so the display
 * dialog and the sim agree without a compliance roll — and there is nothing
 * for a seeded-Random mismatch to desync. (A future randomized "will they
 * come?" roll would have to live entirely in the sim, using RandomResource,
 * with the dialog wording made outcome-agnostic.)
 *
 * Boarding / plunder / capture (PICTs 8515-8516) are explicitly out of scope;
 * the AssistingComponent and bribe seams here don't touch them.
 */

/**
 * The player-initiated hail actions that change the simulation. `target` is
 * the hailed ship's uuid. Amounts and eligibility are recomputed sim-side
 * from synced state — the record carries intent only, never a client-chosen
 * credit figure, so a tampered client can't grant itself a free repair.
 */
export type HailAction =
    | { kind: 'requestAssistance', target: string }
    | { kind: 'bribe', target: string };

export const HailActionType: t.Type<HailAction> = t.union([
    t.type({ kind: t.literal('requestAssistance'), target: t.string }),
    t.type({ kind: t.literal('bribe'), target: t.string }),
]);

/** How long a bribe keeps a hostile ship off the player's back, in ms.
 * TUNABLE / ASSUMPTION: the Bible doesn't quantify the reprieve; a bribe in
 * the original buys a lasting break until the player provokes them again.
 * Two minutes is long enough to escape and short enough that a persistent
 * criminal is eventually hunted again (the reputation record is unchanged). */
export const BRIBE_PACIFY_MS = 120_000;

/** Assist: the helper thrusts toward the client until within this range. */
export const ASSIST_ARRIVAL_RANGE = 300;
/** Assist: stop thrusting inside this range (coast the last stretch). */
export const ASSIST_STANDOFF = 200;

/** Under one jump's worth of fuel (FUEL_PER_JUMP = 100) counts as "low". */
export const LOW_FUEL_THRESHOLD = 100;

function lookupGovt(world: World, govtId: string | undefined):
    GovtData | undefined {
    if (govtId === undefined) {
        return undefined;
    }
    const govts = world.resources.get(GovtsResource);
    if (govts?.has(govtId)) {
        return govts.get(govtId);
    }
    return world.resources.get(SimulationGameDataResource)
        ?.data.Govt.getCached(govtId);
}

/** Whether the player ship needs fuel/repair help (disabled or low fuel). */
function playerNeedsHelp(player: Entity): boolean {
    if (player.components.has(DisabledComponent)) {
        return true;
    }
    const fuel = player.components.get(FuelComponent);
    return !!fuel && fuel.current < fuel.max
        && fuel.current < LOW_FUEL_THRESHOLD;
}

/**
 * Applies a hail action deterministically on every peer. Resolves the hailing
 * player from `peerId` and the target from the record; re-checks eligibility
 * against synced state before mutating anything.
 */
export function applyHail(world: World, peerId: string | undefined,
    action: HailAction) {
    const found = findControlledEntity(world, peerId);
    if (!found) {
        return;
    }
    const player = found.entity;
    const target = world.entities.get(action.target);
    if (!target || !target.components.has(ShipComponent)) {
        return;
    }
    const targetGovt = lookupGovt(world,
        target.components.get(GovtComponent)?.id);
    const playerGovt = lookupGovt(world,
        player.components.get(GovtComponent)?.id);
    const playerRecords = player.components.get(LegalRecordsComponent);
    const disposition = shipDisposition(targetGovt, playerGovt, playerRecords);

    // Behavioral hostility: a ship whose AI is attacking the player (mode
    // 'attack' with its target pointed at the player) is hostile regardless
    // of politics — the same rule the target corners use (iff_plugin's
    // targetCornerStyle), including the legacy dev-enemy ShootAllWeapons
    // marker. Computed from synced state so it matches the display dialog.
    const targetsPlayer =
        target.components.get(TargetComponent)?.target === found.uuid;
    const targetNpcMode = target.components.get(NpcComponent)?.mode;
    const attackingPlayer = targetsPlayer && (targetNpcMode === 'attack'
        || target.components.has(ShootAllWeaponsComponent));

    if (action.kind === 'requestAssistance') {
        if (!canRequestAssistance({
            disposition,
            playerNeedsHelp: playerNeedsHelp(player),
            govt: targetGovt,
            attackingPlayer,
        })) {
            return;
        }
        // The helper breaks off whatever it was doing and comes over. Marking
        // it is enough: NpcDecisionSystem yields to the AssistingComponent
        // and AssistBehaviorSystem flies it in and heals the client.
        target.components.set(AssistingComponent, { client: found.uuid });
        return;
    }

    // Bribe / beg for mercy: only a hostile, bribe-taking ship bargains. A
    // ship actively attacking the player counts as hostile here even if its
    // politics are neutral (behavioral hostility), so the player can buy it
    // off just like a politically hostile one.
    if (disposition !== 'hostile' && !attackingPlayer) {
        return;
    }
    const aiType = target.components.get(NpcComponent)?.aiType;
    if (targetGovt?.flags2.noAssistOrMercy
        || !shipTakesBribes(targetGovt, aiType)) {
        return;
    }
    const credits = player.components.get(CreditsComponent);
    if (!credits) {
        return;
    }
    const amount = bribeAmount(credits.credits,
        !!targetGovt?.flags.largerBribes);
    if (amount <= 0 || credits.credits < amount) {
        return;
    }
    credits.credits -= amount;
    // Pacify the ship: forget the player as an aggressor and ignore them as a
    // hostile until the reprieve lapses (NpcDecisionSystem honors this).
    const npc = target.components.get(NpcComponent);
    if (npc) {
        const time = world.resources.get(TimeResource);
        npc.pacifiedFrom = found.uuid;
        npc.pacifiedUntil = (time?.time ?? 0) + BRIBE_PACIFY_MS;
        if (npc.aggressor === found.uuid) {
            npc.aggressor = undefined;
        }
        const tgt = target.components.get(TargetComponent);
        if (npc.mode === 'attack' && tgt?.target === found.uuid) {
            npc.mode = undefined;
            tgt.target = undefined;
        }
    }
}

/** Point-and-thrust steering toward a position (assist rendezvous). */
function steerToward(movement: MovementState,
    targetPos: { x: number, y: number }) {
    const toTarget = new Vector(targetPos.x - movement.position.x,
        targetPos.y - movement.position.y);
    movement.turnTo = toTarget.angle;
    movement.turnBack = false;
    movement.accelerating = toTarget.length > ASSIST_STANDOFF ? 1 : 0;
}

/**
 * Flies an assisting NPC to its client and, once alongside, restores the
 * client's armor, shields, and fuel to full (a disabled client then lifts its
 * DisabledComponent automatically next tick, via ShipDisableSystem's
 * armor-above-threshold exit) and releases the helper back to normal AI.
 * Runs after NpcSteeringSystem so its steering wins for the helper this tick.
 *
 * YIELDS TO A JUMP SEQUENCE, like every other movement writer in the sim
 * (FormationSystem, EscortCommandBehaviorSystem, NpcSteeringSystem all take
 * the same bail). A ship committed to a hyperspace jump is steered by
 * JumpSequenceSystem alone: it has to hold still for its spin-up and hold
 * its heading through the burn, and a second writer nudging turnTo and
 * accelerating would fight it. Theoretical today — an assisting ship has no
 * path into a jump sequence, since NpcDecisionSystem hands it to this system
 * and never reaches its depart/flee transitions — so this is consistency
 * insurance, bought for one Optional arg, against the next thing that can
 * put a JumpComponent on an arbitrary ship.
 */
export const AssistBehaviorSystem = new System({
    name: 'AssistBehaviorSystem',
    args: [AssistingComponent, MovementStateComponent, GetEntity,
        Optional(JumpComponent), Entities] as const,
    step(assisting, movement, entity, jump, entities) {
        if (jump) {
            // JumpSequenceSystem owns this ship's steering until it leaves.
            // The AssistingComponent is deliberately KEPT: a jump that is
            // cancelled (a disable) puts the helper straight back on its
            // errand rather than stranding its client waiting.
            return;
        }
        const client = entities.get(assisting.client);
        const clientMovement = client?.components.get(MovementStateComponent);
        if (!client || !clientMovement) {
            entity.components.delete(AssistingComponent);
            return;
        }
        const toClient = clientMovement.position.subtract(movement.position);
        if (toClient.length > ASSIST_ARRIVAL_RANGE) {
            steerToward(movement, clientMovement.position);
            return;
        }
        // Alongside: render assistance and depart.
        const armor = client.components.get(ArmorComponent);
        if (armor) {
            armor.current = armor.max;
        }
        const shield = client.components.get(ShieldComponent);
        if (shield) {
            shield.current = shield.max;
        }
        const fuel = client.components.get(FuelComponent);
        if (fuel) {
            fuel.current = fuel.max;
        }
        entity.components.delete(AssistingComponent);
    },
    after: [TimeSystem, NpcSteeringSystem],
    before: [MovementSystem],
});

export const HailPlugin: Plugin = {
    name: 'HailPlugin',
    build(world) {
        const serializer = world.resources.get(SerializerResource);
        serializer?.addComponent(AssistingComponent, AssistingType);
        world.addComponent(AssistingComponent);
        world.addSystem(AssistBehaviorSystem);
    },
};
