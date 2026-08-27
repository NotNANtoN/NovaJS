import 'jasmine';
import express from 'express';
import { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockGameData } from 'novadatainterface/MockGameData';
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

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'novajs-routes-'));
        playerStore = new PlayerStore(join(directory, 'players.json'));
        await playerStore.ready;
        const app = express();
        setupRoutes(
            new MockGameData(),
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
