import * as t from 'io-ts';
import { GovtData } from 'novadatainterface/govt_data';
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
    captureChance, CaptureBayCandidate, chooseCaptureBay, creditBooty,
    fuelTransferAmount, planAmmoPlunder, planCargoPlunder,
} from './boarding_component.js';
import { CargoComponent, cargoUsed } from './cargo_plugin.js';
import { OutfitsState, OutfitsStateComponent } from './outfit_plugin.js';
import { WeaponsState, WeaponsStateComponent } from './weapons_state.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import {
    BayFighterComponent, ReturnWhenTargetRemovedComponent,
} from './bay_plugin.js';
import { CollisionVulnerabilityComponent } from './collision_interaction.js';
import { DisabledComponent, isBelowDisableThreshold, repairedArmor } from './disabled_component.js';
import { EscortCommandComponent } from './escort_command.js';
import { OwnerComponent, SourceComponent } from './fire_weapon_plugin.js';
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
import {
    EscortLandingComponent, PlayerEscortComponent,
} from './player_escort.js';
import { CreditsComponent } from './player_state_plugin.js';
import { applyCrime, LegalRecords } from './reputation.js';
import { GovtsResource, LegalRecordsComponent } from './reputation_plugin.js';
import {
    ControlledByComponent, ShipControlEvent, ShipControlStateComponent,
} from './ship_control.js';
import {
    ShipComponent, ShipDataComponent, ShipPhysicsComponent,
} from './ship_plugin.js';
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
 * Emitted (targeted at the boarding ship) when the bay-capture shortcut
 * takes a disabled ship straight into one of the boarder's fighter bays:
 * no plunder session, no capture contest, no dialog — so this event is
 * the ONLY feedback the player gets. Carries the captured ship's class id
 * so the display can name it ("Captured the Viper into your fighter
 * bay."); the sim never reads it back. Consumed display-side by the
 * status line (status_message_plugin.ts).
 */
export const BayCaptureEvent =
    new EcsEvent<{ shipId: string }>('BayCaptureEvent');
export const BayCaptureEventType = t.type({ shipId: t.string });
registerSimulationBridgeEvent({ event: BayCaptureEvent });

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
 * Charges the BoardPenalty crime ("board") against the victim's
 * government. Shared by the plunder session's once-per-session charge and
 * by the bay-capture shortcut, so a capture carries exactly the same legal
 * consequence however it happened. A victim with no government (your own
 * escorts, and anything already stripped of its GovtComponent) is a no-op.
 */
function applyBoardCrime(records: LegalRecords | undefined,
    govtId: string | undefined, gameData: SimulationGameDataInterface,
    govts: Iterable<readonly [string, GovtData]> | undefined): void {
    if (!records || !govtId) {
        return;
    }
    const govtData = gameData.data.Govt.getCached(govtId);
    if (govtData) {
        applyCrime(records, govtData, 'board', govts ?? []);
    }
}

/**
 * Brings a disabled hulk back online: armor to just above its disable
 * threshold (`repairedArmor`, the established threshold + 10% margin used
 * by self-repair, the hail assist, and capture), shields to full, and
 * DisabledComponent dropped so DisabledMovementSystem stops braking it and
 * the formation/escort brains can steer it again.
 *
 * Matthew's spec words item 5 as "its minimum un-disabled armor value",
 * which taken literally is the threshold itself with no margin. The margin
 * is kept deliberately: a ship parked exactly AT the threshold satisfies
 * `isBelowDisableThreshold` (the comparison is <=), so it would be
 * re-disabled by ShipDisableSystem on the next tick, and every other
 * repair path in the game already uses the margin.
 */
function repairHulk(target: Entity): void {
    const shipData = target.components.get(ShipDataComponent);
    const armor = target.components.get(ArmorComponent);
    if (armor && shipData
        && isBelowDisableThreshold(armor, shipData.disableArmorFraction)) {
        armor.current = repairedArmor(armor.max, shipData.disableArmorFraction);
    }
    const shield = target.components.get(ShieldComponent);
    if (shield) {
        shield.current = shield.max;
    }
    target.components.delete(DisabledComponent);
}

/**
 * The boarder's mounted bay weapons, described for the bay-capture
 * shortcut (see CaptureBayCandidate). Everything here is read off synced
 * simulation state — the boarder's WeaponsState and magazine, and the live
 * entity map — plus static game data, so every peer builds the same list.
 *
 * Deployed fighters are counted straight from the entity map: a live
 * entity is one of this bay's deployed fighters when its
 * BayFighterComponent names this bay AND its SourceComponent is the
 * boarder. That is a count, so entity iteration order cannot change it.
 *
 * The `getCached` reads are legitimate under the determinism rule (a
 * getCached MISS must never change what the simulation does): entity
 * staging loads a ship's outfits, those outfits' weapons — bays included,
 * recursively with the fighter ship classes they launch — and the outfit
 * data itself before the entity is ever inserted (loadEntityGameData /
 * loadShipGameData), so on every peer a MOUNTED bay's wëap and its ammo
 * outfits are already cached. This is the same staging guarantee
 * ammoPlunderInputs relies on.
 */
function captureBayCandidates(boarderUuid: string,
    boarderWeapons: WeaponsState | undefined,
    boarderOutfits: OutfitsState | undefined,
    entities: EntityMap,
    gameData: SimulationGameDataInterface): CaptureBayCandidate[] {
    if (!boarderWeapons) {
        return [];
    }
    const candidates: CaptureBayCandidate[] = [];
    for (const [weaponId, state] of boarderWeapons) {
        if (state.count <= 0) {
            continue;
        }
        const weapon = gameData.data.Weapon.getCached(weaponId);
        if (weapon?.type !== 'BayWeaponData') {
            continue;
        }
        let held = 0;
        for (const [outfitId, outfitState] of boarderOutfits ?? []) {
            if (gameData.data.Outfit.getCached(outfitId)?.ammoFor
                === weaponId) {
                held += outfitState.count;
            }
        }
        let deployed = 0;
        for (const [, other] of entities) {
            if (other.components.get(BayFighterComponent)?.bayWeaponId
                === weaponId
                && other.components.get(SourceComponent) === boarderUuid) {
                deployed++;
            }
        }
        candidates.push({
            bayWeaponId: weaponId,
            shipId: weapon.shipID,
            maxAmmo: weapon.maxAmmo,
            mounted: state.count,
            held,
            deployed,
        });
    }
    return candidates;
}

/**
 * Who a repaired former escort should hold formation on: its own live
 * leader if it still has one, else the carrier it was last attached to
 * (PlayerEscort.parent — so a carrier escort's wing goes back to the
 * carrier rather than being promoted to a direct escort), else the boarder.
 * Every candidate must be a live ship that is the boarder or inside the
 * boarder's flock, so a stale link can never re-attach the ship to
 * somebody else's leader.
 */
function escortLeaderFor(target: Entity, targetUuid: string,
    boarderUuid: string, entities: EntityMap): string {
    const usable = (candidate: string | undefined): candidate is string =>
        candidate !== undefined && candidate !== targetUuid
        && entities.has(candidate)
        && (candidate === boarderUuid
            || isInFlock(candidate, boarderUuid, u => entities.get(u)));
    const leader = target.components.get(FormationComponent)?.leader;
    if (usable(leader)) {
        return leader;
    }
    const parent = target.components.get(PlayerEscortComponent)?.parent;
    if (usable(parent)) {
        return parent;
    }
    return boarderUuid;
}

/**
 * Puts a repaired escort back to work: formation link, the default
 * 'formation' command, and the player's firing group — the same stamps
 * EscortReattachSystem applies when a player returns to the world, and the
 * same set convertToEscort applies to a fresh capture.
 *
 * Needed because a FORMER escort's live chain can have lapsed in ways
 * EscortReattachSystem will not fix on its own: it only re-attaches an
 * escort whose `detached` flag is set (i.e. one whose player left the
 * world). A fighter orphaned by its carrier escort dying, with the player
 * present the whole time, keeps its durable PlayerEscortComponent but
 * never gets a new formation link.
 *
 * An existing link to the SAME leader keeps its slot (no free station
 * shuffle); anything else gets the next free slot.
 */
function reattachEscort(target: Entity, leaderUuid: string,
    playerUuid: string, entities: EntityMap): void {
    const formation = target.components.get(FormationComponent);
    target.components.set(FormationComponent, {
        leader: leaderUuid,
        slot: formation?.leader === leaderUuid ? formation.slot
            : nextFormationSlot(formationsIn(entities), leaderUuid),
    });
    target.components.set(EscortCommandComponent, { command: 'formation' });
    target.components.set(FiringGroupComponent, { group: playerUuid });
    // A landing order aimed at a stellar is meaningless now that the ship
    // is back in formation (EscortReattachSystem drops it for the same
    // reason).
    target.components.delete(EscortLandingComponent);
    const owned = target.components.get(PlayerEscortComponent);
    if (owned?.detached) {
        owned.detached = false;
    }
}

/**
 * The bay-capture shortcut's effect: the disabled hulk becomes one of the
 * boarder's DEPLOYED bay fighters, stamped exactly like one the bay had
 * launched itself (BayWeaponEntry.fire) — so every downstream system
 * (escort commands, the returnToBay flow, CollectableEscortAI's docking
 * refund, the outfitter's deployed-fighter accounting, the landed roster)
 * treats it as native.
 *
 * The magazine is deliberately NOT credited here: the fighter is deployed,
 * not stowed. Docking it later runs refundFighterToBay, and the room check
 * in the gate (chooseCaptureBay) is what guarantees that refund will fit —
 * which is what makes the capture permanent.
 */
function captureIntoBay(target: Entity, bayWeaponId: string,
    boarder: Entity, boarderUuid: string, entities: EntityMap): void {
    repairHulk(target);

    // The owner-chain root, derived the way a bay launch derives it
    // (fire_weapon_plugin's fireFromEntity: the firer's OwnerComponent,
    // falling back to the firer itself).
    const ownerRoot =
        boarder.components.get(OwnerComponent)?.owner ?? boarderUuid;
    target.components.set(OwnerComponent, { owner: ownerRoot });
    target.components.set(SourceComponent, boarderUuid);
    target.components.set(BayFighterComponent, { bayWeaponId });
    target.components.set(ReturnWhenTargetRemovedComponent, undefined);

    // Escort stamps. FiringGroup follows stampFiringGroup: the boarder's
    // own group if it has one, else the owner-chain root. The govt half of
    // that helper is deliberately skipped — it rides WEAPON entities only,
    // and this is a ship (see firing_group.ts).
    target.components.set(FormationComponent, {
        leader: boarderUuid,
        slot: nextFormationSlot(formationsIn(entities), boarderUuid),
    });
    target.components.set(EscortCommandComponent, { command: 'formation' });
    target.components.set(FiringGroupComponent, {
        group: boarder.components.get(FiringGroupComponent)?.group ?? ownerRoot,
    });
    target.components.delete(GovtComponent);
    target.components.delete(BoardedComponent);
    target.components.delete(EscortLandingComponent);
    const owner = boarder.components.get(MultiplayerData)?.owner;
    if (owner !== undefined) {
        target.components.set(MultiplayerData, { owner });
    }
    // Durable ownership, stamped here rather than waiting for
    // MarkPlayerEscortsSystem's next pass (which would reach the same
    // answer off the chain above). Only a player-controlled boarder can
    // name a player: for anything else the marking system decides.
    if (boarder.components.has(ControlledByComponent)) {
        target.components.set(PlayerEscortComponent,
            { player: boarderUuid, parent: boarderUuid });
    }
    // Clear leftover hostility and targeting, exactly as convertToEscort
    // does, so the new fighter isn't still gunning for its captor.
    const npc = target.components.get(NpcComponent);
    if (npc) {
        npc.aggressor = undefined;
    }
    const targetTarget = target.components.get(TargetComponent);
    if (targetTarget) {
        targetTarget.target = undefined;
    }

    // The carrier must be dockable, or the new fighter could never come
    // home and bank itself (bay_plugin's fire does the same).
    boarder.components.get(CollisionVulnerabilityComponent)
        ?.vulnerableTo.add('return_escorts');
}

/**
 * The 'board' key. With a disabled ship selected and the boarder pulled
 * alongside (close, matched speed, axis-aligned), one of three things
 * happens, in this precedence order:
 *
 *  1. BAY CAPTURE (Matthew's item 6). The hulk is a ship class one of the
 *     boarder's bays launches, and that bay has room: it is captured
 *     instantly into the bay as a deployed fighter — no session, no
 *     contest, no dialog, no PRNG draw. This deliberately OVERRIDES the
 *     repair path below, so a disabled fighter of your own that fits with
 *     room is re-adopted by the bay rather than merely patched up.
 *  2. OWN-ESCORT REPAIR (item 5). The hulk is in the boarder's live flock
 *     OR durably marked as the boarder's escort (PlayerEscortComponent —
 *     the "former escort" case, whose live chain lapsed while it was
 *     disabled, landed, or orphaned): it is repaired in place and put back
 *     to work in formation. No plunder session.
 *  3. PLUNDER. Anything else opens the normal plunder session.
 *
 * A session already open, or a target already being boarded, is left alone.
 */
const BoardingGateSystem = new System({
    name: 'BoardingGateSystem',
    events: [ShipControlEvent] as const,
    args: [ShipControlStateComponent, MovementStateComponent,
        ShipDataComponent, TargetComponent, Optional(BoardingComponent),
        Optional(OutfitsStateComponent), Optional(WeaponsStateComponent),
        Optional(LegalRecordsComponent), Optional(GovtsResource),
        GetEntity, UUID, Entities, SimulationGameDataResource, Emit] as const,
    step(controls, movement, _shipData, target, boarding, boarderOutfits,
        boarderWeapons, records, govts, entity, uuid, entities, gameData,
        emit) {
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

        // 1. BAY CAPTURE. A hulk of a ship class one of the boarder's bays
        // launches, with room for it, is taken straight into that bay as a
        // deployed fighter: no session, no contest, no dialog, and — note
        // for the rollback/replay discipline — no draw from the seeded
        // RandomResource, so pressing 'board' on a bay-capturable hulk
        // never shifts the PRNG sequence for anything else.
        const targetShipId =
            targetEntity!.components.get(ShipComponent)?.id;
        const captureBay = targetShipId === undefined ? undefined
            : chooseCaptureBay(targetShipId, captureBayCandidates(
                uuid, boarderWeapons, boarderOutfits, entities, gameData));
        if (captureBay !== undefined) {
            // The same crime the plunder session charges for a capture,
            // read BEFORE the hulk sheds its government.
            applyBoardCrime(records,
                targetEntity!.components.get(GovtComponent)?.id, gameData,
                govts);
            captureIntoBay(targetEntity!, captureBay, entity, uuid, entities);
            emit(BayCaptureEvent, { shipId: targetShipId! }, [uuid]);
            return;
        }

        // 2. Boarding your OWN disabled escort (a hired or captured escort,
        // or one of your bay fighters) does NOT plunder it: it repairs it
        // in place and puts it back to work. The boarding gate above still
        // applies (close, slow, axis-aligned).
        //
        // Two ways to qualify, deliberately belt-and-braces: the live flock
        // chain reaches the boarder (isInFlock), or the durable ownership
        // marker names the boarder (PlayerEscortComponent — a FORMER
        // escort, whose live chain lapsed while it sat disabled through a
        // landing round trip, a jump it could not follow, or the death of
        // the carrier escort it flew from).
        //
        // A fighter boarding on the player's behalf is NOT covered: only
        // the boarder itself is compared against, never the boarder's flock
        // root. Boarding is player-initiated (this system only ever runs
        // off a player's control events), so the boarder IS the player
        // ship; widening it would need a flock-root walk for a case that
        // cannot arise today.
        const owned = targetEntity!.components.get(PlayerEscortComponent);
        if (isInFlock(targetUuid!, uuid, u => entities.get(u))
            || owned?.player === uuid) {
            repairHulk(targetEntity!);
            // It was an escort, so it goes back to being one: formation
            // link, default command, player's firing group. Cheap and
            // idempotent for a ship whose links never lapsed.
            reattachEscort(targetEntity!,
                escortLeaderFor(targetEntity!, targetUuid!, uuid, entities),
                uuid, entities);
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
            applyBoardCrime(records,
                target?.components.get(GovtComponent)?.id, gameData, govts);
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
        world.resources.get(SerializerResource)?.addEvent(
            BayCaptureEvent, BayCaptureEventType);

        world.addSystem(BoardingGateSystem);
        world.addSystem(BoardingActionSystem);
    },
    remove(world) {
        world.removeSystem(BoardingGateSystem);
        world.removeSystem(BoardingActionSystem);
    },
};
