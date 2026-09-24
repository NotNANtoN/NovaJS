import 'jasmine';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { getDefaultSystemData } from 'novadatainterface/SystemData';
import { MockGameData } from 'novadatainterface/MockGameData';
import { Position } from 'nova_ecs/datatypes/position';
import { DeterministicDelayedNetwork } from 'nova_ecs/plugins/delayed_network';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { Comms, multiplayer, MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { makeShip } from './make_ship';
import { makeSystem } from './make_system';
import { PlatformResource } from './platform_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { createInitialPlayerState, PlayerStateComponent } from './player_state';
import { JumpRouteComponent, JumpStateComponent } from './jump_plugin';
import { HYPERSPACE_WINDUP_SOUND_ID, SoundEvent } from './sound_event';
import { ControlStateEvent } from './control_state_event';

describe('networked hyperjump audio', () => {
    for (const inputPrediction of [true, false]) {
        it(`plays the wind-up once spooling starts (prediction=${inputPrediction})`, async () => {
            const gameData = new MockGameData();
            gameData.data.System.map.set('nova:130', {
                ...getDefaultSystemData(), id: 'nova:130', position: [0, 0],
                links: ['nova:131'], planets: [],
            });
            gameData.data.System.map.set('nova:131', {
                ...getDefaultSystemData(), id: 'nova:131', position: [100, 0],
                links: ['nova:130'], planets: [],
            });
            const network = new DeterministicDelayedNetwork({ delays: [60, 90, 40] });
            const server = makeSystem('nova:130', gameData);
            server.resources.set(PlatformResource, 'node');
            await server.addPlugin(multiplayer(network.connect('server')));
            const client = makeSystem('nova:130', gameData);
            client.resources.set(PlatformResource, 'browser');
            await client.addPlugin(multiplayer(network.connect('pilot'), undefined,
                { inputPrediction }));
            for (const w of [server, client]) {
                w.resources.get(TimeResource)!.fixedDelta_ms = 1000 / 60;
                w.singletonEntity.components.get(Comms)!.admins = new Set(['server']);
            }
            await gameData.data.System.get('nova:130');
            await gameData.data.System.get('nova:131');
            const ship = makeShip({ ...getDefaultShipData(), id: 'nova:128', name: 'Shuttle' });
            ship.components.set(PlayerStateComponent,
                { ...createInitialPlayerState(), fuel: 300 });
            ship.components.set(MultiplayerData, { owner: 'pilot' });
            ship.components.set(PlayerShipSelector, undefined);
            client.entities.set('me', ship);
            const sounds: string[] = [];
            client.events.get(SoundEvent).subscribe(
                e => sounds.push(`${e.id}${e.stop ? ':stop' : ''}`));
            const step = async () => {
                client.step();
                server.step();
                network.advance();
                await new Promise(r => setTimeout(r, 0));
            };
            for (let i = 0; i < 60; i++) await step();

            // Far enough from the system center to be allowed to jump, on
            // both sides so prediction has nothing to reconcile away.
            for (const world of [client, server]) {
                const movement = world.entities.get('me')
                    ?.components.get(MovementStateComponent);
                if (movement) movement.position = new Position(3000, 0);
            }
            client.entities.get('me')!.components.get(JumpRouteComponent)!.route = ['nova:131'];
            for (let i = 0; i < 10; i++) await step();

            client.emit(ControlStateEvent, new Map([['hyperjump', 'start']]), ['me']);
            const phases: string[] = [];
            for (let i = 0; i < 400; i++) {
                await step();
                const phase = client.entities.get('me')
                    ?.components.get(JumpStateComponent)?.phase ?? 'none';
                if (phases.at(-1) !== phase) phases.push(phase);
            }
            // Nothing here performs the system transfer, so the server may
            // re-send its departing copy after the client drops the ship.
            expect(phases.slice(0, 4)).toEqual(['braking', 'spooling', 'departing', 'none']);
            expect(sounds.filter(s => s === HYPERSPACE_WINDUP_SOUND_ID).length).toBe(1);
        });
    }
});
