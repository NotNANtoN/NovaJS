import 'jasmine';
import { MockGameData } from 'novadatainterface/mock_game_data';
import { getDefaultGovtData } from 'novadatainterface/govt_data';
import { getDefaultOutfitData } from 'novadatainterface/outfit_data';
import {
    getDefaultShipData, getDefaultShipPhysics, ShipData,
} from 'novadatainterface/ship_data';
import { BayWeaponData, getDefaultBayWeaponData } from 'novadatainterface/weapon_data';
import { Angle, Vector } from 'nova_ecs/datatypes/vector';
import { Position } from 'nova_ecs/datatypes/position';
import { Entity } from 'nova_ecs/entity';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { RandomResource } from 'nova_ecs/plugins/random_plugin';
import { World } from 'nova_ecs/world';
import { UUID } from 'nova_ecs/arg_types';
import { System } from 'nova_ecs/system';
import { getIntegrationGameData } from '../communication/simulation_test_fixture.js';
import { BayCaptureEvent, EscortRepairedEvent } from './boarding_plugin.js';
import { BoardedComponent, BoardingComponent } from './boarding_component.js';
import {
    BayFighterComponent, CollectableEscortComponent, ReturnComponent,
    ReturnWhenTargetRemovedComponent, startReturnHome,
} from './bay_plugin.js';
import { CollisionHitterComponent } from './collision_interaction.js';
import { HurtboxHullComponent } from './collisions_plugin.js';
import { isBelowDisableThreshold } from './disabled_component.js';
import { CargoComponent } from './cargo_plugin.js';
import {
    CollisionEvent, CollisionVulnerabilityComponent,
} from './collision_interaction.js';
import { DisabledComponent } from './disabled_component.js';
import { completeEntity } from './entity_data_loader.js';
import { EscortCommandComponent } from './escort_command.js';
import { escortParent } from './escort_command_plugin.js';
import { OwnerComponent, SourceComponent } from './fire_weapon_plugin.js';
import { FiringGroupComponent } from './firing_group.js';
import { isInFlock } from './flock.js';
import { GovtComponent } from './govt_component.js';
import { ArmorComponent, FuelComponent, ShieldComponent } from './health_plugin.js';
import { makeShip } from './make_ship.js';
import { makeSystem } from './make_system.js';
import { FormationComponent, NpcComponent } from './npc_ai_plugin.js';
import { OutfitsStateComponent } from './outfit_plugin.js';
import { PlayerEscortComponent } from './player_escort.js';
import { CreditsComponent } from './player_state_plugin.js';
import { LegalRecordsComponent } from './reputation_plugin.js';
import {
    ControlledByComponent, ShipControlEvent, ShipControlStateComponent,
} from './ship_control.js';
import { ShipComponent, ShipDataComponent } from './ship_plugin.js';
import { TargetComponent } from './target_component.js';
import { WeaponsStateComponent } from './weapons_state.js';

const BOARDER = 'boarder';
const SECOND_BOARDER = 'boarder2';
const TARGET = 'target';

/**
 * Live-world boarding against the real simulation stack (mirrors
 * disabled_plugin_test): a controlled boarder pulled alongside a
 * disabled target in an asteroid-free, traffic-free system.
 */
describe('boarding in a live world', () => {
    async function boardingWorld({
        aligned = true,
        distance = 100,
        boarderCrew = 200,
        targetCrew = 4,
        targetFuel = 30,
        cargo = new Map<string, number>([['cargo:0', 2]]),
    } = {}) {
        const gameData = await getIntegrationGameData();
        const world = await makeSystem('nova:226', gameData, 'worker',
            { npcs: false });
        const shipData = (await gameData.data.Ship.get('nova:128'))!;

        const boarder = makeShip(shipData);
        boarder.components.set(MovementStateComponent, {
            position: new Position(0, 0), velocity: new Vector(0, 0),
            rotation: new Angle(0), turning: 0, turnBack: false,
            accelerating: 0,
        });
        boarder.components.set(CreditsComponent, { credits: 0 });
        boarder.components.set(LegalRecordsComponent, new Map());

        const target = makeShip(shipData);
        target.components.set(MovementStateComponent, {
            position: new Position(distance, 0), velocity: new Vector(0, 0),
            rotation: new Angle(aligned ? 0 : Math.PI / 2), turning: 0,
            turnBack: false, accelerating: 0,
        });
        target.components.set(GovtComponent, { id: 'nova:128' });

        await completeEntity(world, boarder);
        await completeEntity(world, target);
        world.entities.set(BOARDER, boarder);
        world.entities.set(TARGET, target);
        world.step();

        // Crew overrides (real ship data may have too little crew for a
        // deterministic gate / capture). Clone so the shared cached
        // ShipData isn't mutated. Applied after the provide step so the
        // ShipDataProvider doesn't overwrite them.
        boarder.components.set(ShipDataComponent,
            { ...boarder.components.get(ShipDataComponent)!, crew: boarderCrew });
        target.components.set(ShipDataComponent,
            { ...target.components.get(ShipDataComponent)!, crew: targetCrew });

        // Cargo/fuel booty on the target.
        target.components.set(CargoComponent, new Map(cargo));
        const tf = target.components.get(FuelComponent)!;
        tf.current = targetFuel;
        const bf = boarder.components.get(FuelComponent)!;
        bf.current = 0;

        // Point the boarder at the target and disable the target.
        boarder.components.get(TargetComponent)!.target = TARGET;
        damageToFraction(target, 0.33);
        world.step();

        return { world, boarder, target, gameData };
    }

    function damageToFraction(ship: Entity, fraction: number) {
        const armor = ship.components.get(ArmorComponent)!;
        armor.current = fraction * armor.max;
        const shield = ship.components.get(ShieldComponent);
        if (shield) {
            shield.current = 0;
        }
    }

    function press(world: World, uuid: string, action: string) {
        const entity = world.entities.get(uuid)!;
        entity.components.set(ShipControlStateComponent,
            new Map([[action, 'start']]) as any);
        world.emit(ShipControlEvent, undefined, [uuid]);
        world.step();
    }

    it('disables the target before a board is possible', async () => {
        const { target } = await boardingWorld();
        expect(target.components.has(DisabledComponent)).toBeTrue();
    });

    it('opens a plunder session when aligned, close, and slow', async () => {
        const { world, boarder, target } = await boardingWorld();
        press(world, BOARDER, 'board');
        const boarding = boarder.components.get(BoardingComponent);
        expect(boarding?.target).toEqual(TARGET);
        expect(target.components.has(BoardedComponent)).toBeTrue();
    });

    it('rejects a perpendicular boarder (axis gate)', async () => {
        const { world, boarder } = await boardingWorld({ aligned: false });
        press(world, BOARDER, 'board');
        expect(boarder.components.has(BoardingComponent)).toBeFalse();
    });

    it('rejects a boarder that is too far away', async () => {
        const { world, boarder } = await boardingWorld({ distance: 1000 });
        press(world, BOARDER, 'board');
        expect(boarder.components.has(BoardingComponent)).toBeFalse();
    });

    it('takes cargo, credits, and fuel and charges the board crime',
        async () => {
            const { world, boarder, target } = await boardingWorld();
            const price = target.components.get(ShipDataComponent)!.price;
            press(world, BOARDER, 'board');

            press(world, BOARDER, 'plunderCargo');
            expect(boarder.components.get(CargoComponent)!.get('cargo:0'))
                .toEqual(2);
            expect(target.components.get(CargoComponent)!.get('cargo:0'))
                .toBeUndefined();

            press(world, BOARDER, 'plunderCredits');
            expect(boarder.components.get(CreditsComponent)!.credits)
                .toEqual(Math.floor(price * 0.10));

            press(world, BOARDER, 'plunderFuel');
            expect(boarder.components.get(FuelComponent)!.current)
                .toBeGreaterThanOrEqual(30);
            expect(target.components.get(FuelComponent)!.current).toEqual(0);

            // Pirating charged the BoardPenalty against the victim's govt.
            const record = boarder.components.get(LegalRecordsComponent)!
                .get('nova:128');
            expect(record).toBeLessThan(0);
        });

    it('does not double-take cargo on a repeated press', async () => {
        const { world, boarder, target } = await boardingWorld({
            cargo: new Map([['cargo:0', 2]]),
        });
        press(world, BOARDER, 'board');
        press(world, BOARDER, 'plunderCargo');
        // Refill the victim; a repeat press must not take again.
        target.components.set(CargoComponent, new Map([['cargo:0', 5]]));
        press(world, BOARDER, 'plunderCargo');
        expect(boarder.components.get(CargoComponent)!.get('cargo:0'))
            .toEqual(2);
    });

    /** Runs the whole capture flow and takes the prize as an escort. */
    function captureAsEscort(world: World, boarder: Entity) {
        press(world, BOARDER, 'board');
        // Attempt capture until it lands (chance is clamped to 0.95).
        for (let i = 0; i < 20
            && boarder.components.get(BoardingComponent)?.capture
            !== 'succeeded'; i++) {
            press(world, BOARDER, 'plunderCapture');
        }
        expect(boarder.components.get(BoardingComponent)?.capture)
            .toEqual('succeeded');
        press(world, BOARDER, 'plunderCaptureEscort');
    }

    /**
     * Matthew's LAN playtest, bug 3: "I captured a ship that I didn't have
     * space for in my bay ... normal capture dialogue ... but then when I
     * commanded it, it became not my escort anymore. Says it is and hails
     * like it is, but I can't command it, and it targets like a normal
     * ship. Can't hit them with my weapons, though."
     *
     * The prize in that story was a ship of a class his bay launches — i.e.
     * an NPC carrier's WING — taken through the plunder dialog because the
     * bay had no room. convertToEscort stamped the escort set on top of the
     * hull's still-live bay identity, and the escort commands then acted on
     * the stale half: returnToBay believed the ship was bay-launched, so it
     * deleted the formation link and flew the prize home to its old
     * carrier. With the formation link gone, both one-hop parent lookups
     * fell through to the stale OwnerComponent (the old carrier), which is
     * simultaneously why the player could not command it (escortParent) and
     * why the target cycle stopped hiding it (flockParent — OwnerComponent
     * shadows the firing group) — while the firing group still named the
     * player, so the player's shots kept passing through.
     *
     * These specs pin all four "is this my escort" predicates together
     * after EVERY command, since the bug was precisely them disagreeing.
     */
    describe('a captured wing stays a whole escort under every command',
        () => {
            const OLD_CARRIER = 'old carrier';
            const VICTIM = 'some third party';

            /**
             * A disabled NPC ship wearing a bay fighter's full identity
             * (launch link, owner chain, return-home marker), captured
             * through the plunder dialog.
             */
            async function capturedWingWorld({ carrierAlive = true } = {}) {
                const ctx = await boardingWorld({ boarderCrew: 500,
                    targetCrew: 1 });
                const { world, boarder, target } = ctx;
                // A player-controlled captor, as any real boarding is.
                boarder.components.set(ControlledByComponent,
                    { peerId: 'test peer' });
                if (carrierAlive) {
                    const carrier = new Entity();
                    carrier.components.set(ShipComponent, { id: 'nova:128' });
                    world.entities.set(OLD_CARRIER, carrier);
                }
                // Something for an 'attack' order to be aimed at.
                const victim = new Entity();
                victim.components.set(ShipComponent, { id: 'nova:128' });
                victim.components.set(MovementStateComponent, {
                    position: new Position(3000, 0), velocity: new Vector(0, 0),
                    rotation: new Angle(0), turning: 0, turnBack: false,
                    accelerating: 0,
                });
                world.entities.set(VICTIM, victim);
                // The hull's bay identity, exactly as bay_plugin's launch
                // stamps it.
                target.components.set(OwnerComponent, { owner: OLD_CARRIER });
                target.components.set(SourceComponent, OLD_CARRIER);
                target.components.set(BayFighterComponent,
                    { bayWeaponId: 'nova:some bay' });
                target.components.set(ReturnWhenTargetRemovedComponent,
                    undefined);
                world.step();

                captureAsEscort(world, boarder);
                return ctx;
            }

            /** Every "is this my escort" predicate, read at once. */
            function escortPredicates(world: World, target: Entity) {
                const getEntity = (u: string) => world.entities.get(u);
                return {
                    // Commandable by the player (escort_command_plugin).
                    commandableBy: escortParent(target),
                    // Flock membership: the target-cycle exclusion, the
                    // escort cycle, and the friendly corners (flock.ts).
                    inFlock: isInFlock(TARGET, BOARDER, getEntity),
                    // Friendly fire passes through (firing_group.ts).
                    firingGroup:
                        target.components.get(FiringGroupComponent)?.group,
                    // The hail dialog's one-hop predicate.
                    hailsAsEscort:
                        (target.components.get(FormationComponent)?.leader
                            ?? target.components.get(OwnerComponent)?.owner)
                        === BOARDER,
                };
            }

            it('is a consistent escort the moment it is captured',
                async () => {
                    const { world, target } = await capturedWingWorld();
                    expect(escortPredicates(world, target)).toEqual({
                        commandableBy: BOARDER, inFlock: true,
                        firingGroup: BOARDER, hailsAsEscort: true,
                    });
                    // The old owner's identity is gone, not layered under
                    // the new one.
                    expect(target.components.has(OwnerComponent)).toBeFalse();
                    expect(target.components.has(SourceComponent)).toBeFalse();
                    expect(target.components.has(BayFighterComponent))
                        .toBeFalse();
                    expect(target.components
                        .has(ReturnWhenTargetRemovedComponent)).toBeFalse();
                    // Durable ownership is stamped at once, not a tick
                    // later, so nothing can retire it in between.
                    expect(target.components.get(PlayerEscortComponent))
                        .toEqual({ player: BOARDER, parent: BOARDER });
                });

            for (const command of ['attack', 'defend', 'formation',
                'holdPosition', 'returnToBay']) {
                it(`stays a consistent escort after '${command}'`,
                    async () => {
                        const { world, boarder, target } =
                            await capturedWingWorld();
                        boarder.components.get(TargetComponent)!.target =
                            VICTIM;

                        press(world, BOARDER, command);
                        world.step();
                        world.step();

                        expect(escortPredicates(world, target)).toEqual({
                            commandableBy: BOARDER, inFlock: true,
                            firingGroup: BOARDER, hailsAsEscort: true,
                        });
                    });
            }

            it('stays out of the normal target cycle after returnToBay',
                async () => {
                    // The symptom that made the divergence visible: the
                    // prize reappeared in the tab cycle.
                    const { world, boarder, target } =
                        await capturedWingWorld();
                    expect(target.components.has(DisabledComponent))
                        .toBeFalse();

                    press(world, BOARDER, 'returnToBay');
                    world.step();
                    boarder.components.get(TargetComponent)!.target =
                        undefined;
                    press(world, BOARDER, 'nearestTarget');

                    expect(boarder.components.get(TargetComponent)!.target)
                        .not.toEqual(TARGET);
                });

            it('is not retired by the orphan sweep when its old carrier is '
                + 'already dead', async () => {
                    // The other half of the stale identity: with no live
                    // carrier, OrphanedBayFighterSystem used to delete the
                    // prize's escort command and formation link and send it
                    // departing, in the tick before the durable marker
                    // landed.
                    const { world, target } =
                        await capturedWingWorld({ carrierAlive: false });
                    world.step();
                    world.step();

                    expect(escortPredicates(world, target)).toEqual({
                        commandableBy: BOARDER, inFlock: true,
                        firingGroup: BOARDER, hailsAsEscort: true,
                    });
                    expect(target.components.get(EscortCommandComponent)
                        ?.command).toEqual('formation');
                    expect(target.components.get(NpcComponent)?.mode)
                        .not.toEqual('depart');
                });
        });

    it('gives a captured prize a slot past the highest live one, not the'
        + ' sibling count (regression: a mid-formation death made two'
        + ' escorts share a station)', async () => {
            const { world, boarder, target } = await boardingWorld({
                boarderCrew: 500, targetCrew: 1,
            });
            // The boarder already leads slots 0, 1, 2 — then slot 1 dies.
            for (const slot of [0, 2]) {
                const escort = new Entity();
                escort.components.set(FormationComponent,
                    { leader: BOARDER, slot });
                world.entities.set(`escort${slot}`, escort);
            }
            world.step();

            captureAsEscort(world, boarder);

            const formation = target.components.get(FormationComponent)!;
            expect(formation.leader).toEqual(BOARDER);
            // Counting siblings would hand out 2, colliding with escort2.
            expect(formation.slot).toEqual(3);
        });

    it('captures and assigns the ship as an escort', async () => {
        const { world, boarder, target } = await boardingWorld({
            boarderCrew: 500, targetCrew: 1,
        });
        press(world, BOARDER, 'board');
        // Attempt capture until it lands (chance is clamped to 0.95).
        for (let i = 0; i < 20
            && boarder.components.get(BoardingComponent)?.capture
            !== 'succeeded'; i++) {
            press(world, BOARDER, 'plunderCapture');
        }
        expect(boarder.components.get(BoardingComponent)?.capture)
            .toEqual('succeeded');

        press(world, BOARDER, 'plunderCaptureEscort');
        // Now an escort of the boarder: formation flock, escort command,
        // shared firing group, no govt, no longer disabled.
        expect(target.components.get(FormationComponent)?.leader)
            .toEqual(BOARDER);
        expect(target.components.get(EscortCommandComponent)?.command)
            .toEqual('formation');
        expect(target.components.get(FiringGroupComponent)?.group)
            .toEqual(BOARDER);
        expect(target.components.has(GovtComponent)).toBeFalse();
        expect(target.components.has(DisabledComponent)).toBeFalse();
        // Session ended.
        expect(boarder.components.has(BoardingComponent)).toBeFalse();
    });

    describe('boarding your OWN disabled flock member repairs it', () => {
        // Records EscortRepairedEvent so the sim-side status feedback is
        // observable (the event is targeted at the boarder).
        function recordRepairs(world: World): string[] {
            const seen: string[] = [];
            world.addSystem(new System({
                name: 'RepairRecorder',
                events: [EscortRepairedEvent],
                args: [UUID] as const,
                step(uuid) { seen.push(uuid); },
            }));
            return seen;
        }

        async function ownEscortWorld() {
            const ctx = await boardingWorld();
            // Make the disabled target the boarder's escort (flock member).
            ctx.target.components.set(FormationComponent,
                { leader: BOARDER, slot: 0 });
            ctx.world.step();
            return ctx;
        }

        it('repairs the escort and opens NO plunder session', async () => {
            const { world, boarder, target } = await ownEscortWorld();
            const repairs = recordRepairs(world);
            const shipData = target.components.get(ShipDataComponent)!;

            press(world, BOARDER, 'board');

            // No plunder session on either side.
            expect(boarder.components.has(BoardingComponent)).toBeFalse();
            expect(target.components.has(BoardedComponent)).toBeFalse();
            // Repaired: no longer disabled, armor lifted above threshold,
            // shields restored to full (hail-assist convention).
            expect(target.components.has(DisabledComponent)).toBeFalse();
            const armor = target.components.get(ArmorComponent)!;
            expect(isBelowDisableThreshold(armor, shipData.disableArmorFraction))
                .toBeFalse();
            const shield = target.components.get(ShieldComponent)!;
            expect(shield.current).toEqual(shield.max);
            // Status feedback fired at the boarder.
            expect(repairs).toEqual([BOARDER]);
        });

        it('keeps a live escort\'s existing formation slot', async () => {
            const { world, target } = await ownEscortWorld();
            press(world, BOARDER, 'board');
            // Re-attaching an escort whose link never lapsed must not
            // shuffle it to a new station.
            expect(target.components.get(FormationComponent))
                .toEqual({ leader: BOARDER, slot: 0 });
        });

        it('a HOSTILE disabled ship (not your flock) still opens plunder',
            async () => {
                // Contrast case: no flock link, so the normal plunder gate
                // runs and no repair happens.
                const { world, boarder, target } = await boardingWorld();
                const repairs = recordRepairs(world);
                press(world, BOARDER, 'board');
                expect(boarder.components.get(BoardingComponent)?.target)
                    .toEqual(TARGET);
                expect(target.components.has(BoardedComponent)).toBeTrue();
                expect(target.components.has(DisabledComponent)).toBeTrue();
                expect(repairs).toEqual([]);
            });

        /**
         * Item 5: a FORMER escort. Its live chain has lapsed (no
         * formation leader, no owner, no firing group pointing at the
         * player), so isInFlock says nothing — the durable
         * PlayerEscortComponent is what still names its owner. `detached`
         * is deliberately left unset, which is the case
         * EscortReattachSystem will NOT fix on its own (it only re-attaches
         * escorts whose player was out of the world): e.g. a fighter
         * orphaned when the carrier escort it flew from died.
         */
        async function formerEscortWorld(player = BOARDER) {
            const ctx = await boardingWorld();
            ctx.target.components.set(PlayerEscortComponent, { player });
            ctx.world.step();
            return ctx;
        }

        it('repairs a FORMER escort with no live flock link, and puts it '
            + 'back to work', async () => {
                const { world, boarder, target } = await formerEscortWorld();
                const repairs = recordRepairs(world);
                const shipData = target.components.get(ShipDataComponent)!;
                // Precondition: nothing links it to the player any more.
                expect(target.components.has(FormationComponent)).toBeFalse();

                press(world, BOARDER, 'board');

                // No plunder session, and it is flying again.
                expect(boarder.components.has(BoardingComponent)).toBeFalse();
                expect(target.components.has(BoardedComponent)).toBeFalse();
                expect(target.components.has(DisabledComponent)).toBeFalse();
                const armor = target.components.get(ArmorComponent)!;
                expect(isBelowDisableThreshold(
                    armor, shipData.disableArmorFraction)).toBeFalse();
                expect(armor.current).toEqual(
                    (shipData.disableArmorFraction + 0.10) * armor.max);
                const shield = target.components.get(ShieldComponent)!;
                expect(shield.current).toEqual(shield.max);
                // Re-attached as a working escort.
                expect(target.components.get(FormationComponent)?.leader)
                    .toEqual(BOARDER);
                expect(target.components.get(EscortCommandComponent)?.command)
                    .toEqual('formation');
                expect(target.components.get(FiringGroupComponent)?.group)
                    .toEqual(BOARDER);
                expect(repairs).toEqual([BOARDER]);
            });

        it('charges no crime for repairing your own former escort',
            async () => {
                const { world, boarder } = await formerEscortWorld();
                press(world, BOARDER, 'board');
                expect(boarder.components.get(LegalRecordsComponent)!
                    .get('nova:128')).toBeUndefined();
            });

        it('still plunders a hulk marked as ANOTHER player\'s escort',
            async () => {
                const { world, boarder, target } =
                    await formerEscortWorld('some other player');
                const repairs = recordRepairs(world);
                press(world, BOARDER, 'board');
                expect(boarder.components.get(BoardingComponent)?.target)
                    .toEqual(TARGET);
                expect(target.components.has(DisabledComponent)).toBeTrue();
                expect(repairs).toEqual([]);
            });
    });

    /**
     * Matthew's LAN playtest, bug 1: "Can capture player ships. Player
     * still controls them but you can kinda tell them to fire weapons at
     * other ships." Capture of a ship somebody is FLYING is impossible by
     * either route; PLUNDER of it stays legal (PvP piracy).
     *
     * Pinned at the system level with ControlledByComponent on the victim,
     * which is exactly what a remote peer's ship looks like in every
     * peer's simulation: the component is serializer-registered and is not
     * in PEER_LOCAL_COMPONENTS, so it is part of the shared state each
     * peer hashes for desync detection and reads identically. A two-peer
     * harness would exercise the same predicate on the same state.
     */
    describe('a ship somebody is flying can be robbed but not taken', () => {
        async function pvpWorld() {
            // ControlledBy is stamped AFTER the setup disable, so the
            // victim's repair roll (which reads it) is unaffected and the
            // hulk stays disabled for the whole spec.
            const ctx = await boardingWorld({ boarderCrew: 500,
                targetCrew: 1 });
            ctx.target.components.set(ControlledByComponent,
                { peerId: 'the other peer' });
            ctx.world.step();
            return ctx;
        }

        it('opens the plunder session and lets the booty be taken',
            async () => {
                const { world, boarder, target } = await pvpWorld();
                press(world, BOARDER, 'board');
                expect(boarder.components.get(BoardingComponent)?.target)
                    .toEqual(TARGET);

                press(world, BOARDER, 'plunderCargo');
                press(world, BOARDER, 'plunderCredits');
                expect(boarder.components.get(CargoComponent)!.get('cargo:0'))
                    .toEqual(2);
                expect(boarder.components.get(CreditsComponent)!.credits)
                    .toBeGreaterThan(0);
                // Still theirs, still disabled, still flown by them.
                expect(target.components.has(ControlledByComponent)).toBeTrue();
            });

        it('never lets the capture roll succeed, and never draws for it',
            async () => {
                const { world, boarder } = await pvpWorld();
                press(world, BOARDER, 'board');
                const random = world.resources.get(RandomResource)!;
                const before = random.getState();

                for (let i = 0; i < 20; i++) {
                    press(world, BOARDER, 'plunderCapture');
                }

                // Capture stays at its opening value, and the seeded PRNG
                // is untouched: a skipped roll must not shift the draw
                // sequence, or peers replaying this press would diverge.
                expect(boarder.components.get(BoardingComponent)?.capture)
                    .toEqual('none');
                expect(random.getState()).toEqual(before);
            });

        it('refuses the escort conversion even if capture is forced',
            async () => {
                // Belt-and-braces: 'succeeded' is unreachable above, so
                // this hand-writes it to prove the second gate holds.
                const { world, boarder, target } = await pvpWorld();
                press(world, BOARDER, 'board');
                boarder.components.get(BoardingComponent)!.capture =
                    'succeeded';

                press(world, BOARDER, 'plunderCaptureEscort');

                expect(target.components.has(FormationComponent)).toBeFalse();
                expect(target.components.has(EscortCommandComponent))
                    .toBeFalse();
                expect(target.components.has(FiringGroupComponent)).toBeFalse();
                expect(target.components.has(PlayerEscortComponent))
                    .toBeFalse();
                // Its own government (and its own captain) intact.
                expect(target.components.has(GovtComponent)).toBeTrue();
            });
    });

    it('rolls the capture identically for the same seed', async () => {
        const a = await boardingWorld({ boarderCrew: 10, targetCrew: 10 });
        const b = await boardingWorld({ boarderCrew: 10, targetCrew: 10 });
        press(a.world, BOARDER, 'board');
        press(b.world, BOARDER, 'board');
        press(a.world, BOARDER, 'plunderCapture');
        press(b.world, BOARDER, 'plunderCapture');
        expect(a.boarder.components.get(BoardingComponent)?.capture)
            .toEqual(b.boarder.components.get(BoardingComponent)?.capture);
    });

    /**
     * Matthew's item 1: a Drifting Derelict could never be captured. Its
     * capture odds are a per-attempt roll (a starting Shuttle's crew of 1
     * against the derelict Argosy's 10 is 9%), so capturing one is meant
     * to take several tries — but ending the first session used to leave
     * BoardedComponent on the hulk forever, and the board gate refused
     * every later attempt. One repelled roll locked the ship out for good.
     */
    describe('a hulk can be boarded again after a session ends', () => {
        it('re-opens a session after the player closes the last one',
            async () => {
                const { world, boarder, target } = await boardingWorld();
                press(world, BOARDER, 'board');
                expect(boarder.components.has(BoardingComponent)).toBeTrue();

                press(world, BOARDER, 'plunderDone');
                expect(boarder.components.has(BoardingComponent)).toBeFalse();
                // Still marked as boarded (the mission-goal seam reads
                // presence) but no longer an open session.
                expect(target.components.has(BoardedComponent)).toBeTrue();
                expect(target.components.get(BoardedComponent)?.active)
                    .toBeFalsy();

                press(world, BOARDER, 'board');
                expect(boarder.components.get(BoardingComponent)?.target)
                    .toEqual(TARGET);
            });

        it('lets a repelled capture be retried in a later session',
            async () => {
                // 1 vs 400 crew is clamped to the 5% floor, so the first
                // roll is overwhelmingly a failure; the point is that the
                // hulk is still boardable afterwards.
                const { world, boarder, target } = await boardingWorld(
                    { boarderCrew: 1, targetCrew: 400 });
                press(world, BOARDER, 'board');
                press(world, BOARDER, 'plunderCapture');
                press(world, BOARDER, 'plunderDone');

                // Keep boarding and rolling; with a live 5% chance this
                // must eventually succeed rather than being locked out.
                let captured = false;
                for (let i = 0; i < 400 && !captured; i++) {
                    press(world, BOARDER, 'board');
                    expect(boarder.components.has(BoardingComponent))
                        .withContext(`board attempt ${i} was refused`)
                        .toBeTrue();
                    press(world, BOARDER, 'plunderCapture');
                    captured = boarder.components.get(BoardingComponent)
                        ?.capture === 'succeeded';
                    if (!captured) {
                        press(world, BOARDER, 'plunderDone');
                    }
                }
                expect(captured).toBeTrue();
                expect(target.components.has(DisabledComponent)).toBeTrue();
            });

        it('blocks a second boarding only while a session is OPEN',
            async () => {
                const { world, boarder, target } = await boardingWorld();
                press(world, BOARDER, 'board');
                expect(target.components.get(BoardedComponent)?.active)
                    .toBeTrue();
                // Pressing board again mid-session changes nothing.
                press(world, BOARDER, 'board');
                expect(boarder.components.get(BoardingComponent)?.target)
                    .toEqual(TARGET);
            });

        it('frees a hulk whose boarder left without ending the session',
            async () => {
                // A boarder that is destroyed / jumps out / lands never
                // runs its session-end path, so the hulk keeps active:true.
                // Trusting that flag alone would strand it unboardable for
                // the rest of the game.
                const { world, boarder, target } = await boardingWorld();
                press(world, BOARDER, 'board');
                expect(target.components.get(BoardedComponent)?.active)
                    .toBeTrue();

                // The boarder abandons the session without pressing done.
                boarder.components.delete(BoardingComponent);
                world.step();

                press(world, BOARDER, 'board');
                expect(boarder.components.get(BoardingComponent)?.target)
                    .toEqual(TARGET);
            });

        it('does not let booty be taken twice across sessions', async () => {
            const { world, boarder, target } = await boardingWorld();
            const price = target.components.get(ShipDataComponent)!.price;
            const booty = Math.floor(price * 0.10);
            press(world, BOARDER, 'board');
            press(world, BOARDER, 'plunderCredits');
            press(world, BOARDER, 'plunderCargo');
            expect(boarder.components.get(CreditsComponent)!.credits)
                .toEqual(booty);
            press(world, BOARDER, 'plunderDone');

            // Credits are re-derived from the ship price on every board,
            // so without the durable flag this would farm money forever.
            press(world, BOARDER, 'board');
            const resumed = boarder.components.get(BoardingComponent)!;
            expect(resumed.creditsTaken).toBeTrue();
            expect(resumed.cargoTaken).toBeTrue();
            press(world, BOARDER, 'plunderCredits');
            expect(boarder.components.get(CreditsComponent)!.credits)
                .toEqual(booty);
        });

        it('keeps the credit booty spent when the session ends UNGRACEFULLY',
            async () => {
                // The re-farm this pins shut: the durable *Taken flags used
                // to be written onto the hulk only by the session-end path,
                // which an abandoned session never runs. Take the credits,
                // die (or jump, or land) without pressing done, come back
                // with a new boarder — and creditBooty re-derived the money
                // from the ship price all over again, forever.
                const { world, boarder, target, gameData } =
                    await boardingWorld();
                const price = target.components.get(ShipDataComponent)!.price;
                const booty = Math.floor(price * 0.10);

                press(world, BOARDER, 'board');
                press(world, BOARDER, 'plunderCredits');
                expect(boarder.components.get(CreditsComponent)!.credits)
                    .toEqual(booty);

                // UNGRACEFUL end: the boarder is destroyed mid-session, so
                // no session-end path ever runs on it.
                world.entities.delete(BOARDER);
                world.step();

                // The HULK is what has to remember, and it must remember
                // straight away — not at some session end that never comes.
                expect(target.components.get(BoardedComponent)?.creditsTaken)
                    .toBeTrue();

                // A brand-new boarder takes over the same hulk.
                const shipData = (await gameData.data.Ship.get('nova:128'))!;
                const second = makeShip(shipData);
                second.components.set(MovementStateComponent, {
                    position: new Position(0, 0), velocity: new Vector(0, 0),
                    rotation: new Angle(0), turning: 0, turnBack: false,
                    accelerating: 0,
                });
                second.components.set(CreditsComponent, { credits: 0 });
                await completeEntity(world, second);
                world.entities.set(SECOND_BOARDER, second);
                world.step();
                second.components.set(ShipDataComponent, {
                    ...second.components.get(ShipDataComponent)!, crew: 200,
                });
                second.components.set(CreditsComponent, { credits: 0 });
                second.components.get(TargetComponent)!.target = TARGET;
                world.step();

                press(world, SECOND_BOARDER, 'board');
                const resumed = second.components.get(BoardingComponent)!;
                expect(resumed.target).toEqual(TARGET);
                expect(resumed.creditsTaken).toBeTrue();

                press(world, SECOND_BOARDER, 'plunderCredits');
                expect(second.components.get(CreditsComponent)!.credits)
                    .toEqual(0);
            });
    });
});

/**
 * Matthew's item 6: boarding a disabled ship that FITS ONE OF YOUR BAYS
 * and has room captures it outright — no plunder session, no capture
 * contest, no dialog — STOWED straight into the magazine, exactly as the
 * status message has always claimed ("Captured the X into your fighter
 * bay"). The prize leaves the world; launching it again mints a fresh
 * fighter from the bay's ship class.
 *
 * Built on a MockGameData world (like bay_plugin_test) rather than the
 * stock scenario, because the shortcut needs a carrier whose bay launches
 * exactly the class of the ship being boarded, in several capacity
 * configurations.
 */
describe('bay-capture shortcut', () => {
    const CARRIER_SHIP = 'test:carrier';
    const FIGHTER_SHIP = 'test:fighterShip';
    const OTHER_SHIP = 'test:otherShip';
    // Two bays that launch the SAME fighter class, so the lowest-sorted-id
    // preference is observable. 'test:bayA' sorts before 'test:bayB'.
    const BAY_A = 'test:bayA';
    const BAY_B = 'test:bayB';
    const BAY_A_OUTFIT = 'test:bayAOutfit';
    const BAY_B_OUTFIT = 'test:bayBOutfit';
    const ROUNDS_A = 'test:roundsA';
    const ROUNDS_B = 'test:roundsB';
    const GOVT = 'test:govt';

    async function stepWorld(world: World, steps: number) {
        for (let i = 0; i < steps; i++) {
            world.step();
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    function press(world: World, uuid: string, action: string) {
        const entity = world.entities.get(uuid)!;
        entity.components.set(ShipControlStateComponent,
            new Map([[action, 'start']]) as any);
        world.emit(ShipControlEvent, undefined, [uuid]);
        world.step();
    }

    /**
     * A carrier (the boarder) alongside a disabled ship of `targetShip`.
     * `roundsA` is the carrier's magazine for bay A; `bays` how many of bay
     * A it mounts; `secondBay` mounts bay B (same fighter class) too.
     */
    async function bayWorld({
        maxAmmo = 2, bays = 1, roundsA = 0, roundsB = 0, secondBay = false,
        targetShip = FIGHTER_SHIP, bayShip = FIGHTER_SHIP,
    } = {}) {
        const gameData = new MockGameData();
        const makeBay = (id: string): BayWeaponData => ({
            ...getDefaultBayWeaponData(),
            id,
            shipID: bayShip,
            ammoType: ['weapon', id],
            maxAmmo,
            fireGroup: 'secondary',
            reload: 1,
        });
        gameData.data.Weapon.map.set(BAY_A, makeBay(BAY_A));
        gameData.data.Weapon.map.set(BAY_B, makeBay(BAY_B));
        gameData.data.Outfit.map.set(BAY_A_OUTFIT, {
            ...getDefaultOutfitData(), id: BAY_A_OUTFIT,
            weapons: { [BAY_A]: 1 },
        });
        gameData.data.Outfit.map.set(BAY_B_OUTFIT, {
            ...getDefaultOutfitData(), id: BAY_B_OUTFIT,
            weapons: { [BAY_B]: 1 },
        });
        gameData.data.Outfit.map.set(ROUNDS_A, {
            ...getDefaultOutfitData(), id: ROUNDS_A, ammoFor: BAY_A,
        });
        gameData.data.Outfit.map.set(ROUNDS_B, {
            ...getDefaultOutfitData(), id: ROUNDS_B, ammoFor: BAY_B,
        });
        // A real govt entry, not MockGettable's shared default: applyCrime
        // keys the record by the GovtData's own id, so the default's id
        // would be charged instead of this one.
        gameData.data.Govt.map.set(GOVT, {
            ...getDefaultGovtData(), id: GOVT,
        });
        for (const id of [FIGHTER_SHIP, OTHER_SHIP]) {
            gameData.data.Ship.map.set(id, {
                ...getDefaultShipData(), id, crew: 4,
            });
        }
        const carrierData: ShipData = {
            ...getDefaultShipData(),
            id: CARRIER_SHIP,
            crew: 200,
            outfits: {
                [BAY_A_OUTFIT]: bays,
                [ROUNDS_A]: roundsA,
                ...(secondBay
                    ? { [BAY_B_OUTFIT]: 1, [ROUNDS_B]: roundsB } : {}),
            },
            physics: { ...getDefaultShipPhysics() },
        };
        gameData.data.Ship.map.set(CARRIER_SHIP, carrierData);

        const world = await makeSystem('test:system', gameData, undefined,
            { npcs: false });

        const boarder = makeShip(carrierData);
        boarder.components.set(MovementStateComponent, {
            accelerating: 0, position: new Position(0, 0),
            rotation: new Angle(0), turnBack: false, turning: 0,
            velocity: new Vector(0, 0),
        });
        // A player-controlled boarder, so the capture can stamp durable
        // ownership (PlayerEscortComponent) on its new fighter.
        boarder.components.set(ControlledByComponent, { peerId: 'test peer' });
        boarder.components.set(CreditsComponent, { credits: 0 });
        boarder.components.set(LegalRecordsComponent, new Map());

        const target = makeShip(
            gameData.data.Ship.map.get(targetShip)!);
        target.components.set(MovementStateComponent, {
            accelerating: 0, position: new Position(60, 0),
            rotation: new Angle(0), turnBack: false, turning: 0,
            velocity: new Vector(0, 0),
        });
        target.components.set(GovtComponent, { id: GOVT });

        await completeEntity(world, boarder);
        await completeEntity(world, target);
        world.entities.set(BOARDER, boarder);
        world.entities.set(TARGET, target);
        await stepWorld(world, 2);

        boarder.components.get(TargetComponent)!.target = TARGET;
        // Disable the target: armor below its 33% threshold, then a step so
        // ShipDisableSystem sets DisabledComponent.
        const armor = target.components.get(ArmorComponent)!;
        armor.current = 0.2 * armor.max;
        const shield = target.components.get(ShieldComponent);
        if (shield) {
            shield.current = 0;
        }
        await stepWorld(world, 1);
        expect(target.components.has(DisabledComponent)).toBeTrue();

        return { world, boarder, target, gameData };
    }

    /** Records BayCaptureEvent (targeted at the boarder). */
    function recordCaptures(world: World): { uuid: string, shipId: string }[] {
        const seen: { uuid: string, shipId: string }[] = [];
        world.addSystem(new System({
            name: 'BayCaptureRecorder',
            events: [BayCaptureEvent],
            args: [BayCaptureEvent, UUID] as const,
            step({ shipId }, uuid) { seen.push({ uuid, shipId }); },
        }));
        return seen;
    }

    function recordRepairs(world: World): string[] {
        const seen: string[] = [];
        world.addSystem(new System({
            name: 'RepairRecorder2',
            events: [EscortRepairedEvent],
            args: [UUID] as const,
            step(uuid) { seen.push(uuid); },
        }));
        return seen;
    }

    function rounds(boarder: Entity, id: string): number {
        return boarder.components.get(OutfitsStateComponent)?.get(id)?.count
            ?? 0;
    }

    /** A stub already-deployed fighter of `bayId` launched by the boarder. */
    function addDeployedFighter(world: World, bayId: string, uuid: string) {
        const fighter = new Entity();
        fighter.components.set(BayFighterComponent, { bayWeaponId: bayId });
        fighter.components.set(SourceComponent, BOARDER);
        world.entities.set(uuid, fighter);
        world.step();
    }

    it('stows the hulk in the bay — magazine credited, ship gone, with no '
        + 'session, dialog, or contest', async () => {
            const { world, boarder, target } = await bayWorld();
            const captures = recordCaptures(world);
            const repairs = recordRepairs(world);

            press(world, BOARDER, 'board');

            // No plunder session on either side, and the repair path did
            // not run (the shortcut overrides it).
            expect(boarder.components.has(BoardingComponent)).toBeFalse();
            expect(target.components.has(BoardedComponent)).toBeFalse();
            expect(repairs).toEqual([]);
            // The prize is IN the bay: one round credited, and the ship
            // itself is out of the world — no deployed fighter left flying
            // around to contradict the status message.
            expect(rounds(boarder, ROUNDS_A)).toEqual(1);
            expect(world.entities.has(TARGET)).toBeFalse();
            // Nothing was stamped on the hulk on the way out.
            expect(target.components.has(BayFighterComponent)).toBeFalse();
            expect(target.components.has(FormationComponent)).toBeFalse();
            expect(target.components.has(EscortCommandComponent)).toBeFalse();
            expect(target.components.has(PlayerEscortComponent)).toBeFalse();
            // The boarder is no longer pointed at a ship that is gone.
            expect(boarder.components.get(TargetComponent)?.target)
                .toBeUndefined();
            // The player gets the only feedback there is.
            expect(captures).toEqual([{ uuid: BOARDER,
                shipId: FIGHTER_SHIP }]);
        });

    it('credits exactly one round however many bays are mounted',
        async () => {
            const { world, boarder } = await bayWorld({ bays: 2, maxAmmo: 4 });
            press(world, BOARDER, 'board');
            expect(rounds(boarder, ROUNDS_A)).toEqual(1);
            expect(world.entities.has(TARGET)).toBeFalse();
        });

    it('re-launches the stowed prize as a fresh fighter of the bay\'s '
        + 'ship class', async () => {
            // The round banked by a capture is an ordinary round: firing
            // the bay spends it and puts a fighter back in the sky.
            const { world, boarder } = await bayWorld();
            press(world, BOARDER, 'board');
            expect(rounds(boarder, ROUNDS_A)).toEqual(1);

            const weapons = boarder.components.get(WeaponsStateComponent)!;
            weapons.get(BAY_A)!.firing = true;
            await stepWorld(world, 2);

            expect(rounds(boarder, ROUNDS_A)).toEqual(0);
            const launched = [...world.entities].filter(([, entity]) =>
                entity.components.get(BayFighterComponent)?.bayWeaponId
                === BAY_A);
            expect(launched.length).toEqual(1);
            expect(launched[0][1].components.get(ShipComponent)?.id)
                .toEqual(FIGHTER_SHIP);
        });

    it('falls through to normal boarding when the magazine is full',
        async () => {
            // 1 bay x MaxAmmo 1, already holding its fighter.
            const { world, boarder, target } = await bayWorld({
                maxAmmo: 1, roundsA: 1,
            });
            const captures = recordCaptures(world);
            press(world, BOARDER, 'board');
            expect(captures).toEqual([]);
            expect(target.components.has(BayFighterComponent)).toBeFalse();
            expect(boarder.components.get(BoardingComponent)?.target)
                .toEqual(TARGET);
        });

    it('counts already-deployed fighters against the room check',
        async () => {
            // Capacity 1, magazine empty — but one of this bay's fighters
            // is already out, so there is nowhere to put another.
            const { world, boarder, target } = await bayWorld({ maxAmmo: 1 });
            addDeployedFighter(world, BAY_A, 'deployed fighter');
            const captures = recordCaptures(world);
            press(world, BOARDER, 'board');
            expect(captures).toEqual([]);
            expect(target.components.has(BayFighterComponent)).toBeFalse();
            expect(boarder.components.get(BoardingComponent)?.target)
                .toEqual(TARGET);
        });

    it('ignores another bay\'s deployed fighters in the room check',
        async () => {
            const { world, boarder } = await bayWorld({ maxAmmo: 1 });
            addDeployedFighter(world, 'test:someOtherBay', 'other fighter');
            press(world, BOARDER, 'board');
            expect(rounds(boarder, ROUNDS_A)).toEqual(1);
            expect(world.entities.has(TARGET)).toBeFalse();
        });

    it('treats MaxAmmo 0 as unbounded room', async () => {
        const { world, boarder } = await bayWorld({ maxAmmo: 0, roundsA: 99 });
        press(world, BOARDER, 'board');
        expect(rounds(boarder, ROUNDS_A)).toEqual(100);
        expect(world.entities.has(TARGET)).toBeFalse();
    });

    it('captures into the lowest-sorted bay id when two bays fit',
        async () => {
            const { world, boarder } = await bayWorld({ secondBay: true });
            press(world, BOARDER, 'board');
            expect(rounds(boarder, ROUNDS_A)).toEqual(1);
            expect(rounds(boarder, ROUNDS_B)).toEqual(0);
            expect(world.entities.has(TARGET)).toBeFalse();
        });

    it('uses the other bay when the lowest-sorted one is full', async () => {
        const { world, boarder } = await bayWorld({
            maxAmmo: 1, roundsA: 1, secondBay: true, roundsB: 0,
        });
        press(world, BOARDER, 'board');
        expect(rounds(boarder, ROUNDS_A)).toEqual(1);
        expect(rounds(boarder, ROUNDS_B)).toEqual(1);
        expect(world.entities.has(TARGET)).toBeFalse();
    });

    it('never stows a ship somebody is flying, whatever class it is',
        async () => {
            // Bug 1's other route: the instant bay capture would have
            // swallowed a peer's disabled fighter whole. It falls through
            // to the ordinary plunder session instead.
            const { world, boarder, target } = await bayWorld();
            target.components.set(ControlledByComponent,
                { peerId: 'the other peer' });
            const captures = recordCaptures(world);

            press(world, BOARDER, 'board');

            expect(captures).toEqual([]);
            expect(world.entities.has(TARGET)).toBeTrue();
            expect(rounds(boarder, ROUNDS_A)).toEqual(0);
            expect(boarder.components.get(BoardingComponent)?.target)
                .toEqual(TARGET);
        });

    it('leaves the hulk alone when there is no magazine to credit',
        async () => {
            // The boarder mounts the bay but has never owned a round of
            // its ammo, so there is no supplying outfit to credit. Better
            // to fall through to a plunder session than to delete a ship
            // and bank nothing.
            const { world, boarder, target } = await bayWorld();
            boarder.components.get(OutfitsStateComponent)!.delete(ROUNDS_A);
            const captures = recordCaptures(world);

            press(world, BOARDER, 'board');

            expect(captures).toEqual([]);
            expect(world.entities.has(TARGET)).toBeTrue();
            expect(target.components.has(DisabledComponent)).toBeTrue();
            expect(boarder.components.get(BoardingComponent)?.target)
                .toEqual(TARGET);
        });

    it('leaves a ship class no bay launches to normal boarding', async () => {
        const { world, boarder, target } = await bayWorld({
            targetShip: OTHER_SHIP,
        });
        const captures = recordCaptures(world);
        press(world, BOARDER, 'board');
        expect(captures).toEqual([]);
        expect(target.components.has(BayFighterComponent)).toBeFalse();
        expect(boarder.components.get(BoardingComponent)?.target)
            .toEqual(TARGET);
    });

    it('charges the same board crime a plunder capture would', async () => {
        const { world, boarder } = await bayWorld();
        press(world, BOARDER, 'board');
        expect(boarder.components.get(LegalRecordsComponent)!.get(GOVT))
            .toBeLessThan(0);
    });

    it('draws nothing from the seeded PRNG', async () => {
        // The shortcut must not shift the random sequence: with rollback
        // resimulation, a press that consumed a draw on some peers only
        // (or in some replays) would desync everything downstream of it.
        const { world } = await bayWorld();
        const random = world.resources.get(RandomResource)!;
        const before = random.getState();
        press(world, BOARDER, 'board');
        expect(world.entities.has(TARGET)).toBeFalse();
        expect(random.getState()).toEqual(before);
    });

    describe('precedence over the former-escort repair', () => {
        /** The hulk is durably marked as the boarder's (former) escort. */
        function markFormerEscort(world: World, target: Entity) {
            target.components.set(PlayerEscortComponent, { player: BOARDER });
            world.step();
        }

        it('bay-captures a former escort that fits with room', async () => {
            const { world, boarder, target } = await bayWorld();
            markFormerEscort(world, target);
            const repairs = recordRepairs(world);
            const captures = recordCaptures(world);

            press(world, BOARDER, 'board');

            expect(rounds(boarder, ROUNDS_A)).toEqual(1);
            expect(world.entities.has(TARGET)).toBeFalse();
            expect(captures.length).toEqual(1);
            expect(repairs).toEqual([]);
        });

        it('falls back to repairing a former escort with no bay room',
            async () => {
                const { world, boarder, target } = await bayWorld({
                    maxAmmo: 1, roundsA: 1,
                });
                markFormerEscort(world, target);
                const repairs = recordRepairs(world);
                const captures = recordCaptures(world);

                press(world, BOARDER, 'board');

                expect(captures).toEqual([]);
                expect(target.components.has(BayFighterComponent)).toBeFalse();
                expect(repairs).toEqual([BOARDER]);
                expect(target.components.has(DisabledComponent)).toBeFalse();
                expect(target.components.get(FormationComponent)?.leader)
                    .toEqual(BOARDER);
                expect(boarder.components.has(BoardingComponent)).toBeFalse();
            });
    });

    /**
     * PLUNDER specs that need no Nova_Data. The plunder flow's own suite
     * runs on getIntegrationGameData, so on a checkout without the game
     * files (data-less CI, review machines) it is skipped wholesale —
     * including the HIGH-severity credit-farm regression. These are twins
     * of the ones worth pinning everywhere, built on the mock world above.
     *
     * OTHER_SHIP is deliberately a class no bay here launches, so the
     * bay-capture shortcut does not fire and boarding falls through to the
     * ordinary plunder session.
     */
    describe('plunder, on mock game data', () => {
        const PRICE = 10_000;

        /** A mock world whose hulk is worth plundering: not bay-capturable,
         * and priced, since the credit booty is a fraction of ship price
         * (the stock default price is 0, which would make it vacuous). */
        async function plunderWorld() {
            const ctx = await bayWorld({ targetShip: OTHER_SHIP });
            const { world, target } = ctx;
            // Applied after the provide step, as the crew overrides in the
            // live-world suite are, so ShipDataProvider does not undo it.
            target.components.set(ShipDataComponent, {
                ...target.components.get(ShipDataComponent)!, price: PRICE,
            });
            world.step();
            return ctx;
        }

        it('keeps the credit booty spent when the session ends '
            + 'UNGRACEFULLY', async () => {
                // The re-farm this pins shut: the durable *Taken flags used
                // to be written onto the hulk only by the session-end path,
                // which an abandoned session never runs. Take the credits,
                // die (or jump, or land) without pressing done, come back
                // with a new boarder — and creditsAvailable was re-derived
                // from the ship price all over again, forever.
                const { world, boarder, target, gameData } =
                    await plunderWorld();
                const booty = Math.floor(PRICE * 0.10);
                expect(booty).toBeGreaterThan(0);

                press(world, BOARDER, 'board');
                expect(boarder.components.get(BoardingComponent)?.target)
                    .toEqual(TARGET);
                press(world, BOARDER, 'plunderCredits');
                expect(boarder.components.get(CreditsComponent)!.credits)
                    .toEqual(booty);

                // UNGRACEFUL end: the boarder is destroyed mid-session, so
                // no session-end path ever runs on it.
                world.entities.delete(BOARDER);
                world.step();

                // The HULK is what has to remember, and it must remember
                // straight away — not at some session end that never comes.
                expect(target.components.get(BoardedComponent)?.creditsTaken)
                    .toBeTrue();

                // A brand-new boarder takes over the same hulk.
                const second = makeShip(
                    gameData.data.Ship.map.get(CARRIER_SHIP)!);
                second.components.set(MovementStateComponent, {
                    accelerating: 0, position: new Position(0, 0),
                    rotation: new Angle(0), turnBack: false, turning: 0,
                    velocity: new Vector(0, 0),
                });
                second.components.set(ControlledByComponent,
                    { peerId: 'second peer' });
                second.components.set(CreditsComponent, { credits: 0 });
                second.components.set(LegalRecordsComponent, new Map());
                await completeEntity(world, second);
                world.entities.set(SECOND_BOARDER, second);
                await stepWorld(world, 2);
                second.components.set(CreditsComponent, { credits: 0 });
                second.components.get(TargetComponent)!.target = TARGET;
                world.step();

                press(world, SECOND_BOARDER, 'board');
                const resumed = second.components.get(BoardingComponent)!;
                expect(resumed.target).toEqual(TARGET);
                expect(resumed.creditsTaken).toBeTrue();

                press(world, SECOND_BOARDER, 'plunderCredits');
                expect(second.components.get(CreditsComponent)!.credits)
                    .toEqual(0);
            });

        it('a captured prize sheds the bay DOCKING PLUMBING, not just the '
            + 'launch link', async () => {
                // startReturnHome makes a fighter physically hit its carrier
                // so the contact fires CollectableEscortAI and it is scooped
                // up: a CollisionHitter for `return_escorts` plus a Hurtbox
                // hull copied from its hitbox. Capture a wing that was
                // already on its way home and that plumbing used to survive
                // onto the player's new escort — inert only for as long as
                // its consumer stays gated on CollectableEscortComponent,
                // and stale bay identity on a prize is precisely what caused
                // the half-escort bug.
                const { world, boarder, target } = await plunderWorld();
                startReturnHome(target);
                world.step();
                // Precondition: the plumbing really is on the hull.
                expect(target.components.get(CollisionHitterComponent)
                    ?.hitTypes.has('return_escorts')).toBeTrue();
                expect(target.components.has(HurtboxHullComponent)).toBeTrue();

                captureAsEscort(world, boarder);

                expect(target.components.has(CollisionHitterComponent))
                    .toBeFalse();
                expect(target.components.has(HurtboxHullComponent))
                    .toBeFalse();
                // The rest of the return-home state goes too, as before.
                expect(target.components.has(ReturnComponent)).toBeFalse();
                expect(target.components.has(CollectableEscortComponent))
                    .toBeFalse();
                // And it is a real escort of the captor.
                expect(target.components.get(FormationComponent)?.leader)
                    .toEqual(BOARDER);
            });

        /** The capture flow, pressed until the roll lands. */
        function captureAsEscort(world: World, boarder: Entity) {
            press(world, BOARDER, 'board');
            for (let i = 0; i < 40
                && boarder.components.get(BoardingComponent)?.capture
                !== 'succeeded'; i++) {
                press(world, BOARDER, 'plunderCapture');
            }
            expect(boarder.components.get(BoardingComponent)?.capture)
                .toEqual('succeeded');
            press(world, BOARDER, 'plunderCaptureEscort');
        }
    });
});
