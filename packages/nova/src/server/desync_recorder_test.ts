import 'jasmine';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DesyncDump } from '../communication/rollback_protocol.js';
import { DesyncRecorder, fingerprintGameData } from './desync_recorder.js';

describe('DesyncRecorder', () => {
    let root: string;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'desync-recorder-'));
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    const info = {
        tick: 180,
        hashes: [['a', 'h1'], ['b', 'h2']] as [string, string][],
        canonical: 'h1',
        convicted: ['b'],
        archiveOutvoted: false,
    };
    const dump: DesyncDump = {
        tick: 210,
        desyncTick: 180,
        engine: 'test',
        checkpoints: [],
        rollbackLog: [],
    };

    it('writes an incident directory and files the client dump into it',
        async () => {
            const recorder = new DesyncRecorder(root);
            recorder.recordDesync('nova:130', info, {
                baselines: [{
                    tick: 60,
                    snapshot: { entities: [], singleton: [], resources: [] },
                }],
                log: [{ tick: 5, inputs: [] }],
            });
            recorder.recordClientDump('nova:130', 'peer-b', dump);
            await recorder.flush();

            const [incident] = await fs.readdir(root);
            expect(incident).toContain('nova_130_tick180');
            const files = (await fs.readdir(path.join(root, incident!))).sort();
            expect(files).toEqual(['baselines.json', 'client_peer-b.json',
                'desync.json', 'log.json']);

            const desync = JSON.parse(await fs.readFile(
                path.join(root, incident!, 'desync.json'), 'utf8'));
            expect(desync.roomId).toBe('nova:130');
            expect(desync.tick).toBe(180);
            expect(desync.convicted).toEqual(['b']);
            const written = JSON.parse(await fs.readFile(
                path.join(root, incident!, 'client_peer-b.json'), 'utf8'));
            expect(written).toEqual(dump);
        });

    it('records an unsolicited dump in its own directory', async () => {
        const recorder = new DesyncRecorder(root);
        recorder.recordClientDump('nova:130', 'peer-a', dump);
        await recorder.flush();
        const [dir] = await fs.readdir(root);
        expect(dir).toContain('nova_130_dump');
        expect(await fs.readdir(path.join(root, dir!)))
            .toEqual(['client_peer-a.json']);
    });

    it('records the game data fingerprint with the verdict', async () => {
        const recorder = new DesyncRecorder(root);
        recorder.gameDataFingerprint =
            fingerprintGameData({ Ship: ['nova:128'] });
        recorder.recordDesync('nova:130', info, { baselines: [], log: [] });
        await recorder.flush();
        const [incident] = await fs.readdir(root);
        const desync = JSON.parse(await fs.readFile(
            path.join(root, incident!, 'desync.json'), 'utf8'));
        expect(desync.gameDataFingerprint)
            .toBe(fingerprintGameData({ Ship: ['nova:128'] }));
        // Stable across processes: a fixed input hashes identically.
        expect(desync.gameDataFingerprint).toMatch(/^[0-9a-f]{16}$/);
    });

    it('suppresses repeat incidents for a room within the cooldown', async () => {
        const recorder = new DesyncRecorder(root, 50, 60_000);
        recorder.recordDesync('nova:130', info, { baselines: [], log: [] });
        recorder.recordDesync('nova:130', { ...info, tick: 360 },
            { baselines: [], log: [] });
        await recorder.flush();
        expect((await fs.readdir(root)).length).toBe(1);
    });

    it('prunes the oldest incidents beyond the cap', async () => {
        const recorder = new DesyncRecorder(root, 2);
        for (let i = 0; i < 4; i++) {
            recorder.recordDesync(`room${i}`, { ...info, tick: i },
                { baselines: [], log: [] });
            // Distinct timestamps keep directory names unique and
            // lexicographic order meaningful.
            await recorder.flush();
            await new Promise(resolve => setTimeout(resolve, 2));
        }
        const dirs = (await fs.readdir(root)).sort();
        expect(dirs.length).toBe(2);
        expect(dirs[0]).toContain('room2');
        expect(dirs[1]).toContain('room3');
    });
});
