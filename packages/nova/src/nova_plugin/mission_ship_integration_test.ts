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
    GOAL_CHASE_OFF,
    GOAL_DESTROY,
    GOAL_DISABLE,
    GOAL_OBSERVE,
    ShipObjective,
} from './mission_ship_state.js';
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
