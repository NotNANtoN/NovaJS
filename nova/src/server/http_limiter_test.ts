import express from 'express';
import { promises as fs } from 'node:fs';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
    DEFAULT_HTTP_LIMIT_OPTIONS,
    HTTP_LIMIT_HEALTH_PATH,
    HttpLimiter,
    HttpLimitOptions,
    setupHttpLimiter,
} from './http_limiter';

function options(overrides: Partial<HttpLimitOptions> = {}): HttpLimitOptions {
    return {
        ...DEFAULT_HTTP_LIMIT_OPTIONS,
        ...overrides,
    };
}

async function withServer(
    app: express.Express,
    test: (baseUrl: string) => Promise<void>,
): Promise<void> {
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    try {
        await test(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
}

describe('HTTP limiter', () => {
    it('allows the measured 215-request cold session burst', () => {
        const limiter = new HttpLimiter(DEFAULT_HTTP_LIMIT_OPTIONS);

        for (let request = 0; request < 215; request++) {
            expect(limiter.check('player', 0).allowed).toBeTrue();
        }
    });

    it('rejects a sustained request flood', () => {
        const limiter = new HttpLimiter(options({
            requestLimit: 3,
            requestWindowMs: 1_000,
        }));

        expect(limiter.check('bot', 0).allowed).toBeTrue();
        expect(limiter.check('bot', 0).allowed).toBeTrue();
        expect(limiter.check('bot', 0).allowed).toBeTrue();
        const rejected = limiter.check('bot', 0);

        expect(rejected.allowed).toBeFalse();
        expect(rejected.retryAfterSeconds).toBe(1);
    });

    it('rejects after the byte budget is exhausted', () => {
        const limiter = new HttpLimiter(options({
            byteLimit: 10,
            byteWindowMs: 1_000,
        }));

        expect(limiter.check('bot', 0).allowed).toBeTrue();
        limiter.recordBytes('bot', 11, 0);

        expect(limiter.check('bot', 0).allowed).toBeFalse();
    });

    it('refills request and byte budgets as the window rolls', () => {
        const limiter = new HttpLimiter(options({
            requestLimit: 2,
            requestWindowMs: 100,
            byteLimit: 10,
            byteWindowMs: 100,
        }));

        expect(limiter.check('player', 0).allowed).toBeTrue();
        expect(limiter.check('player', 0).allowed).toBeTrue();
        limiter.recordBytes('player', 11, 0);
        expect(limiter.check('player', 0).allowed).toBeFalse();

        expect(limiter.check('player', 102).allowed).toBeTrue();
    });

    it('evicts stale client entries', () => {
        const limiter = new HttpLimiter(options({
            clientTtlMs: 100,
            cleanupIntervalMs: 10,
        }));

        limiter.check('old', 0);
        expect(limiter.trackedClients).toBe(1);
        limiter.check('new', 101);

        expect(limiter.trackedClients).toBe(1);
    });

    it('caps tracked clients and rejects an untracked client', () => {
        const limiter = new HttpLimiter(options({
            maxClients: 2,
        }));

        expect(limiter.check('one', 0).allowed).toBeTrue();
        expect(limiter.check('two', 0).allowed).toBeTrue();
        expect(limiter.check('three', 0).allowed).toBeFalse();
        expect(limiter.trackedClients).toBe(2);
    });

    it('never limits the deployment health path', async () => {
        const app = express();
        setupHttpLimiter(app, {
            NOVA_HTTP_RATE_LIMIT_REQUESTS: '1',
        }, () => 0);
        app.get(HTTP_LIMIT_HEALTH_PATH, (_req, res) => {
            res.sendStatus(204);
        });
        app.get('/limited', (_req, res) => {
            res.send('ok');
        });

        await withServer(app, async baseUrl => {
            expect((await fetch(baseUrl + HTTP_LIMIT_HEALTH_PATH)).status)
                .toBe(204);
            expect((await fetch(baseUrl + HTTP_LIMIT_HEALTH_PATH)).status)
                .toBe(204);
            expect((await fetch(baseUrl + '/limited')).status).toBe(200);
            const rejected = await fetch(baseUrl + '/limited');
            expect(rejected.status).toBe(429);
            expect(rejected.headers.get('retry-after')).toBe('60');
            expect(await rejected.text()).toBe('Too many requests\n');
        });
    });

    it('replaces an over-budget response with a small 429', async () => {
        const app = express();
        setupHttpLimiter(app, {
            NOVA_HTTP_BYTE_LIMIT_BYTES: '6',
        }, () => 0);
        app.get('/asset', (_req, res) => {
            res.send('data');
        });

        await withServer(app, async baseUrl => {
            expect(await (await fetch(baseUrl + '/asset')).text())
                .toBe('data');
            const rejected = await fetch(baseUrl + '/asset');

            expect(rejected.status).toBe(429);
            expect(await rejected.text()).toBe('Too many requests\n');
        });
    });

    it('rejects an over-budget streamed asset before sending it', async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), 'novajs-http-limiter-'));
        const assetPath = path.join(directory, 'asset.bin');
        await fs.writeFile(assetPath, 'large asset');
        const app = express();
        setupHttpLimiter(app, {
            NOVA_HTTP_BYTE_LIMIT_BYTES: '6',
        }, () => 0);
        app.get('/asset.bin', (_req, res) => {
            res.sendFile(assetPath);
        });

        try {
            await withServer(app, async baseUrl => {
                const response = await fetch(baseUrl + '/asset.bin', {
                    headers: { 'Accept-Encoding': 'identity' },
                });

                expect(response.status).toBe(429);
                expect(await response.text())
                    .toBe('Too many requests\n');
            });
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it('attributes clients to Caddy forwarded addresses', async () => {
        const app = express();
        setupHttpLimiter(app);
        app.get('/ip', (req, res) => {
            res.send(req.ip);
        });

        await withServer(app, async baseUrl => {
            const response = await fetch(baseUrl + '/ip', {
                headers: {
                    'X-Forwarded-For':
                        '198.51.100.8, 203.0.113.9',
                },
            });

            expect(await response.text()).toBe('203.0.113.9');
        });
    });
});
