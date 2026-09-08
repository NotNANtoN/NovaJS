import 'jasmine';
import express from 'express';
import { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockGameData } from 'novadatainterface/MockGameData';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { getDefaultPlanetData } from 'novadatainterface/PlanetData';
import { getDefaultSystemData } from 'novadatainterface/SystemData';
import { combatLedger } from '../nova_plugin/combat_resources';
import { EncodedEntity } from 'nova_ecs/plugins/serializer_plugin';
import { createInitialPlayerState } from '../nova_plugin/player_state';
import { PlayerStore } from './player_store';
import {
    gameDataCacheControl,
    IMMUTABLE_ASSET_CACHE,
    REVALIDATE_METADATA_CACHE,
    setupRoutes,
} from './setupRoutes';

describe('game-data cache policy', () => {
    it('revalidates stable JSON metadata URLs', () => {
        expect(gameDataCacheControl('/Planet/nova%3A128.json'))
            .toBe(REVALIDATE_METADATA_CACHE);
        expect(gameDataCacheControl('/System/nova%3A130.json'))
            .toBe(REVALIDATE_METADATA_CACHE);
        expect(gameDataCacheControl('/Planet/nova%3A128'))
            .toBe(REVALIDATE_METADATA_CACHE);
    });

    it('keeps large version-stable binary assets immutable', () => {
        expect(gameDataCacheControl('/PictImage/nova%3A128.png'))
            .toBe(IMMUTABLE_ASSET_CACHE);
        expect(gameDataCacheControl('/PictImage/nova%3A128.webp'))
            .toBe(IMMUTABLE_ASSET_CACHE);
        expect(gameDataCacheControl('/SoundFile/nova%3A128.mp3'))
            .toBe(IMMUTABLE_ASSET_CACHE);
    });
});

describe('/player/state', () => {
    let directory: string;
    let playerStore: PlayerStore;
    let server: Server;
    let baseUrl: string;
    let gameData: MockGameData;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'novajs-routes-'));
        playerStore = new PlayerStore(join(directory, 'players.json'));
        await playerStore.ready;
        const app = express();
        gameData = new MockGameData();
        setupRoutes(
            gameData,
            app,
            '/dev/null',
            '/dev/null',
            '/dev/null',
            '/dev/null',
            undefined,
            playerStore,
        );
        await new Promise<void>(resolve => {
            server = app.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Test server did not bind a TCP port');
        }
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
        await new Promise<void>((resolve, reject) =>
            server.close(error => error ? reject(error) : resolve()));
        await playerStore.flush();
        await rm(directory, { recursive: true, force: true });
    });

    it('fences a delayed HTTP open before acknowledging recovery', async () => {
        gameData.data.Ship.map.set('nova:128', { ...getDefaultShipData(), id: 'nova:128', fuelCapacity: 300 });
        gameData.data.Planet.map.set('port', { ...getDefaultPlanetData(), id: 'port', canLand: true, position: [0, 0] });
        const system = { ...getDefaultSystemData(), id: 'nova:130', planets: ['port'] };
        gameData.data.System.map.set('nova:130', system);
        const authority = await combatLedger(playerStore, gameData).get('pilot');
        authority.position = [0, 0];
        authority.system = 'nova:130';
        let entered!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        spyOn(gameData.data.System, 'get').and.callFake(async () => {
            entered(); await gate; return system;
        });
        const request = { token: 'pilot', action: 'open', planet: 'port',
            revision: authority.balance.revision, state: createInitialPlayerState() };
        const post = (body: unknown) => fetch(`${baseUrl}/player/combat/shop`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const delayed = post(request);
        await waiting;
        try {
            const recovery = await post({ ...request, action: 'recover' });
            expect(recovery.status).toBe(200);
            expect((await recovery.json() as { landed: unknown }).landed).toBeNull();
        } finally { release(); }
        expect((await delayed).status).toBe(409);
        expect(authority.landed).toBeUndefined();
    });

    it('rejects combat transactions before server flight initialization', async () => {
        const response = await fetch(`${baseUrl}/player/combat/shop`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: 'pilot', action: 'refuel', planet: 'port', revision: 0,
                state: createInitialPlayerState() }),
        });
        expect(response.status).toBe(409);
        expect(await playerStore.get('pilot')).toBeUndefined();
    });

    it('does not let HTTP snapshots seed or refill combat balances', async () => {
        const state = createInitialPlayerState();
        await playerStore.save('pilot', state);
        playerStore.saveCombatResources('pilot', { shipId: state.shipId, fuel: 10,
            ammo: { ammo: 1 }, revision: 5 });
        const forged = { ...state, fuel: 10000, combatResources: {
            shipId: 'forged', fuel: 10000, ammo: { ammo: 999 }, revision: 100,
        } };
        const response = await fetch(`${baseUrl}/player/snapshots`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: 'pilot', state: forged, replaceCurrent: forged }),
        });
        expect(response.status).toBe(200);
        const saved = await playerStore.get('pilot');
        expect(saved?.fuel).toBe(10);
        expect(saved?.combatResources?.ammo.ammo).toBe(1);
        expect(saved?.snapshots[0].state.combatResources?.ammo.ammo).toBe(1);
    });

    it('returns only PlayerData fields and includes the stored ship',
        async () => {
        const state = createInitialPlayerState();
        state.pilotName = 'Payload Captain';
        const ship: EncodedEntity = {
            name: 'Shuttle',
            components: [['Ship', { id: state.shipId }]],
        };
        await playerStore.snapshot('pilot', state, ship, 'manual');

        const response = await fetch(
            `${baseUrl}/player/state?token=pilot`);
        const body = await response.json() as Record<string, any>;

        expect(response.status).toBe(200);
        expect(Object.keys(body).sort()).toEqual([
            'playerState',
            'savedAt',
            'ship',
            'snapshots',
            'system',
            'uuid',
        ]);
        expect(body.revision).toBeUndefined();
        expect(body.playerState.ship).toBeUndefined();
        expect(body.playerState.snapshots).toBeUndefined();
        expect(body.playerState.savedAt).toBeUndefined();
        expect(body.playerState.revision).toBeUndefined();
        expect(Object.keys(body.playerState).sort()).toEqual(
            Object.keys(createInitialPlayerState()).sort());
        expect(body.ship.components).toEqual([
            ['Ship', { id: state.shipId }],
        ]);
        expect(body.snapshots).toEqual([
            jasmine.objectContaining({
                reason: 'manual',
                pilotName: 'Payload Captain',
                currentSystem: state.currentSystem,
            }),
        ]);
        expect(body.snapshots[0].state).toBeUndefined();
        expect(body.snapshots[0].ship).toBeUndefined();
    });

    it('archives a pilot without replacing the active save unless asked',
        async () => {
        const active = createInitialPlayerState();
        active.pilotName = 'Active Captain';
        active.gameDate = 5;
        await playerStore.save('pilot', active);

        const archived = createInitialPlayerState();
        archived.pilotName = 'Archived Captain';
        archived.gameDate = 9;
        const response = await fetch(`${baseUrl}/player/snapshots`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: 'pilot',
                state: archived,
                reason: 'manual',
            }),
        });
        const summaries = await response.json() as Array<Record<string, unknown>>;

        expect(response.status).toBe(200);
        expect(summaries).toEqual([
            jasmine.objectContaining({
                pilotName: 'Archived Captain',
                reason: 'manual',
            }),
        ]);

        const current = await fetch(`${baseUrl}/player/state?token=pilot`);
        const body = await current.json() as Record<string, any>;
        expect(body.playerState.pilotName).toBe('Active Captain');
        expect(body.playerState.gameDate).toBe(5);
    });

    it('can archive one pilot and replace the active save in one request',
        async () => {
        const previous = createInitialPlayerState();
        previous.pilotName = 'Previous Captain';
        await playerStore.save('pilot', previous);
        const replacement = createInitialPlayerState();
        replacement.pilotName = 'Replacement Captain';

        const response = await fetch(`${baseUrl}/player/snapshots`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: 'pilot',
                state: previous,
                replaceCurrent: replacement,
                reason: 'manual',
            }),
        });

        expect(response.status).toBe(200);
        const current = await fetch(`${baseUrl}/player/state?token=pilot`);
        const body = await current.json() as Record<string, any>;
        expect(body.playerState.pilotName).toBe('Replacement Captain');
        expect(body.playerState.credits).toBe(createInitialPlayerState().credits);
        expect(body.playerState.combatResources).toBeDefined();
        expect(body.snapshots).toEqual([
            jasmine.objectContaining({ pilotName: 'Previous Captain' }),
        ]);
    });

    it('returns the snapshot ship in the restore response', async () => {
        const state = createInitialPlayerState();
        state.gameDate = 22;
        const ship: EncodedEntity = {
            components: [['Ship', { id: state.shipId }]],
        };
        const snapshot = await playerStore.snapshot(
            'pilot', state, ship, 'landing');
        state.gameDate = 99;
        await playerStore.save('pilot', state);

        const response = await fetch(
            `${baseUrl}/player/snapshots/${
                encodeURIComponent(snapshot.id)}/restore`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: 'pilot' }),
            },
        );
        const body = await response.json() as Record<string, any>;

        expect(response.status).toBe(200);
        expect(body.playerState.gameDate).toBe(22);
        expect(body.ship.components).toEqual([
            ['Ship', { id: state.shipId }],
        ]);
    });

    it('returns quarantine instead of 404 for an unreadable pilot',
        async () => {
        spyOn(playerStore, 'get').and.resolveTo(undefined);
        spyOn(playerStore, 'quarantine').and.resolveTo('record');

        const response = await fetch(
            `${baseUrl}/player/state?token=quarantined`);
        const body = await response.json() as Record<string, unknown>;

        expect(response.status).toBe(200);
        expect(body).toEqual({
            uuid: 'persisted',
            quarantine: 'record',
        });
    });

    it('keeps returning 404 for an unknown pilot', async () => {
        const response = await fetch(
            `${baseUrl}/player/state?token=unknown`);

        expect(response.status).toBe(404);
        expect(await response.text()).toBe('Player not found');
    });
});
