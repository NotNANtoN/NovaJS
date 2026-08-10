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
    BayFighterComponent, ReturnWhenTargetRemovedComponent,
} from './bay_plugin.js';
import { isBelowDisableThreshold } from './disabled_component.js';
import { CargoComponent } from './cargo_plugin.js';
import {
    CollisionEvent, CollisionVulnerabilityComponent,
} from './collision_interaction.js';
import { DisabledComponent } from './disabled_component.js';
import { completeEntity } from './entity_data_loader.js';
import { EscortCommandComponent } from './escort_command.js';
import { OwnerComponent, SourceComponent } from './fire_weapon_plugin.js';
import { FiringGroupComponent } from './firing_group.js';
import { GovtComponent } from './govt_component.js';
import { ArmorComponent, FuelComponent, ShieldComponent } from './health_plugin.js';
import { makeShip } from './make_ship.js';
import { makeSystem } from './make_system.js';
import { FormationComponent } from './npc_ai_plugin.js';
import { OutfitsStateComponent } from './outfit_plugin.js';
import { PlayerEscortComponent } from './player_escort.js';
import { CreditsComponent } from './player_state_plugin.js';
import { LegalRecordsComponent } from './reputation_plugin.js';
import {
    ControlledByComponent, ShipControlEvent, ShipControlStateComponent,
} from './ship_control.js';
import { ShipDataComponent } from './ship_plugin.js';
import { TargetComponent } from './target_component.js';

const BOARDER = 'boarder';
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
});

/**
 * Matthew's item 6: boarding a disabled ship that FITS ONE OF YOUR BAYS
 * and has room captures it outright — no plunder session, no capture
 * contest, no dialog — as a deployed bay fighter that can dock later and
 * bank itself into the magazine.
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

    it('captures the hulk into the bay as a deployed fighter, with no '
        + 'session, dialog, or contest', async () => {
            const { world, boarder, target } = await bayWorld();
            const captures = recordCaptures(world);
            const repairs = recordRepairs(world);
            const shipData = target.components.get(ShipDataComponent)!;

            press(world, BOARDER, 'board');

            // No plunder session on either side, and the repair path did
            // not run (the shortcut overrides it).
            expect(boarder.components.has(BoardingComponent)).toBeFalse();
            expect(target.components.has(BoardedComponent)).toBeFalse();
            expect(repairs).toEqual([]);
            // Stamped exactly like a bay-launched fighter.
            expect(target.components.get(BayFighterComponent))
                .toEqual({ bayWeaponId: BAY_A });
            expect(target.components.get(SourceComponent)).toEqual(BOARDER);
            expect(target.components.get(OwnerComponent))
                .toEqual({ owner: BOARDER });
            expect(target.components.has(ReturnWhenTargetRemovedComponent))
                .toBeTrue();
            expect(target.components.get(FormationComponent))
                .toEqual({ leader: BOARDER, slot: 0 });
            expect(target.components.get(EscortCommandComponent)?.command)
                .toEqual('formation');
            expect(target.components.get(FiringGroupComponent)?.group)
                .toEqual(BOARDER);
            expect(target.components.get(PlayerEscortComponent))
                .toEqual({ player: BOARDER, parent: BOARDER });
            expect(target.components.has(GovtComponent)).toBeFalse();
            expect(target.components.get(TargetComponent)?.target)
                .toBeUndefined();
            // Repaired: flying again, armor at the established margin above
            // the disable threshold, shields full.
            expect(target.components.has(DisabledComponent)).toBeFalse();
            const armor = target.components.get(ArmorComponent)!;
            expect(armor.current).toEqual(
                (shipData.disableArmorFraction + 0.10) * armor.max);
            const shield = target.components.get(ShieldComponent)!;
            expect(shield.current).toEqual(shield.max);
            // The carrier can be docked with.
            expect(boarder.components.get(CollisionVulnerabilityComponent)!
                .vulnerableTo.has('return_escorts')).toBeTrue();
            // The magazine is NOT credited at capture time: the fighter is
            // deployed, not stowed.
            expect(rounds(boarder, ROUNDS_A)).toEqual(0);
            // The player gets the only feedback there is.
            expect(captures).toEqual([{ uuid: BOARDER,
                shipId: FIGHTER_SHIP }]);
        });

    it('banks the capture when the new fighter docks (refund path)',
        async () => {
            const { world, boarder, target } = await bayWorld();
            press(world, BOARDER, 'board');
            expect(rounds(boarder, ROUNDS_A)).toEqual(0);

            // Order it home, then let it touch its carrier:
            // CollectableEscortAI credits the round and removes it.
            target.components.set(EscortCommandComponent,
                { command: 'returnToBay' });
            await stepWorld(world, 1);
            world.emit(CollisionEvent, { other: BOARDER, initiator: true },
                [TARGET]);
            await stepWorld(world, 1);

            expect(world.entities.has(TARGET)).toBeFalse();
            expect(rounds(boarder, ROUNDS_A)).toEqual(1);
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
            const { world, target } = await bayWorld({ maxAmmo: 1 });
            addDeployedFighter(world, 'test:someOtherBay', 'other fighter');
            press(world, BOARDER, 'board');
            expect(target.components.get(BayFighterComponent))
                .toEqual({ bayWeaponId: BAY_A });
        });

    it('treats MaxAmmo 0 as unbounded room', async () => {
        const { world, target } = await bayWorld({ maxAmmo: 0, roundsA: 99 });
        press(world, BOARDER, 'board');
        expect(target.components.get(BayFighterComponent))
            .toEqual({ bayWeaponId: BAY_A });
    });

    it('captures into the lowest-sorted bay id when two bays fit',
        async () => {
            const { world, target } = await bayWorld({ secondBay: true });
            press(world, BOARDER, 'board');
            expect(target.components.get(BayFighterComponent))
                .toEqual({ bayWeaponId: BAY_A });
        });

    it('uses the other bay when the lowest-sorted one is full', async () => {
        const { world, target } = await bayWorld({
            maxAmmo: 1, roundsA: 1, secondBay: true, roundsB: 0,
        });
        press(world, BOARDER, 'board');
        expect(target.components.get(BayFighterComponent))
            .toEqual({ bayWeaponId: BAY_B });
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
        const { world, target } = await bayWorld();
        const random = world.resources.get(RandomResource)!;
        const before = random.getState();
        press(world, BOARDER, 'board');
        expect(target.components.has(BayFighterComponent)).toBeTrue();
        expect(random.getState()).toEqual(before);
    });

    describe('precedence over the former-escort repair', () => {
        /** The hulk is durably marked as the boarder's (former) escort. */
        function markFormerEscort(world: World, target: Entity) {
            target.components.set(PlayerEscortComponent, { player: BOARDER });
            world.step();
        }

        it('bay-captures a former escort that fits with room', async () => {
            const { world, target } = await bayWorld();
            markFormerEscort(world, target);
            const repairs = recordRepairs(world);
            const captures = recordCaptures(world);

            press(world, BOARDER, 'board');

            expect(target.components.get(BayFighterComponent))
                .toEqual({ bayWeaponId: BAY_A });
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
});
