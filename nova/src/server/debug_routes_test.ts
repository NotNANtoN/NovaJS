import 'jasmine';
import express from 'express';
import { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Entity } from 'nova_ecs/entity';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { MockGameData } from 'novadatainterface/MockGameData';
import { getDefaultOutfitData } from 'novadatainterface/OutfitData';
import { getDefaultPlanetData } from 'novadatainterface/PlanetData';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { getDefaultProjectileWeaponData } from 'novadatainterface/WeaponData';
import { combatLedger } from '../nova_plugin/combat_resources';
import { makeShip } from '../nova_plugin/make_ship';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin';
import { createInitialPlayerState, isStellarDestroyed, PlayerStateComponent } from '../nova_plugin/player_state';
import { ShipComponent } from '../nova_plugin/ship_plugin';
import {
    debugTokenMatches,
    parseDebugAction,
    PilotLocator,
    resolveDebugToken,
} from './debug_routes';
import { PlayerStore } from './player_store';
import { setupRoutes } from './setupRoutes';

describe('debug token helpers', () => {
    it('is disabled unless a non-blank token is configured', () => {
        expect(resolveDebugToken({})).toBeUndefined();
        expect(resolveDebugToken({ NOVA_DEBUG_TOKEN: '   ' })).toBeUndefined();
        expect(resolveDebugToken({}, '')).toBeUndefined();
        expect(resolveDebugToken({}, 'from-settings')).toBe('from-settings');
        expect(resolveDebugToken({ NOVA_DEBUG_TOKEN: ' env ' }, 'from-settings')).toBe('env');
    });

    it('compares tokens exactly', () => {
        expect(debugTokenMatches('secret-token', 'secret-token')).toBeTrue();
        expect(debugTokenMatches('secret-token', 'secret-tokeN')).toBeFalse();
        expect(debugTokenMatches('secret-token', 'secret')).toBeFalse();
        expect(debugTokenMatches('secret-token', '')).toBeFalse();
        expect(debugTokenMatches('secret-token', undefined)).toBeFalse();
        expect(debugTokenMatches('secret-token', ['secret-token'])).toBeFalse();
    });

    it('validates action bodies', () => {
        expect(parseDebugAction({ action: 'ship', shipId: 'nova:128' }))
            .toEqual({ action: 'ship', shipId: 'nova:128' });
        expect(parseDebugAction({ action: 'ship', shipId: '../etc' })).toBeUndefined();
        expect(parseDebugAction({ action: 'credits', mode: 'set', amount: 1.5 })).toBeUndefined();
        expect(parseDebugAction({ action: 'credits', mode: 'mint', amount: 5 })).toBeUndefined();
        expect(parseDebugAction({ action: 'ammo', outfitId: 'nova:139', count: -1 })).toBeUndefined();
        expect(parseDebugAction({ action: 'stellar', planetId: 'nova:128', destroyed: 'yes' })).toBeUndefined();
        expect(parseDebugAction({ action: 'eval', code: 'x' })).toBeUndefined();
        expect(parseDebugAction(null)).toBeUndefined();
    });
});

describe('/debug routes', () => {
    const TOKEN = 'test-debug-token-123';
    let directory: string;
    let playerStore: PlayerStore;
    let server: Server | undefined;
    let baseUrl: string;
    let gameData: MockGameData;
    let logs: string[];
    let pilot: { entities: Map<string, Entity>; uuid: string; entity: Entity } | undefined;

    async function start(token: string | undefined) {
        const app = express();
        logs = [];
        const locatePilot: PilotLocator = playerToken =>
            playerToken === 'pilot' ? pilot : undefined;
        setupRoutes(gameData, app, '/dev/null', '/dev/null', '/dev/null', '/dev/null',
            undefined, playerStore, { token, locatePilot, log: message => logs.push(message) });
        await new Promise<void>(resolve => {
            server = app.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server!.address();
        if (!address || typeof address === 'string') throw new Error('No TCP port');
        baseUrl = `http://127.0.0.1:${address.port}`;
    }

    const action = (body: Record<string, unknown>) => fetch(`${baseUrl}/debug/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, playerToken: 'pilot', ...body }),
    });

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'novajs-debug-'));
        playerStore = new PlayerStore(join(directory, 'players.json'));
        await playerStore.ready;
        gameData = new MockGameData();
        gameData.data.Ship.map.set('nova:128', { ...getDefaultShipData(), id: 'nova:128',
            name: 'Shuttle', fuelCapacity: 300, cargoCapacity: 10, outfits: {} });
        gameData.data.Ship.map.set('nova:381', { ...getDefaultShipData(), id: 'nova:381',
            name: 'Kestrel', fuelCapacity: 200, cargoCapacity: 60, outfits: { 'nova:139': 4, 'nova:138': 1 } });
        gameData.data.Outfit.map.set('nova:138', { ...getDefaultOutfitData(), id: 'nova:138', weapons: { 'nova:136': 1 } });
        gameData.data.Outfit.map.set('nova:139', { ...getDefaultOutfitData(), id: 'nova:139' });
        gameData.data.Weapon.map.set('nova:136', { ...getDefaultProjectileWeaponData(), id: 'nova:136',
            ammoType: ['outfit', 'nova:139'] });
        gameData.data.Planet.map.set('nova:300', { ...getDefaultPlanetData(), id: 'nova:300',
            name: 'Target', strength: 100, deadTime: 4, onDestroy: 'b50', onRegen: 'b51' });
        pilot = undefined;
    });

    afterEach(async () => {
        if (server) {
            await new Promise<void>((resolve, reject) =>
                server!.close(error => error ? reject(error) : resolve()));
            server = undefined;
        }
        await playerStore.flush();
        await rm(directory, { recursive: true, force: true });
    });

    it('is 404 when NOVA_DEBUG_TOKEN is unset', async () => {
        await start(undefined);
        expect((await fetch(`${baseUrl}/debug/status?token=${TOKEN}`)).status).toBe(404);
        expect((await action({ action: 'refuel' })).status).toBe(404);
        // The index.html catch-all must not answer instead.
        expect((await fetch(`${baseUrl}/debug/anything`)).status).toBe(404);
    });

    it('requires the debug token', async () => {
        await start(TOKEN);
        expect((await fetch(`${baseUrl}/debug/status`)).status).toBe(403);
        expect((await fetch(`${baseUrl}/debug/status?token=wrong`)).status).toBe(403);
        const ok = await fetch(`${baseUrl}/debug/status?token=${TOKEN}`);
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual({ ok: true });
        expect((await action({ action: 'refuel', token: 'wrong' })).status).toBe(403);
        expect(logs.some(line => line.startsWith('[DEBUG] Rejected debug token'))).toBeTrue();
    });

    it('requires the pilot token and a valid action', async () => {
        await start(TOKEN);
        expect((await action({ action: 'refuel', playerToken: undefined })).status).toBe(400);
        expect((await action({ action: 'nope' })).status).toBe(400);
        // Never initializes a pilot from HTTP.
        expect((await action({ action: 'refuel' })).status).toBe(409);
        expect(await playerStore.get('pilot')).toBeUndefined();
    });

    it('throttles repeated bad tokens', async () => {
        const app = express();
        setupRoutes(gameData, app, '/dev/null', '/dev/null', '/dev/null', '/dev/null',
            undefined, playerStore, { token: TOKEN, maxFailures: 2, log: () => undefined });
        await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
        const address = server!.address();
        if (!address || typeof address === 'string') throw new Error('No TCP port');
        const url = `http://127.0.0.1:${address.port}/debug/status`;
        expect((await fetch(`${url}?token=a`)).status).toBe(403);
        expect((await fetch(`${url}?token=b`)).status).toBe(403);
        expect((await fetch(`${url}?token=${TOKEN}`)).status).toBe(429);
    });

    it('switches the combat authority hull with fuel clamp and hull ammo', async () => {
        await start(TOKEN);
        const authority = await combatLedger(playerStore, gameData).get('pilot');
        expect(authority.balance.shipId).toBe('nova:128');
        authority.balance.fuel = 300;
        authority.balance.ammo['nova:139'] = 50;
        const entity = makeShip(gameData.data.Ship.map.get('nova:128')!);
        entity.components.set(PlayerStateComponent, createInitialPlayerState());
        entity.components.set(MultiplayerData, { owner: 'peer' });
        pilot = { entities: new Map([['ship', entity]]), uuid: 'ship', entity };

        const response = await action({ action: 'ship', shipId: 'nova:381' });
        expect(response.status).toBe(200);
        const body = await response.json() as { balance: { shipId: string; fuel: number; ammo: Record<string, number> } };
        expect(body.balance.shipId).toBe('nova:381');
        expect(body.balance.fuel).toBe(200);
        expect(body.balance.ammo['nova:139']).toBe(4);
        expect(authority.balance.shipId).toBe('nova:381');
        expect(entity.components.get(ShipComponent)?.id).toBe('nova:381');
        expect(entity.components.get(PlayerStateComponent)?.shipId).toBe('nova:381');
        expect(entity.components.get(OutfitsStateComponent)?.get('nova:138')?.count).toBe(1);
        expect((await playerStore.get('pilot'))?.shipId).toBe('nova:381');
        expect(logs.some(line => line.includes('[DEBUG] [pilot:pilot] ship {"shipId":"nova:381"} ok'))).toBeTrue();

        expect((await action({ action: 'ship', shipId: 'nova:999' })).status).toBe(400);
        authority.landed = 'port';
        expect((await action({ action: 'ship', shipId: 'nova:128' })).status).toBe(409);
    });

    it('sets and adds credits in the ledger and the store', async () => {
        await start(TOKEN);
        const authority = await combatLedger(playerStore, gameData).get('pilot');
        let response = await action({ action: 'credits', mode: 'set', amount: 1_000_000 });
        expect(response.status).toBe(200);
        expect((await response.json() as { credits: number }).credits).toBe(1_000_000);
        response = await action({ action: 'credits', mode: 'add', amount: -2_000_000 });
        expect((await response.json() as { credits: number }).credits).toBe(0);
        response = await action({ action: 'credits', mode: 'add', amount: 250 });
        expect((await response.json() as { credits: number }).credits).toBe(250);
        expect(authority.state.credits).toBe(250);
        expect((await playerStore.get('pilot'))?.credits).toBe(250);
    });

    it('sets ledger ammo and refuels', async () => {
        await start(TOKEN);
        const authority = await combatLedger(playerStore, gameData).get('pilot');
        authority.balance.fuel = 10;
        let response = await action({ action: 'ammo', outfitId: 'nova:139', count: 25 });
        expect(response.status).toBe(200);
        expect(authority.balance.ammo['nova:139']).toBe(25);
        expect((await action({ action: 'ammo', outfitId: 'nova:138', count: 1 })).status).toBe(400);
        response = await action({ action: 'refuel' });
        expect((await response.json() as { balance: { fuel: number } }).balance.fuel).toBe(300);
    });

    it('records stellar destruction and regeneration on the server copy of the pilot', async () => {
        await start(TOKEN);
        await combatLedger(playerStore, gameData).get('pilot');
        const entity = makeShip(gameData.data.Ship.map.get('nova:128')!);
        const state = createInitialPlayerState();
        state.gameDate = 7;
        entity.components.set(PlayerStateComponent, state);
        entity.components.set(MultiplayerData, { owner: 'peer' });
        const entities = new Map([['ship', entity]]);
        pilot = { entities, uuid: 'ship', entity };

        let response = await action({ action: 'stellar', planetId: 'nova:300', destroyed: true });
        expect(response.status).toBe(200);
        expect((await response.json() as { destroyed: boolean }).destroyed).toBeTrue();
        let live = entities.get('ship')!.components.get(PlayerStateComponent)!;
        expect(isStellarDestroyed(live, 'nova:300')).toBeTrue();
        expect(live.stellarRegen).toEqual({ 'nova:300': 11 });
        expect(live.missionBits[50]).toBeTrue();

        response = await action({ action: 'stellar', planetId: 'nova:300', destroyed: true });
        expect((await response.json() as { message?: string }).message).toContain('Already');

        response = await action({ action: 'stellar', planetId: 'nova:300', destroyed: false });
        expect((await response.json() as { destroyed: boolean }).destroyed).toBeFalse();
        live = entities.get('ship')!.components.get(PlayerStateComponent)!;
        expect(isStellarDestroyed(live, 'nova:300')).toBeFalse();
        expect(live.missionBits[51]).toBeTrue();

        expect((await action({ action: 'stellar', planetId: 'nova:9999', destroyed: true })).status).toBe(400);
    });

    it('logs client-applied notes', async () => {
        await start(TOKEN);
        const response = await action({ action: 'note', what: 'bit', detail: 'b100=1' });
        expect(response.status).toBe(200);
        expect(logs).toContain(jasmine.stringMatching(/^\[DEBUG\] \[pilot:pilot\] note .*b100=1.* ok/));
    });
});
