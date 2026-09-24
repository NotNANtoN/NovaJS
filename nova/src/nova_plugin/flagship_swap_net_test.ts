import 'jasmine';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { MockGameData } from 'novadatainterface/MockGameData';
import { DeterministicDelayedNetwork } from 'nova_ecs/plugins/delayed_network';
import { Comms, multiplayer, MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { makeShip } from './make_ship';
import { makeSystem } from './make_system';
import { PlatformResource } from './platform_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { createInitialPlayerState, PlayerStateComponent } from './player_state';
import { ShipComponent, ShipDataComponent } from './ship_plugin';
import { transferFlagship } from './flagship_swap';

describe('networked flagship swap', () => {
    it('updates the owner hull and cargo in flight', async () => {
        const gameData = new MockGameData();
        const shuttle = { ...getDefaultShipData(), id: 'nova:128', name: 'Shuttle', cargoCapacity: 10 };
        const pegasus = { ...getDefaultShipData(), id: 'nova:140', name: 'Pegasus', cargoCapacity: 60 };
        gameData.data.Ship.map.set(shuttle.id, shuttle);
        gameData.data.Ship.map.set(pegasus.id, pegasus);

        const network = new DeterministicDelayedNetwork({ delays: [40] });
        const server = makeSystem('nova:130', gameData);
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
        const ship = makeShip(shuttle);
        ship.components.set(PlayerStateComponent, createInitialPlayerState());
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

        const serverShip = server.entities.get('me')!;
        transferFlagship(serverShip.components.get(PlayerStateComponent)!,
            serverShip, 'nova:140', 'me');
        for (let i = 0; i < 60; i++) await step();

        const me = client.entities.get('me')!;
        expect(me.components.get(ShipComponent)?.id).toBe('nova:140');
        expect(me.components.get(ShipDataComponent)?.name).toBe('Pegasus');
        expect(me.components.get(PlayerStateComponent)?.cargoCapacity).toBe(60);
        expect(serverShip.components.get(ShipDataComponent)?.name).toBe('Pegasus');
    // 120 simulated network steps; slower CI runners exceed the 5 s default.
    }, 60_000);
});
