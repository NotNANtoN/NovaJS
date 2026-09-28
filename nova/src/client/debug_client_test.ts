import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { getDefaultMissionData, MissionData } from 'novadatainterface/MissionData';
import { MockGameData } from 'novadatainterface/MockGameData';
import { getDefaultOutfitData } from 'novadatainterface/OutfitData';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { getDefaultSystemData } from 'novadatainterface/SystemData';
import { getDefaultProjectileWeaponData } from 'novadatainterface/WeaponData';
import { PLANET_BUSTER_OUTFIT_ID } from '../common/debug_content';
import { registerCombatAmmoIds } from '../nova_plugin/combat_resources';
import { MissionRuntime, MissionRuntimeResource } from '../nova_plugin/mission_plugin';
import { NcbRuntime, NcbRuntimeResource, PendingMissionJumpComponent } from '../nova_plugin/ncb_runtime';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin';
import { createInitialPlayerState, PlayerStateComponent } from '../nova_plugin/player_state';
import { ShipComponent, ShipDataComponent } from '../nova_plugin/ship_plugin';
import { SystemIdResource } from '../nova_plugin/system_id_resource';
import { DebugClient, entryKey } from './debug_client';

describe('DebugClient', () => {
    let gameData: MockGameData;
    let world: World;
    let entity: Entity;
    let requests: Array<Record<string, any>>;
    let reply: (body: Record<string, any>) => Record<string, unknown>;
    let client: DebugClient;

    const shuttle = { ...getDefaultShipData(), id: 'nova:128', name: 'Shuttle',
        cargoCapacity: 10, fuelCapacity: 300, outfits: {} };
    const kestrel = { ...getDefaultShipData(), id: 'nova:381', name: 'Kestrel',
        cargoCapacity: 60, fuelCapacity: 200, outfits: { 'nova:138': 1, 'nova:139': 4 } };

    beforeEach(() => {
        gameData = new MockGameData();
        gameData.data.Ship.map.set(shuttle.id, shuttle);
        gameData.data.Ship.map.set(kestrel.id, kestrel);
        gameData.data.Outfit.map.set('nova:139', { ...getDefaultOutfitData(), id: 'nova:139', name: 'Missile' });
        gameData.data.Outfit.map.set('nova:150', { ...getDefaultOutfitData(), id: 'nova:150', name: 'Laser' });
        gameData.data.Outfit.map.set(PLANET_BUSTER_OUTFIT_ID, { ...getDefaultOutfitData(),
            id: PLANET_BUSTER_OUTFIT_ID, name: 'Planet Buster' });
        gameData.data.Weapon.map.set('nova:136', { ...getDefaultProjectileWeaponData(), id: 'nova:136',
            ammoType: ['outfit', 'nova:139'] });
        gameData.data.System.map.set('nova:130', { ...getDefaultSystemData(), id: 'nova:130', planets: ['nova:128'] });
        registerCombatAmmoIds(['nova:139']);

        world = new World();
        world.resources.set(SystemIdResource, 'nova:130');
        world.resources.set(NcbRuntimeResource, new NcbRuntime(gameData, { requestShipGrant: async () => undefined }));
        world.resources.set(MissionRuntimeResource, new MissionRuntime(gameData));
        entity = new Entity();
        const state = createInitialPlayerState();
        state.shipId = shuttle.id;
        state.currentSystem = 'nova:130';
        state.lastLandedPlanet = 'nova:128';
        state.credits = 500;
        entity.components.set(PlayerStateComponent, state);
        entity.components.set(ShipComponent, { id: shuttle.id });
        entity.components.set(OutfitsStateComponent, new Map([['nova:150', { count: 1 }]]));

        requests = [];
        reply = () => ({ ok: true });
        const fetchImpl = async (_url: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            requests.push(body);
            const result = reply(body);
            return { ok: true, status: 200, text: async () => '', json: async () => result };
        };
        client = new DebugClient('dbg', 'pilot', {
            gameData, player: () => ({ entity, world }),
        }, fetchImpl);
    });

    const state = () => entity.components.get(PlayerStateComponent)!;

    it('adopts a server hull change: hull, receipt, cargo and stock outfits', async () => {
        reply = body => body.action === 'ship' ? { ok: true, credits: 500,
            balance: { shipId: 'nova:381', fuel: 200, ammo: { 'nova:139': 4 }, revision: 9 } } : { ok: true };
        await client.switchShip('nova:381');
        expect(requests[0]).toEqual(jasmine.objectContaining({ action: 'ship', shipId: 'nova:381',
            token: 'dbg', playerToken: 'pilot' }));
        expect(state().shipId).toBe('nova:381');
        expect(state().fuel).toBe(200);
        expect(state().combatResources?.revision).toBe(9);
        expect(state().cargoCapacity).toBe(60);
        expect(entity.components.get(ShipComponent)?.id).toBe('nova:381');
        expect(entity.components.get(ShipDataComponent)?.id).toBe('nova:381');
        const outfits = entity.components.get(OutfitsStateComponent)!;
        expect(outfits.get('nova:138')?.count).toBe(1);
        expect(outfits.get('nova:139')?.count).toBe(4);
        expect(outfits.has('nova:150')).toBeFalse();
    });

    it('routes ammunition through the server ledger and other outfits locally', async () => {
        reply = body => body.action === 'ammo' ? { ok: true, credits: 500,
            balance: { shipId: 'nova:128', fuel: 300, ammo: { 'nova:139': body.count }, revision: 3 } } : { ok: true };
        await client.adjustOutfit('nova:139', 5);
        expect(requests[0]).toEqual(jasmine.objectContaining({ action: 'ammo', outfitId: 'nova:139', count: 5 }));
        expect(entity.components.get(OutfitsStateComponent)!.get('nova:139')?.count).toBe(5);

        await client.adjustOutfit('nova:150', 2);
        expect(entity.components.get(OutfitsStateComponent)!.get('nova:150')?.count).toBe(3);
        expect(requests.at(-1)).toEqual(jasmine.objectContaining({ action: 'note', what: 'outfit' }));
        await client.adjustOutfit('nova:150', -10);
        expect(entity.components.get(OutfitsStateComponent)!.has('nova:150')).toBeFalse();
    });

    it('toggles the Planet Buster launcher', async () => {
        expect(await client.givePlanetBuster()).toBe(1);
        expect(entity.components.get(OutfitsStateComponent)!.get(PLANET_BUSTER_OUTFIT_ID)?.count).toBe(1);
        expect(await client.givePlanetBuster()).toBe(0);
        expect(entity.components.get(OutfitsStateComponent)!.has(PLANET_BUSTER_OUTFIT_ID)).toBeFalse();
    });

    it('sets credits on both the owner state and the ledger', async () => {
        reply = body => ({ ok: true, credits: body.amount,
            balance: { shipId: 'nova:128', fuel: 300, ammo: {}, revision: 4 } });
        expect(await client.credits('add', 250)).toBe(750);
        expect(requests[0]).toEqual(jasmine.objectContaining({ action: 'credits', mode: 'set', amount: 750 }));
        expect(state().credits).toBe(750);
    });

    it('sets bits and runs NCB expressions, starting queued missions', async () => {
        const mission: MissionData = { ...getDefaultMissionData(), id: 'nova:250', name: 'Follow-up',
            travelStel: -1, returnStel: -1, availStel: -1, onAccept: 'b77' };
        gameData.data.Mission!.map.set(mission.id, mission);
        client.setBit(42, true);
        expect(client.getBit(42)).toBeTrue();
        await client.runNcb('b100 !b42 S250');
        expect(state().missionBits[100]).toBeTrue();
        expect(state().missionBits[42]).toBeFalse();
        expect(state().activeMissions.map(entry => entry.missionId)).toEqual(['nova:250']);
        expect(state().missionBits[77]).toBeTrue();
    });

    it('force-accepts and completes a mission with its OnSuccess and pay', async () => {
        const mission: MissionData = { ...getDefaultMissionData(), id: 'nova:300', name: 'Story',
            travelStel: -1, returnStel: -1, availStel: -1, onSuccess: 'b300', payVal: 1000 };
        gameData.data.Mission!.map.set(mission.id, mission);
        await client.acceptMission('nova:300');
        const entry = state().activeMissions[0];
        expect(entry.missionId).toBe('nova:300');
        await client.completeMission(entryKey(entry));
        expect(state().activeMissions.length).toBe(0);
        expect(state().missionBits[300]).toBeTrue();
        expect(state().credits).toBe(1500);
    });

    it('aborts a mission even when retail forbids it', async () => {
        const mission: MissionData = { ...getDefaultMissionData(), id: 'nova:301', name: 'Locked',
            travelStel: -1, returnStel: -1, availStel: -1, canAbort: false };
        gameData.data.Mission!.map.set(mission.id, mission);
        await client.acceptMission('nova:301');
        await client.abortMission(entryKey(state().activeMissions[0]));
        expect(state().activeMissions.length).toBe(0);
    });

    it('queues an instant jump, advances the date and sets legal records', () => {
        client.jumpTo('nova:131');
        expect(entity.components.get(PendingMissionJumpComponent)).toEqual({ systemId: 'nova:131', relative: false });
        expect(() => client.jumpTo('nova:130')).toThrowError(/Already/);
        const date = state().gameDate;
        expect(client.advanceDays(3)).toBe(date + 3);
        client.setLegalRecord('nova:128', -500);
        expect(state().legalRecords?.['nova:128']).toBe(-500);
    });

    it('refuses to act without a ship in flight', async () => {
        const grounded = new DebugClient('dbg', 'pilot', { gameData, player: () => undefined },
            async () => { throw new Error('should not fetch'); });
        await expectAsync(grounded.switchShip('nova:381')).toBeRejectedWithError(/Not in flight/);
        expect(() => grounded.setBit(1, true)).toThrowError(/Not in flight/);
    });
});
