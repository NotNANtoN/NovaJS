import 'jasmine';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { getDefaultMissionData, MissionData } from 'novadatainterface/MissionData';
import { MockGameData } from 'novadatainterface/MockGameData';
import { DeterministicDelayedNetwork } from 'nova_ecs/plugins/delayed_network';
import { Comms, multiplayer, MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import { DeathEvent } from './death_plugin';
import { makeShip } from './make_ship';
import { makeSystem } from './make_system';
import { MissionShipComponent } from './mission_ship_plugin';
import { PlatformResource } from './platform_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { createInitialPlayerState, decodePlayerState, PlayerState, PlayerStateComponent } from './player_state';
import { plainSnapshot } from 'nova_ecs/draft_snapshot';

/**
 * Special-ship goals are observed by the server. recordShipGoal awaits
 * mission data, so the PlayerState it was handed (a Query draft) is revoked
 * before it writes. These specs run the real systems through world steps and
 * replication to prove the progress lands on the server, reaches the owning
 * client, and survives the client's next owner write.
 */
describe('networked special-ship goal recording', () => {
    const store = {
        ready: Promise.resolve(), getTokenForPeer: () => 'tok', get: async () => undefined,
        save: async () => undefined, bindPeer() { }, getSnapshots: async () => [],
    } as any;

    async function setup(shipCount = 1) {
        const gameData = new MockGameData();
        const shuttle = { ...getDefaultShipData(), id: 'nova:128', name: 'Shuttle' };
        gameData.data.Ship.map.set(shuttle.id, shuttle);
        const mission: MissionData = {
            ...getDefaultMissionData(),
            id: 'nova:900', name: 'Kill the pirate',
            shipGoal: 0, shipCount, shipSyst: -1,
            onShipDone: 'b77',
        };
        gameData.data.Mission!.map.set(mission.id, mission);

        const network = new DeterministicDelayedNetwork({ delays: [40] });
        const server = makeSystem('nova:130', gameData, store);
        server.resources.set(PlatformResource, 'node');
        await server.addPlugin(multiplayer(network.connect('server')));
        const client = makeSystem('nova:130', gameData);
        client.resources.set(PlatformResource, 'browser');
        await client.addPlugin(multiplayer(network.connect('pilot'), undefined,
            { inputPrediction: true }));
        for (const w of [server, client]) {
            w.resources.get(TimeResource)!.fixedDelta_ms = 1000 / 60;
            w.singletonEntity.components.get(Comms)!.admins = new Set(['server']);
        }
        const state = createInitialPlayerState();
        state.activeMissions = [{
            missionId: mission.id, state: 'active', missionUuid: 'mission-uuid',
            acceptedDate: 0,
        }];
        const ship = makeShip(shuttle);
        ship.components.set(PlayerStateComponent, state);
        ship.components.set(MultiplayerData, { owner: 'pilot' });
        ship.components.set(PlayerShipSelector, undefined);
        client.entities.set('me', ship);
        const step = async () => {
            client.step();
            server.step();
            network.advance();
            await new Promise(r => setTimeout(r, 0));
        };
        for (let i = 0; i < 60; i++) await step();
        return { server, client, step, shuttle };
    }

    function killTarget(server: World, shuttle: ReturnType<typeof getDefaultShipData>, uuid: string) {
        const target = makeShip(shuttle);
        target.components.set(MultiplayerData, { owner: 'server' });
        target.components.set(MissionShipComponent, {
            missionUuid: 'mission-uuid', playerToken: 'tok',
        });
        server.entities.set(uuid, target);
        server.emit(DeathEvent, server.resources.get(TimeResource)!, [uuid]);
    }

    function progress(world: World): PlayerState['activeMissions'][number] | undefined {
        return world.entities.get('me')?.components.get(PlayerStateComponent)
            ?.activeMissions.find(entry => entry.missionUuid === 'mission-uuid');
    }

    function bit(world: World, index: number) {
        return world.entities.get('me')?.components.get(PlayerStateComponent)
            ?.missionBits[index];
    }

    it('records a destroyed target on the server and the owning client', async () => {
        const { server, client, step, shuttle } = await setup();
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown) => rejections.push(reason);
        process.on('unhandledRejection', onRejection);
        try {
            killTarget(server, shuttle, 'target');
            for (let i = 0; i < 60; i++) await step();
        } finally {
            process.off('unhandledRejection', onRejection);
        }
        expect(rejections).toEqual([]);
        expect(progress(server)?.shipGoalProgress?.destroyed).toBe(1);
        expect(progress(server)?.shipGoalProgress?.completed).toBeTrue();
        expect(bit(server, 77)).toBeTrue();
        expect(progress(client)?.shipGoalProgress?.destroyed).toBe(1);
        expect(progress(client)?.shipGoalProgress?.shipDoneApplied).toBeTrue();
        expect(bit(client, 77)).toBeTrue();
    }, 60_000);

    it('keeps server progress when the owner keeps writing its PlayerState', async () => {
        const { server, client, step, shuttle } = await setup(2);
        const me = () => client.entities.get('me')!.components.get(PlayerStateComponent)!;
        killTarget(server, shuttle, 'target-1');
        // The owner keeps authoring its own state while the server records
        // the kill: credits change every step so every client write is a
        // complete, pre-kill basis for mission progress.
        for (let i = 0; i < 60; i++) {
            me().credits += 1;
            await step();
        }
        expect(progress(server)?.shipGoalProgress?.destroyed).toBe(1);
        killTarget(server, shuttle, 'target-2');
        for (let i = 0; i < 60; i++) {
            me().credits += 1;
            await step();
        }
        for (let i = 0; i < 10; i++) await step();
        expect(progress(server)?.shipGoalProgress?.destroyed).toBe(2);
        expect(bit(server, 77)).toBeTrue();
        // The owner's own edits still win for fields it authors.
        expect(server.entities.get('me')!.components.get(PlayerStateComponent)!.credits)
            .toBe(me().credits);
        expect(progress(client)?.shipGoalProgress?.destroyed).toBe(2);
        expect(bit(client, 77)).toBeTrue();
    }, 60_000);

    it('survives a stale full-state replacement from the owner', async () => {
        const { server, client, step, shuttle } = await setup();
        const entity = client.entities.get('me')!;
        // A copy taken before the kill (e.g. a dialog holding its own state)
        // and written back afterwards replaces the whole component.
        const stale = decodePlayerState(plainSnapshot(
            entity.components.get(PlayerStateComponent)!));
        if (stale._tag === 'Left') throw new Error('invalid state');
        killTarget(server, shuttle, 'target');
        for (let i = 0; i < 60; i++) await step();
        expect(progress(client)?.shipGoalProgress?.destroyed).toBe(1);
        stale.right.credits = 4242;
        entity.components.set(PlayerStateComponent, stale.right);
        for (let i = 0; i < 60; i++) await step();
        const serverState = server.entities.get('me')!.components.get(PlayerStateComponent)!;
        expect(serverState.credits).toBe(4242);
        expect(progress(server)?.shipGoalProgress?.destroyed).withContext('server progress').toBe(1);
        expect(bit(server, 77)).withContext('server bit').toBeTrue();
        // The server re-sends the merged state so the owner converges too.
        expect(progress(client)?.shipGoalProgress?.destroyed).withContext('client progress').toBe(1);
        expect(bit(client, 77)).withContext('client bit').toBeTrue();
        expect(client.entities.get('me')!.components.get(PlayerStateComponent)!.credits)
            .toBe(4242);
    }, 60_000);
});
