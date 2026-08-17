import 'jasmine';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { v4 } from 'uuid';
import {
    getIntegrationGameData,
    makeSimulationBridgeHarness,
} from '../communication/simulation_test_fixture.js';
import { DamagedEvent, DeathEvent } from './death_plugin.js';
import { DisabledComponent } from './disabled_component.js';
import { ArmorComponent } from './health_plugin.js';
import { completeEntity } from './entity_data_loader.js';
import { MissionShipComponent } from './mission_ship_plugin.js';
import {
    GOAL_BOARD,
    GOAL_CHASE_OFF,
    GOAL_DESTROY,
    GOAL_DISABLE,
    GOAL_OBSERVE,
    ShipObjective,
    shipsToSpawn,
} from './mission_ship_state.js';
import { BoardedComponent } from './boarding_component.js';
import { CargoComponent } from './cargo_plugin.js';
import { missionCargoKey } from './mission_logic.js';
import { makeNpcShip } from './npc_spawn_plugin.js';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { ActiveMission, MissionsComponent } from './player_state_plugin.js';

const LETHAL_DAMAGE = {
    shield: 1e9, armor: 1e9, ionization: 0, ionizationColor: 0,
    knockback: 0, passThroughShield: true, recoil: 0,
} as never;

const MISSION_ID = 'nova:9999';

function makeObjective(goal: number, total: number): ShipObjective {
    return {
        goal,
        systemId: null,
        shipStart: 0,
        behavior: -1,
        dudeId: 'nova:240',
        total,
        satisfied: 0,
        complete: false,
        failed: false,
        shipDonePending: false,
        live: new Map(),
    };
}

function makeActive(objective: ShipObjective): ActiveMission {
    return {
        id: MISSION_ID,
        acceptedDay: 0,
        acceptedAt: 'nova:128',
        travelPlanet: null,
        returnPlanet: 'nova:128',
        cargoType: -1,
        cargoQty: 0,
        cargoLoaded: false,
        travelDone: false,
        deadlineDay: null,
        shipObjective: objective,
    };
}

describe('mission ships in the shared simulation', () => {
    async function makeWorldWithMissionShip(goal: number, total = 1) {
        const harness = await makeSimulationBridgeHarness();
        const { world, shipUuid } = harness;
        const gameData = await getIntegrationGameData();

        const objective = makeObjective(goal, total);
        const owner = world.entities.get(shipUuid)!;
        owner.components.set(MissionsComponent,
            new Map([[MISSION_ID, makeActive(objective)]]));

        const shipData = await gameData.data.Ship.get(harness.shipId);
        const missionShip = makeNpcShip(shipData, 3, null,
            new Position(500, 0), new Angle(0), new Vector(0, 0));
        missionShip.components.set(MissionShipComponent,
            { mission: MISSION_ID, owner: shipUuid });
        missionShip.components.set(MultiplayerData, { owner: 'server' });
        const missionShipUuid = v4();
        await completeEntity(world, missionShip);
        world.entities.set(missionShipUuid, missionShip);

        // Let async providers resolve (armor, weapons, ...).
        for (let i = 0; i < 60; i++) {
            world.step();
            await new Promise(resolve => setImmediate(resolve));
        }

        // Re-read the objective: components may have been replaced.
        const activeObjective = () => world.entities.get(shipUuid)
            ?.components.get(MissionsComponent)
            ?.get(MISSION_ID)?.shipObjective;
        return {
            world, shipUuid, missionShipUuid,
            deathDelay: shipData.deathDelay,
            activeObjective,
        };
    }

    async function killShip(
        world: Awaited<ReturnType<typeof makeWorldWithMissionShip>>['world'],
        uuid: string, deathDelay: number) {
        let died = false;
        world.events.get(DeathEvent).subscribe(() => { died = true; });
        world.emit(DamagedEvent,
            { damage: LETHAL_DAMAGE, damager: 'test' }, [uuid]);
        const deadline = Date.now() + (deathDelay + 5) * 1000;
        while (Date.now() < deadline && !died) {
            world.step();
            await new Promise(resolve => setImmediate(resolve));
        }
        for (let i = 0; i < 10; i++) {
            world.step();
        }
        return died;
    }

    it('registers inserted ships in the owner objective', async () => {
        const { activeObjective, missionShipUuid } =
            await makeWorldWithMissionShip(GOAL_DESTROY);
        const objective = activeObjective()!;
        expect(objective.live.has(missionShipUuid)).toBe(true);
        expect(objective.satisfied).toBe(0);
    }, 30_000);

    it('completes a destroy goal when the ship dies', async () => {
        const { world, missionShipUuid, deathDelay, activeObjective } =
            await makeWorldWithMissionShip(GOAL_DESTROY);
        const died = await killShip(world, missionShipUuid, deathDelay);
        expect(died).toBe(true);
        const objective = activeObjective()!;
        expect(objective.satisfied).toBe(1);
        expect(objective.complete).toBe(true);
        expect(objective.shipDonePending).toBe(true);
        expect(objective.live.size).toBe(0);
    }, 30_000);

    it('credits a chase-off goal when the ship leaves without dying',
        async () => {
            const { world, missionShipUuid, activeObjective } =
                await makeWorldWithMissionShip(GOAL_CHASE_OFF);
            // Stand-in for the NPC AI's jump-out deletion at the edge.
            world.entities.delete(missionShipUuid);
            for (let i = 0; i < 5; i++) {
                world.step();
            }
            const objective = activeObjective()!;
            expect(objective.satisfied).toBe(1);
            expect(objective.complete).toBe(true);
        }, 30_000);

    it('counts a disable goal when the ship becomes disabled', async () => {
        const { world, missionShipUuid, activeObjective } =
            await makeWorldWithMissionShip(GOAL_DISABLE);
        // Drop armor below the disable threshold; ShipDisableSystem
        // then disables the ship through the normal transition.
        const armor = world.entities.get(missionShipUuid)!.components
            .get(ArmorComponent)!;
        armor.current = armor.max * 0.05;
        for (let i = 0; i < 5; i++) {
            world.step();
        }
        expect(world.entities.get(missionShipUuid)!.components
            .has(DisabledComponent)).toBe(true);
        const objective = activeObjective()!;
        expect(objective.satisfied).toBe(1);
        expect(objective.complete).toBe(true);
    }, 30_000);

    it('observes a cloakless ship by co-presence', async () => {
        const { world, activeObjective } =
            await makeWorldWithMissionShip(GOAL_OBSERVE);
        for (let i = 0; i < 5; i++) {
            world.step();
        }
        const objective = activeObjective()!;
        expect(objective.satisfied).toBe(1);
        expect(objective.complete).toBe(true);
    }, 30_000);

    it('despawns mission ships whose owner left the simulation',
        async () => {
            const { world, shipUuid, missionShipUuid } =
                await makeWorldWithMissionShip(GOAL_DESTROY);
            expect(world.entities.has(missionShipUuid)).toBe(true);
            // The owner lands / jumps out: their entity leaves the sim.
            world.entities.delete(shipUuid);
            for (let i = 0; i < 5; i++) {
                world.step();
            }
            expect(world.entities.has(missionShipUuid)).toBe(false);
        }, 30_000);


    /**
     * ========================================================================
     * MISSION SHIPS ARE BOARDABLE — and a captured one stops being one
     * ========================================================================
     *
     * The Bible settles the first half outright. Two of the seven mïsn
     * ShipGoal values are about boarding a special ship: 2 is "Board
     * them" and 5 is "Rescue them (they start out disabled and stay that
     * way until you board them)". mïsn Flags 0x0001 says the mission
     * "will auto-abort after the special ship is boarded", and mïsn
     * PickupMode 2 is "Pick up when boarding special ship". So mission
     * ships are boarded on purpose, and a board by the OWNER is goal
     * progress.
     *
     * CAPTURING one is undocumented — the Bible's only word on missions
     * and plunder is the exclusion in gövt Flags 0x1000 ("non-mission"),
     * which keeps NPC pirates off them. Matthew's ruling fills the gap:
     * the capture is allowed, and the prize SHEDS its mission-special
     * identity, so the mission's own housekeeping can no longer reach
     * it. The alternative — teaching every mission system to skip ships
     * that are now player escorts — would have to be repeated in the
     * cleanup, the tracker and the respawn count; dropping the tag does
     * all three at once.
     */
    describe('boarding and capturing mission special ships', () => {
        it('credits a board goal when the OWNER boards the ship',
            async () => {
                const { world, shipUuid, missionShipUuid, activeObjective } =
                    await makeWorldWithMissionShip(GOAL_BOARD);
                world.entities.get(missionShipUuid)!.components
                    .set(BoardedComponent,
                        { boarder: shipUuid, plundered: true });
                for (let i = 0; i < 5; i++) {
                    world.step();
                }
                const objective = activeObjective()!;
                expect(objective.satisfied).toBe(1);
                expect(objective.complete).toBe(true);
            }, 30_000);

        it('does not credit a board by somebody else', async () => {
            // The durable record names whoever spent the hulk's one
            // plunder, and that can be a rival player. Only the mission's
            // own player boarding it is progress.
            const { world, missionShipUuid, activeObjective } =
                await makeWorldWithMissionShip(GOAL_BOARD);
            world.entities.get(missionShipUuid)!.components
                .set(BoardedComponent,
                    { boarder: 'some rival', plundered: true });
            for (let i = 0; i < 5; i++) {
                world.step();
            }
            expect(activeObjective()!.satisfied).toBe(0);
        }, 30_000);

        it('picks up mïsn PickupMode 2 cargo the tick the owner boards',
            async () => {
                // Bible, mïsn PickupMode: "2  Pick up when boarding
                // special ship". The stock case is mïsn 832, Temmin
                // Shard's Leviathan — ShipGoal 2, PickupMode 2,
                // DropOffMode 1 — whose cargo would otherwise never load,
                // so DropOffMode 1 would never drop it and the mission
                // could not be completed.
                //
                // It is AUTOMATIC, not a dialog button: it keys off the
                // same durable BoardedComponent record the goal credit
                // does, so it survives every way a boarding can end early
                // (a one-shot bay capture opens no dialog at all, and a
                // repelled capture closes it on the same tick).
                const { world, shipUuid, missionShipUuid, activeObjective } =
                    await makeWorldWithMissionShip(GOAL_BOARD);
                const owner = world.entities.get(shipUuid)!;
                const active = owner.components.get(MissionsComponent)!
                    .get(MISSION_ID)!;
                active.pickupOnBoard = true;
                active.cargoType = 6;
                active.cargoQty = 2;
                expect(active.cargoLoaded).toBeFalse();

                world.entities.get(missionShipUuid)!.components
                    .set(BoardedComponent,
                        { boarder: shipUuid, plundered: true });
                for (let i = 0; i < 5; i++) {
                    world.step();
                }

                const carried = owner.components.get(MissionsComponent)!
                    .get(MISSION_ID)!;
                expect(carried.cargoLoaded).toBeTrue();
                expect(owner.components.get(CargoComponent)!
                    .get(missionCargoKey(MISSION_ID))).toEqual(2);
                // The goal credited on the same boarding — one channel.
                expect(activeObjective()!.satisfied).toBe(1);
            }, 30_000);

        it('does not pick up for a mission without PickupMode 2',
            async () => {
                const { world, shipUuid, missionShipUuid } =
                    await makeWorldWithMissionShip(GOAL_BOARD);
                const owner = world.entities.get(shipUuid)!;
                const active = owner.components.get(MissionsComponent)!
                    .get(MISSION_ID)!;
                active.cargoType = 6;
                active.cargoQty = 2;
                world.entities.get(missionShipUuid)!.components
                    .set(BoardedComponent,
                        { boarder: shipUuid, plundered: true });
                for (let i = 0; i < 5; i++) {
                    world.step();
                }
                expect(owner.components.get(MissionsComponent)!
                    .get(MISSION_ID)!.cargoLoaded).toBeFalse();
                expect(owner.components.get(CargoComponent)!
                    .get(missionCargoKey(MISSION_ID))).toBeUndefined();
            }, 30_000);

        it('does not double-load the cargo on later ticks', async () => {
            const { world, shipUuid, missionShipUuid } =
                await makeWorldWithMissionShip(GOAL_BOARD);
            const owner = world.entities.get(shipUuid)!;
            const active = owner.components.get(MissionsComponent)!
                .get(MISSION_ID)!;
            active.pickupOnBoard = true;
            active.cargoType = 6;
            active.cargoQty = 2;
            world.entities.get(missionShipUuid)!.components
                .set(BoardedComponent,
                    { boarder: shipUuid, plundered: true });
            for (let i = 0; i < 40; i++) {
                world.step();
            }
            expect(owner.components.get(CargoComponent)!
                .get(missionCargoKey(MISSION_ID))).toEqual(2);
        }, 30_000);

        it('keeps a captured prize when the mission ends', async () => {
            // The regression this pins: MissionShipCleanupSystem deletes
            // any mission ship whose owner has lost the mission, which
            // would VAPORISE the player's new escort the moment the
            // mission was completed or aborted. Shedding the tag on
            // capture (convertToEscort) is what saves it.
            const { world, shipUuid, missionShipUuid } =
                await makeWorldWithMissionShip(GOAL_DESTROY);
            expect(world.entities.get(missionShipUuid)!.components
                .has(MissionShipComponent)).toBe(true);

            // What capture does to the hull, in one line.
            world.entities.get(missionShipUuid)!.components
                .delete(MissionShipComponent);
            // The mission then ends.
            world.entities.get(shipUuid)!.components
                .set(MissionsComponent, new Map());
            for (let i = 0; i < 5; i++) {
                world.step();
            }
            expect(world.entities.has(missionShipUuid)).toBe(true);
        }, 30_000);

        it('stops tracking a captured prize, so the mission respawns a '
            + 'replacement instead of counting the prize', async () => {
                // shipsToSpawn is total - satisfied, and the prize is no
                // longer registered in `live`, so the objective is exactly
                // where it was before the ship existed: the next system
                // entry spawns a fresh one and the escort is left alone.
                const { world, missionShipUuid, activeObjective } =
                    await makeWorldWithMissionShip(GOAL_DESTROY);
                expect(activeObjective()!.live.has(missionShipUuid))
                    .toBe(true);

                world.entities.get(missionShipUuid)!.components
                    .delete(MissionShipComponent);
                // The tracker no longer re-registers it; the departure
                // sweep leaves it alone too, because it is still in the
                // world.
                activeObjective()!.live.delete(missionShipUuid);
                for (let i = 0; i < 5; i++) {
                    world.step();
                }
                const objective = activeObjective()!;
                expect(objective.live.has(missionShipUuid)).toBe(false);
                expect(objective.satisfied).toBe(0);
                expect(shipsToSpawn(objective)).toBe(1);
                expect(world.entities.has(missionShipUuid)).toBe(true);
            }, 30_000);
    });

    it('despawns mission ships whose mission is gone', async () => {
        const { world, shipUuid, missionShipUuid } =
            await makeWorldWithMissionShip(GOAL_DESTROY);
        world.entities.get(shipUuid)!.components
            .set(MissionsComponent, new Map());
        for (let i = 0; i < 5; i++) {
            world.step();
        }
        expect(world.entities.has(missionShipUuid)).toBe(false);
    }, 30_000);

    describe('failIfPlayerDisabledOrDestroyed (Flags2 0x0004)', () => {
        // A player mission (no special ships) carrying the frozen flag.
        function flaggedMission(flag: boolean): ActiveMission {
            return {
                id: 'nova:9998',
                acceptedDay: 0, acceptedAt: 'nova:128',
                travelPlanet: null, returnPlanet: 'nova:128',
                cargoType: -1, cargoQty: 0, cargoLoaded: false,
                travelDone: false, deadlineDay: null,
                failIfPlayerDisabledOrDestroyed: flag,
            };
        }
        async function makeWorldWithPlayerMission(flag: boolean) {
            const harness = await makeSimulationBridgeHarness();
            const { world, shipUuid } = harness;
            const gameData = await getIntegrationGameData();
            world.entities.get(shipUuid)!.components.set(MissionsComponent,
                new Map([['nova:9998', flaggedMission(flag)]]));
            for (let i = 0; i < 60; i++) {
                world.step();
                await new Promise(resolve => setImmediate(resolve));
            }
            const shipData = await gameData.data.Ship.get(harness.shipId);
            const activeMission = () => world.entities.get(shipUuid)
                ?.components.get(MissionsComponent)?.get('nova:9998');
            return { world, shipUuid, deathDelay: shipData.deathDelay,
                activeMission };
        }

        it('fails the mission when the player is disabled', async () => {
            const { world, shipUuid, activeMission } =
                await makeWorldWithPlayerMission(true);
            const armor = world.entities.get(shipUuid)!.components
                .get(ArmorComponent)!;
            armor.current = armor.max * 0.05;
            for (let i = 0; i < 5; i++) {
                world.step();
            }
            expect(world.entities.get(shipUuid)!.components
                .has(DisabledComponent)).toBe(true);
            expect(activeMission()!.failed).toBe(true);
        }, 30_000);

        it('leaves the mission alone without the flag', async () => {
            const { world, shipUuid, activeMission } =
                await makeWorldWithPlayerMission(false);
            const armor = world.entities.get(shipUuid)!.components
                .get(ArmorComponent)!;
            armor.current = armor.max * 0.05;
            for (let i = 0; i < 5; i++) {
                world.step();
            }
            expect(activeMission()!.failed).toBeFalsy();
        }, 30_000);
    });
});
