import 'jasmine';
import { getDefaultPlanetData, PlanetData } from 'novadatainterface/PlanetData';
import { getDefaultProjectileWeaponData } from 'novadatainterface/WeaponData';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { getDefaultSystemData } from 'novadatainterface/SystemData';
import { MockGameData } from 'novadatainterface/MockGameData';
import { plainSnapshot } from 'nova_ecs/draft_snapshot';
import { Entity } from 'nova_ecs/entity';
import { DeterministicDelayedNetwork } from 'nova_ecs/plugins/delayed_network';
import { Comms, multiplayer, MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import { DamagedEvent } from './damage_events';
import { SourceComponent } from './fire_weapon_plugin';
import { makeShip } from './make_ship';
import { makeSystem } from './make_system';
import { PlatformResource } from './platform_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { createInitialPlayerState, decodePlayerState, isStellarDestroyed, PlayerStateComponent } from './player_state';
import { StellarBlastComponent } from './stellar_blast';
import { stellarPresentation } from './stellar_visibility';

const PLANET: PlanetData = {
    ...getDefaultPlanetData(),
    id: 'nova:300', name: 'Target', strength: 100, deadTime: 4, deadType: -1,
    onDestroy: 'b50', position: [0, 0],
};
const PLANET_UUID = `planet ${PLANET.id}`;

/**
 * The room shares the fight, each pilot owns the outcome: the server breaks
 * the shared pool, records the destruction on the attacker's PlayerState, the
 * owning client receives it (and keeps it through a stale write), while the
 * other pilot in the room keeps the planet.
 */
describe('networked stellar destruction', () => {
    const store = {
        ready: Promise.resolve(), getTokenForPeer: (peer: string) => `tok-${peer}`,
        get: async () => undefined, save: async () => undefined, bindPeer() { },
        getSnapshots: async () => [],
    } as any;

    async function setup() {
        const gameData = new MockGameData();
        gameData.data.Planet.map.set(PLANET.id, PLANET);
        gameData.data.System.map.set('nova:130', {
            ...getDefaultSystemData(), id: 'nova:130', planets: [PLANET.id],
        });
        const shuttle = { ...getDefaultShipData(), id: 'nova:128', name: 'Shuttle' };
        gameData.data.Ship.map.set(shuttle.id, shuttle);

        const network = new DeterministicDelayedNetwork({ delays: [40] });
        const server = makeSystem('nova:130', gameData, store);
        server.resources.set(PlatformResource, 'node');
        await server.addPlugin(multiplayer(network.connect('server')));
        const clients: World[] = [];
        for (const peer of ['alice', 'bob']) {
            const client = makeSystem('nova:130', gameData);
            client.resources.set(PlatformResource, 'browser');
            await client.addPlugin(multiplayer(network.connect(peer), undefined,
                { inputPrediction: true }));
            const ship = makeShip(shuttle);
            ship.components.set(PlayerStateComponent, createInitialPlayerState());
            ship.components.set(MultiplayerData, { owner: peer });
            ship.components.set(PlayerShipSelector, undefined);
            client.entities.set(peer, ship);
            clients.push(client);
        }
        for (const w of [server, ...clients]) {
            w.resources.get(TimeResource)!.fixedDelta_ms = 1000 / 60;
            w.singletonEntity.components.get(Comms)!.admins = new Set(['server']);
        }
        const step = async () => {
            for (const client of clients) client.step();
            server.step();
            network.advance();
            await new Promise(r => setTimeout(r, 0));
        };
        for (let i = 0; i < 60; i++) await step();
        return { server, alice: clients[0], bob: clients[1], step };
    }

    function destroyFor(server: World, attacker: string) {
        server.entities.set('shot', new Entity().addComponent(SourceComponent, attacker));
        server.emit(DamagedEvent, {
            damage: { ...getDefaultProjectileWeaponData().damage, armor: 200, shield: 0 },
            damager: 'shot',
        }, [PLANET_UUID]);
    }

    function state(world: World, uuid: string) {
        return world.entities.get(uuid)!.components.get(PlayerStateComponent)!;
    }

    it('destroys the planet only for the attacking pilot', async () => {
        const { server, alice, bob, step } = await setup();
        expect(server.entities.has(PLANET_UUID)).toBeTrue();
        expect(server.entities.has('alice')).toBeTrue();
        destroyFor(server, 'alice');
        for (let i = 0; i < 60; i++) await step();

        expect(isStellarDestroyed(state(server, 'alice'), PLANET.id)).toBeTrue();
        expect(state(server, 'alice').missionBits[50]).toBeTrue();
        expect(isStellarDestroyed(state(alice, 'alice'), PLANET.id))
            .withContext('owning client').toBeTrue();
        expect(state(alice, 'alice').missionBits[50]).toBeTrue();
        expect(isStellarDestroyed(state(server, 'bob'), PLANET.id)).toBeFalse();
        expect(isStellarDestroyed(state(bob, 'bob'), PLANET.id)).toBeFalse();

        // Alice's client hides it; Bob's keeps showing it.
        expect(stellarPresentation(state(alice, 'alice'), PLANET)).toBe('hidden');
        expect(stellarPresentation(state(bob, 'bob'), PLANET)).toBe('normal');
        // Everyone learns about the blast (for the cosmetic explosion).
        for (const world of [alice, bob]) {
            expect(world.entities.get(PLANET_UUID)?.components
                .get(StellarBlastComponent)?.seq).toBe(1);
        }
    }, 60_000);

    it('survives a stale full-state replacement from the owner', async () => {
        const { server, alice, step } = await setup();
        const entity = alice.entities.get('alice')!;
        const stale = decodePlayerState(plainSnapshot(
            entity.components.get(PlayerStateComponent)!));
        if (stale._tag === 'Left') throw new Error('invalid state');
        destroyFor(server, 'alice');
        for (let i = 0; i < 60; i++) await step();
        expect(isStellarDestroyed(state(alice, 'alice'), PLANET.id)).toBeTrue();

        stale.right.credits = 4242;
        entity.components.set(PlayerStateComponent, stale.right);
        for (let i = 0; i < 60; i++) await step();
        expect(state(server, 'alice').credits).toBe(4242);
        expect(isStellarDestroyed(state(server, 'alice'), PLANET.id))
            .withContext('server').toBeTrue();
        expect(state(server, 'alice').stellarRegen?.[PLANET.id]).toBe(4);
        expect(isStellarDestroyed(state(alice, 'alice'), PLANET.id))
            .withContext('client converges').toBeTrue();
        expect(state(alice, 'alice').credits).toBe(4242);
    }, 60_000);
});
