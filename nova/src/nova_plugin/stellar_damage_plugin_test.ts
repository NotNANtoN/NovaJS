import 'jasmine';
import { getDefaultPlanetData, PlanetData } from 'novadatainterface/PlanetData';
import { getDefaultProjectileWeaponData } from 'novadatainterface/WeaponData';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { MockGameData } from 'novadatainterface/MockGameData';
import { Entity } from 'nova_ecs/entity';
import { MultiplayerData, ReplicationMergeContext } from 'nova_ecs/plugins/multiplayer_plugin';
import { World } from 'nova_ecs/world';
import { mergeCombatPlayerState } from './combat_resources';
import { DamagedEvent } from './damage_events';
import { SourceComponent } from './fire_weapon_plugin';
import { makePlanet } from './make_planet';
import { makeShip } from './make_ship';
import { makeSystem } from './make_system';
import { PlatformResource } from './platform_plugin';
import { createInitialPlayerState, isStellarDestroyed, PlayerState, PlayerStateComponent } from './player_state';
import { StellarBlastComponent, StellarHealthComponent } from './stellar_blast';
import { recordPilotStellarDestruction } from './stellar_damage_plugin';

const PLANET: PlanetData = {
    ...getDefaultPlanetData(),
    id: 'nova:300', name: 'Target', strength: 100, deadTime: 4, deadType: -1,
    onDestroy: 'b50',
};
const damage = { ...getDefaultProjectileWeaponData().damage, armor: 30, shield: 10 };

function pilot(owner: string, gameDate = 7): Entity {
    const ship = makeShip({ ...getDefaultShipData(), id: 'nova:128' });
    const state = createInitialPlayerState();
    state.gameDate = gameDate;
    ship.components.set(PlayerStateComponent, state);
    ship.components.set(MultiplayerData, { owner });
    return ship;
}

function shot(world: World, uuid: string, source: string) {
    world.entities.set(uuid, new Entity().addComponent(SourceComponent, source));
}

function stateOf(world: World, uuid: string): PlayerState {
    return world.entities.get(uuid)!.components.get(PlayerStateComponent)!;
}

async function serverWorld() {
    const gameData = new MockGameData();
    gameData.data.Planet.map.set(PLANET.id, PLANET);
    const world = makeSystem('nova:130', gameData);
    world.resources.set(PlatformResource, 'node');
    const planet = makePlanet(PLANET);
    planet.components.set(MultiplayerData, { owner: 'server' });
    world.entities.set('planet', planet);
    world.entities.set('alice', pilot('alice-peer'));
    world.entities.set('bob', pilot('bob-peer'));
    world.entities.set('carol', pilot('carol-peer'));
    shot(world, 'alice-shot', 'alice');
    shot(world, 'bob-shot', 'bob');
    world.step();
    return world;
}

function hit(world: World, shotUuid: string) {
    world.emit(DamagedEvent, { damage, damager: shotUuid }, ['planet']);
    world.step();
}

describe('server stellar damage pool', () => {
    it('records destruction for every attacking pilot but not a bystander, then resets', async () => {
        const world = await serverWorld();
        hit(world, 'alice-shot');
        hit(world, 'bob-shot');
        const health = () => world.entities.get('planet')!.components.get(StellarHealthComponent)!;
        expect(health().current).toBe(20);
        expect(health().attackers.sort()).toEqual(['alice', 'bob']);
        expect(isStellarDestroyed(stateOf(world, 'alice'), PLANET.id)).toBeFalse();

        hit(world, 'alice-shot');
        for (const uuid of ['alice', 'bob']) {
            const state = stateOf(world, uuid);
            expect(isStellarDestroyed(state, PLANET.id)).withContext(uuid).toBeTrue();
            expect(state.stellarRegen).withContext(uuid).toEqual({ [PLANET.id]: 11 });
            expect(state.missionBits[50]).withContext(uuid).toBeTrue();
        }
        const bystander = stateOf(world, 'carol');
        expect(isStellarDestroyed(bystander, PLANET.id)).toBeFalse();
        expect(bystander.missionBits[50]).toBeFalsy();
        // The shared stellar is whole again for everyone else.
        expect(health()).toEqual({ current: 100, max: 100, attackers: [] });
        expect(world.entities.get('planet')!.components.get(StellarBlastComponent)!.seq).toBe(1);
    });

    it('ignores damage from a pilot who already destroyed it, and from non-players', async () => {
        const world = await serverWorld();
        stateOf(world, 'alice').destroyedStellars = [PLANET.id];
        hit(world, 'alice-shot');
        const health = world.entities.get('planet')!.components.get(StellarHealthComponent)!;
        expect(health.current).toBe(100);
        // An NPC's planet-type shot still wears the shared pool down but
        // credits nobody.
        const npc = makeShip({ ...getDefaultShipData(), id: 'nova:129' });
        npc.components.set(MultiplayerData, { owner: 'server' });
        world.entities.set('npc', npc);
        shot(world, 'npc-shot', 'npc');
        for (let i = 0; i < 3; i++) hit(world, 'npc-shot');
        expect(world.entities.get('planet')!.components.get(StellarBlastComponent)!.seq).toBe(1);
        expect(isStellarDestroyed(stateOf(world, 'bob'), PLANET.id)).toBeFalse();
        expect(isStellarDestroyed(stateOf(world, 'carol'), PLANET.id)).toBeFalse();
    });
});

describe('server-recorded destruction vs. stale owner writes', () => {
    it('keeps destroyedStellars/stellarRegen and OnDestroy bits until acknowledged', () => {
        const owner = 'stale-stellar-owner';
        const entities = new Map<string, Entity>();
        entities.set('me', pilot(owner));
        const stale = JSON.parse(JSON.stringify(
            entities.get('me')!.components.get(PlayerStateComponent)!)) as PlayerState;
        const gameData = new MockGameData();
        expect(recordPilotStellarDestruction(entities as any, 'me', PLANET, gameData)).toBeTrue();
        const local = entities.get('me')!.components.get(PlayerStateComponent)!;
        expect(isStellarDestroyed(local, PLANET.id)).toBeTrue();

        const context: ReplicationMergeContext = {
            source: owner, owner, localUuid: 'server', localIsAdmin: true, peerIsAdmin: false,
        };
        stale.credits = 999;
        const merged = mergeCombatPlayerState(local, stale, context);
        expect(merged.credits).toBe(999);
        expect(isStellarDestroyed(merged, PLANET.id)).toBeTrue();
        expect(merged.stellarRegen).toEqual({ [PLANET.id]: 11 });
        expect(merged.missionBits[50]).toBeTrue();

        // Once the owner echoes the destruction it is no longer forced, so
        // the pilot's own later regeneration wins.
        const echoed = { ...stale, destroyedStellars: [PLANET.id],
            stellarRegen: { [PLANET.id]: 11 },
            missionBits: stale.missionBits.map((bit, i) => i === 50 ? true : bit) };
        mergeCombatPlayerState(merged, echoed, context);
        const regenerated = { ...echoed, destroyedStellars: [], stellarRegen: {} };
        expect(isStellarDestroyed(mergeCombatPlayerState(merged, regenerated, context),
            PLANET.id)).toBeFalse();
    });
});
