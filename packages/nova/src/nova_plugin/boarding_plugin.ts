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
    capturable, captureChance, CaptureBayCandidate, chooseCaptureBay,
    creditBooty, fuelTransferAmount, planAmmoPlunder, planCargoPlunder,
} from './boarding_component.js';
import { CargoComponent, cargoUsed } from './cargo_plugin.js';
import { CollisionHitterComponent } from './collision_interaction.js';
import { HurtboxHullComponent } from './collisions_plugin.js';
import { OutfitsState, OutfitsStateComponent } from './outfit_plugin.js';
import { WeaponsState, WeaponsStateComponent } from './weapons_state.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import {
    BayFighterComponent, CollectableEscortComponent, refundFighterToBay,
    ReturnComponent, ReturnWhenTargetRemovedComponent,
} from './bay_plugin.js';
import { DisabledComponent, isBelowDisableThreshold, repairedArmor } from './disabled_component.js';
import { EscortCommandComponent } from './escort_command.js';
import { OwnerComponent, SourceComponent } from './weapon_components.js';
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
 * The bay-capture shortcut's effect: the disabled hulk is STOWED in the
 * boarder's bay. One round is credited to the magazine — the same credit
 * refundFighterToBay gives a fighter that docks — and the hulk's entity is
 * removed from the world.
 *
 * WHY STOWED RATHER THAN DEPLOYED (Matthew's playtest ruling; the status
 * message has always said "Captured the X into your fighter bay"): the
 * shortcut used to mint the hulk into a DEPLOYED fighter flying formation
 * on its captor, which read to the player as "it just flies around" —
 * nothing was in the bay, and the ship the message named was still out
 * there. Stowing makes the message literally true, and it sidesteps the
 * stale-identity hazards a converted hulk carried (see convertToEscort).
 * Launching it again mints a fresh fighter from the bay's ship class, the
 * same as any other round in the magazine.
 *
 * WHAT IS LOST, inherently: the hulk's damage, outfits, cargo and name.
 * A bay round is not a ship — it is an ammo count — and a launched fighter
 * is built from the bay weapon's shipID with that class's stock loadout.
 * There is nowhere in the data model to keep a stowed ship's individual
 * state, so a captured fighter re-launches as a factory-fresh one.
 *
 * Returns false when the credit could not be made (the boarder holds no
 * ammo outfit that supplies this bay, so there is no magazine to credit).
 * The caller then leaves the hulk alone and falls through to the ordinary
 * boarding paths rather than deleting a ship for nothing. The gate's room
 * check (chooseCaptureBay) already guarantees the capacity half.
 */
function stowCaptureIntoBay(targetUuid: string, bayWeaponId: string,
    boarder: Entity, entities: EntityMap,
    gameData: SimulationGameDataInterface): boolean {
    if (!refundFighterToBay(boarder, bayWeaponId, gameData)) {
        return false;
    }
    entities.delete(targetUuid);
    return true;
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

        // A ship someone is plundering RIGHT NOW can't be boarded on top
        // of them. Treated as "nothing to board" for feedback purposes.
        // A hulk whose previous session has ended is boardable again —
        // that is what lets a repelled capture be retried (see
        // BoardedState); what it already gave up stays given up.
        //
        // The `active` flag is corroborated against the named boarder
        // rather than trusted on its own, so the lock is self-healing: a
        // boarder that was destroyed, jumped out, or landed mid-session
        // never runs its session-end path, and a bare flag would strand
        // the hulk unboardable for the rest of the game.
        const boarded = targetEntity?.components.get(BoardedComponent);
        const boarderStillAboard = boarded !== undefined
            && entities.get(boarded.boarder)?.components
                .get(BoardingComponent)?.target === targetUuid;
        if (boarded?.active && boarderStillAboard) {
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

        // A ship somebody is FLYING is never captured, by either route
        // (see capturable). Its pilot keeps command of it; the plunder
        // session below is still open to a pirate.
        const capturableTarget = capturable(targetEntity!);

        // 1. BAY CAPTURE. A hulk of a ship class one of the boarder's bays
        // launches, with room for it, is STOWED straight into that bay: no
        // session, no contest, no dialog, and — note for the rollback/replay
        // discipline — no draw from the seeded RandomResource, so pressing
        // 'board' on a bay-capturable hulk never shifts the PRNG sequence
        // for anything else.
        const targetShipId =
            targetEntity!.components.get(ShipComponent)?.id;
        const captureBay = targetShipId === undefined || !capturableTarget
            ? undefined
            : chooseCaptureBay(targetShipId, captureBayCandidates(
                uuid, boarderWeapons, boarderOutfits, entities, gameData));
        // The crime is read BEFORE the hulk leaves the world, and charged
        // only once the stow actually happened.
        const targetGovtId = targetEntity!.components.get(GovtComponent)?.id;
        if (captureBay !== undefined && stowCaptureIntoBay(
            targetUuid!, captureBay, entity, entities, gameData)) {
            applyBoardCrime(records, targetGovtId, gameData, govts);
            // The prize is gone from the world; leaving it selected would
            // point the HUD at an entity that no longer exists.
            target.target = undefined;
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

        // SEAM: boarding-mission offers are not implemented. Several përs
        // ships — the Drifting Derelicts among them — are authored to
        // offer a mission when boarded (mïsn AvailLoc "boarding ship"),
        // and nothing here consults the mission universe, so that offer
        // never appears. Capture is deliberately independent of it: a
        // derelict that fails to offer its mission (or whose mission the
        // player already holds) must still be capturable, which is what
        // the session bookkeeping below guarantees.
        //
        // Re-boarding a hulk resumes from what it has already given up:
        // the booty flags carry over so nothing can be taken twice (the
        // credits booty in particular is re-derived from the ship price
        // every time, so only this flag stops it being farmed). Capture
        // starts fresh at 'none' — that is the retry.
        const priorBoarded = boarded;
        entity.components.set(BoardingComponent, {
            target: targetUuid!,
            creditsAvailable: creditBooty(targetShipData!.price),
            ammoAvailable,
            cargoTaken: priorBoarded?.cargoTaken ?? false,
            creditsTaken: priorBoarded?.creditsTaken ?? false,
            fuelTaken: priorBoarded?.fuelTaken ?? false,
            ammoTaken: priorBoarded?.ammoTaken ?? false,
            capture: 'none',
            // Piracy is charged per session: a fresh boarding that takes
            // booty or tries a capture earns the BoardPenalty again.
            crimeApplied: false,
        });
        targetEntity!.components.set(BoardedComponent, {
            ...priorBoarded, boarder: uuid, active: true,
        });
        // Local boarding beep for the boarding player only.
        emit(PlayerSoundEvent, { id: BOARD_SOUND }, [uuid]);
    },
});

/**
 * Records a booty action on the HULK's durable BoardedComponent at the
 * moment that action applies, rather than when the session ends.
 *
 * WHY AT ACTION TIME. The durable flags are what stop a booty being taken
 * twice, and credits are the only booty that is not physically removed
 * from the victim (`creditsAvailable` is re-derived from the ship class
 * price by creditBooty on every board). Accumulating the flags only in
 * `endBoardingSession` meant every UNGRACEFUL end — the boarder is
 * destroyed, jumps out, or lands mid-session — left the hulk's
 * `creditsTaken` false while the credits were already banked. The stale-
 * boarder corroboration in BoardingGateSystem then re-opens boarding on
 * that hulk, and the money booty comes back: an unbounded credit farm of
 * "take credits, die/jump/land, board again". Writing the flag as the
 * transfer happens closes that for all four booties.
 *
 * The boarder's session-side flag is still set by the caller: it drives
 * the dialog's greying and the per-action idempotency under replayed
 * inputs. This is the DURABLE half.
 *
 * A hulk with no BoardedComponent (it should always have one — the gate
 * sets it when the session opens) gets a fresh one rather than silently
 * dropping the record.
 */
function markBootyTaken(target: Entity, boarderUuid: string,
    flag: 'cargoTaken' | 'creditsTaken' | 'fuelTaken' | 'ammoTaken'): void {
    const boarded = target.components.get(BoardedComponent);
    if (boarded) {
        boarded[flag] = true;
        return;
    }
    target.components.set(BoardedComponent,
        { boarder: boarderUuid, active: true, [flag]: true });
}

/**
 * Closes a plunder session without capturing: the boarder drops its
 * BoardingComponent and the hulk's BoardedComponent goes INACTIVE.
 *
 * The booty record is NOT written here — `markBootyTaken` has already
 * stamped each booty on the hulk as it was taken, so an ungraceful end
 * (boarder destroyed, jumped, or landed) loses nothing. All this path
 * still owns is releasing the mutual-exclusion lock.
 *
 * The hulk stays MARKED as boarded — the mission-goal seam
 * (mission_ship_state.ts shipBoarded) reads presence, not activity — but
 * it becomes boardable again, which is what makes a repelled capture
 * retryable. See BoardedState for why the booty flags must survive and
 * the capture state must not.
 */
function endBoardingSession(entity: Entity,
    target: Entity | undefined): void {
    entity.components.delete(BoardingComponent);
    const boarded = target?.components.get(BoardedComponent);
    if (!target || !boarded) {
        return;
    }
    target.components.set(BoardedComponent, { ...boarded, active: false });
}

/**
 * Turns a captured disabled hulk into the boarder's escort: it joins
 * the formation flock, hands its brain to the escort-command framework
 * (which suppresses its native hostile AI), shares the boarder's
 * firing group, sheds its government (so it reads as a neutral friendly
 * like a hired escort), and is patched back above its disable threshold
 * so it can fly. Mirrors the component set spawnHiredEscorts stamps
 * (browser.ts), applied to a live entity rather than a fresh one.
 *
 * IT MUST ALSO SHED THE HULL'S PREVIOUS IDENTITY, which is what the
 * playtest caught. Capture a ship that was itself somebody's BAY FIGHTER
 * — an NPC carrier's wing, the very class a player with a bay is likely
 * to be boarding — and the stamps above land on top of a live set of bay
 * components pointing at the OLD carrier. The result was a ship that was
 * an escort by some predicates and not by others:
 *
 *  - the returnToBay escort command believed the ship was bay-launched
 *    (stale ReturnWhenTargetRemovedComponent) and so DELETED its
 *    FormationComponent and flew it home to its old carrier
 *    (escort_command_plugin's returnToBay case, via startReturnHome);
 *  - with the formation link gone, both one-hop parent lookups fell
 *    through to the stale OwnerComponent — the old carrier — so the
 *    player could no longer command it (escortParent) and the target
 *    cycle stopped hiding it (flock.ts's flockParent, where
 *    OwnerComponent SHADOWS the firing group);
 *  - meanwhile FiringGroupComponent still named the player, so the
 *    player's own shots kept passing through it, and the durable
 *    PlayerEscort marker still labelled it an escort in the target pane.
 *    Exactly the "says it is my escort, but I can't command it and my
 *    weapons can't hit it" report.
 *  - a captured wing whose old carrier was already dead could also be
 *    retired out from under the player by OrphanedBayFighterSystem
 *    (bay_plugin), which deletes EscortCommandComponent and
 *    FormationComponent and sets the ship departing — it exempts ships
 *    marked PlayerEscortComponent, which is why that marker is now
 *    stamped HERE rather than a tick later by MarkPlayerEscortsSystem.
 *
 * So the bay identity is removed wholesale: the launch link
 * (BayFighterComponent / SourceComponent / OwnerComponent /
 * ReturnWhenTargetRemovedComponent) and any in-progress return home
 * (ReturnComponent / CollectableEscortComponent, which would otherwise
 * fly the prize back to its old carrier and let it be scooped up,
 * together with the CollisionHitter / HurtboxHull docking plumbing that
 * makes the scoop-up contact happen).
 * captureIntoBay's sibling path always overwrote these; this one used to
 * leave them.
 */
function convertToEscort(target: Entity,
    leaderUuid: string, leaderOwner: string | undefined,
    leaderControlled: boolean, entities: EntityMap): void {
    const slot = nextFormationSlot(formationsIn(entities), leaderUuid);
    target.components.set(FormationComponent, { leader: leaderUuid, slot });
    target.components.set(EscortCommandComponent, { command: 'formation' });
    target.components.set(FiringGroupComponent, { group: leaderUuid });
    target.components.delete(GovtComponent);
    target.components.delete(BoardedComponent);
    // The old owner's bay identity, in full.
    target.components.delete(BayFighterComponent);
    target.components.delete(SourceComponent);
    target.components.delete(OwnerComponent);
    target.components.delete(ReturnWhenTargetRemovedComponent);
    target.components.delete(ReturnComponent);
    target.components.delete(CollectableEscortComponent);
    // ...including the DOCKING PLUMBING startReturnHome stamps alongside
    // those two. A returning fighter is made to physically hit its carrier
    // (CollisionHitter `return_escorts`, plus a Hurtbox hull copied from
    // its hitbox) so that the contact fires CollectableEscortAI. Neither
    // belongs on a captured prize.
    //
    // SAFE TO SHED WHOLESALE on a ship: an ordinary ship is the VICTIM
    // side of a collision, carrying HitboxHull + CollisionVulnerability
    // (ship_plugin/collisions_plugin provide those and will re-provide
    // them). The hitter side is for things that DO the hitting —
    // projectiles, beams, asteroids, and a fighter flying home — and on a
    // ship hull startReturnHome is the only thing that stamps it. Note
    // this is the returning-fighter role only: a captured CARRIER's own
    // CollisionVulnerability may legitimately list `return_escorts` (its
    // own wing has to be able to dock), and that is left alone.
    target.components.delete(CollisionHitterComponent);
    target.components.delete(HurtboxHullComponent);
    // A landing order aimed at its old owner's stellar is meaningless now.
    target.components.delete(EscortLandingComponent);
    if (leaderOwner !== undefined) {
        target.components.set(MultiplayerData, { owner: leaderOwner });
    }
    // Durable ownership, stamped immediately (as captureIntoBay always
    // did) rather than waiting for MarkPlayerEscortsSystem's next pass:
    // the one-tick window where the prize carried no marker is the window
    // OrphanedBayFighterSystem used to retire it in. Only a
    // player-controlled captor can name a player; for anything else the
    // marking system decides.
    if (leaderControlled) {
        target.components.set(PlayerEscortComponent,
            { player: leaderUuid, parent: leaderUuid });
    }
    // Clear leftover hostility so a reverted-to-NPC escort (leader lost)
    // isn't still gunning for the ex-owner. The MODE goes with it: a
    // prize whose old carrier died was already retired to 'depart' by
    // OrphanedBayFighterSystem, and an escort that inherited that mode
    // would fly itself out of the system the moment its escort command
    // ever lapsed. Cleared (rather than set to some other mode) is the
    // resting value a freshly spawned NPC has; nothing rolls a new one
    // while the ship holds an EscortCommandComponent, so this consumes no
    // randomness.
    const npc = target.components.get(NpcComponent);
    if (npc) {
        npc.aggressor = undefined;
        npc.mode = undefined;
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
            endBoardingSession(entity, target);
            return;
        }

        // Take the captured ship as an escort (capture-assignment
        // dialog). Ends the session. The `capturable` re-check is
        // belt-and-braces: capture can never REACH 'succeeded' against a
        // flown ship, but a hull that somehow became controlled between
        // the roll and the assignment must not be converted either — that
        // half-owned chimera is the whole bug.
        if (controls.get('plunderCaptureEscort') === 'start'
            && boarding.capture === 'succeeded' && capturable(target)) {
            const owner = entity.components.get(MultiplayerData)?.owner;
            convertToEscort(target, uuid, owner,
                entity.components.has(ControlledByComponent), entities);
            boarding.capture = 'assigned';
            entity.components.delete(BoardingComponent);
            return;
        }

        // The remaining actions need the victim to still be a boardable
        // hulk; a repair or a stray killing blow ends the session.
        if (!target.components.has(DisabledComponent)) {
            endBoardingSession(entity, target);
            return;
        }

        if (controls.get('plunderCargo') === 'start' && !boarding.cargoTaken) {
            boarding.cargoTaken = true;
            markBootyTaken(target, uuid, 'cargoTaken');
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
            markBootyTaken(target, uuid, 'creditsTaken');
            credits.credits += boarding.creditsAvailable;
            chargeCrime();
        }

        if (controls.get('plunderFuel') === 'start' && !boarding.fuelTaken) {
            boarding.fuelTaken = true;
            markBootyTaken(target, uuid, 'fuelTaken');
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
            markBootyTaken(target, uuid, 'ammoTaken');
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

        // The capture contest. A ship somebody is flying is never
        // capturable (see `capturable`), and the roll is skipped ENTIRELY
        // for one — no draw from the seeded RandomResource, so the draw
        // count stays identical on every peer and across resimulation
        // (the predicate is synced state, so every peer skips together).
        // The dialog greys the button off the same predicate, so pressing
        // it is only reachable by a hand-sent control input.
        if (controls.get('plunderCapture') === 'start'
            && boarding.capture !== 'succeeded' && capturable(target)) {
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
