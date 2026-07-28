import 'jasmine';
import { Angle, Vector } from 'nova_ecs/datatypes/vector';
import { Position } from 'nova_ecs/datatypes/position';
import { Entity } from 'nova_ecs/entity';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { World } from 'nova_ecs/world';
import { UUID } from 'nova_ecs/arg_types';
import { System } from 'nova_ecs/system';
import { getIntegrationGameData } from '../communication/simulation_test_fixture.js';
import { EscortRepairedEvent } from './boarding_plugin.js';
import { BoardedComponent, BoardingComponent } from './boarding_component.js';
import { isBelowDisableThreshold } from './disabled_component.js';
import { CargoComponent } from './cargo_plugin.js';
import { DisabledComponent } from './disabled_component.js';
import { completeEntity } from './entity_data_loader.js';
import { EscortCommandComponent } from './escort_command.js';
import { FiringGroupComponent } from './firing_group.js';
import { GovtComponent } from './govt_component.js';
import { ArmorComponent, FuelComponent, ShieldComponent } from './health_plugin.js';
import { makeShip } from './make_ship.js';
import { makeSystem } from './make_system.js';
import { FormationComponent } from './npc_ai_plugin.js';
import { CreditsComponent } from './player_state_plugin.js';
import { LegalRecordsComponent } from './reputation_plugin.js';
import { ShipControlEvent, ShipControlStateComponent } from './ship_control.js';
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
