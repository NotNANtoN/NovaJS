import * as express from 'express';
import { Express } from 'express';

export const HTTP_LIMIT_HEALTH_PATH = '/__novajs_health';
const REJECTION_BODY = 'Too many requests\n';

// A measured cold launch and 40 seconds of play used 215 requests and 12 MiB.
// A 1,200-request bucket refilling at 20/s leaves ample burst headroom. The
// one-hour 200 MiB budget permits about 16 such cold sessions per IP, while
// avoiding the roughly 1.2 GiB/hour that a 10-minute window would permit.
export const DEFAULT_HTTP_LIMIT_OPTIONS: HttpLimitOptions = {
    requestLimit: 1_200,
    requestWindowMs: 60_000,
    byteLimit: 200 * 1024 * 1024,
    byteWindowMs: 60 * 60_000,
    clientTtlMs: 65 * 60_000,
    maxClients: 4_096,
    cleanupIntervalMs: 60_000,
};

export interface HttpLimitOptions {
    requestLimit: number;
    requestWindowMs: number;
    byteLimit: number;
    byteWindowMs: number;
    clientTtlMs: number;
    maxClients: number;
    cleanupIntervalMs: number;
}

interface ClientState {
    requestTokens: number;
    byteBuckets: ByteBucket[];
    updatedAt: number;
    lastSeenAt: number;
}

interface ByteBucket {
    startedAt: number;
    bytes: number;
}

export interface HttpLimitDecision {
    allowed: boolean;
    retryAfterSeconds: number;
}

export class HttpLimiter {
    private readonly clients = new Map<string, ClientState>();
    private readonly byteBucketMs: number;
    private nextCleanupAt = 0;

    constructor(private readonly options: HttpLimitOptions) {
        // Sixty conservative time buckets bound per-client rolling-window
        // memory without letting boundary traffic escape the byte budget.
        this.byteBucketMs = Math.max(1,
            Math.ceil(options.byteWindowMs / 60));
    }

    get trackedClients(): number {
        return this.clients.size;
    }

    check(client: string, now: number): HttpLimitDecision {
        this.evictStale(now);
        let state = this.clients.get(client);
        if (!state) {
            if (this.clients.size >= this.options.maxClients) {
                return {
                    allowed: false,
                    retryAfterSeconds: Math.max(1,
                        Math.ceil(this.options.cleanupIntervalMs / 1000)),
                };
            }
            state = {
                requestTokens: this.options.requestLimit,
                byteBuckets: [],
                updatedAt: now,
                lastSeenAt: now,
            };
            this.clients.set(client, state);
        }

        this.refill(state, now);
        this.pruneBytes(state, now);
        state.lastSeenAt = now;

        if (this.usedBytes(state) >= this.options.byteLimit) {
            return {
                allowed: false,
                retryAfterSeconds: this.byteRetryAfter(state, 1, now),
            };
        }
        if (state.requestTokens < 1) {
            return {
                allowed: false,
                retryAfterSeconds: this.retryAfter(
                    state.requestTokens, this.options.requestLimit,
                    this.options.requestWindowMs),
            };
        }

        state.requestTokens--;
        return { allowed: true, retryAfterSeconds: 0 };
    }

    recordBytes(client: string, bytes: number, now: number): void {
        const state = this.clients.get(client);
        if (!state) {
            return;
        }
        this.refill(state, now);
        this.pruneBytes(state, now);
        this.addBytes(state, Math.max(0, bytes), now);
        state.lastSeenAt = now;
    }

    consumeBytes(
        client: string,
        bytes: number,
        now: number,
    ): HttpLimitDecision {
        const state = this.clients.get(client);
        if (!state) {
            return { allowed: true, retryAfterSeconds: 0 };
        }
        this.refill(state, now);
        this.pruneBytes(state, now);
        state.lastSeenAt = now;
        const needed = Math.max(0, bytes);
        if (this.usedBytes(state) + needed > this.options.byteLimit) {
            return {
                allowed: false,
                retryAfterSeconds: this.byteRetryAfter(
                    state, needed, now),
            };
        }
        this.addBytes(state, needed, now);
        return { allowed: true, retryAfterSeconds: 0 };
    }

    private refill(state: ClientState, now: number): void {
        const elapsed = Math.max(0, now - state.updatedAt);
        state.requestTokens = Math.min(
            this.options.requestLimit,
            state.requestTokens + elapsed * this.options.requestLimit
                / this.options.requestWindowMs);
        state.updatedAt = now;
    }

    private pruneBytes(state: ClientState, now: number): void {
        const staleBefore = now - this.options.byteWindowMs;
        while (state.byteBuckets.length > 0
            && state.byteBuckets[0].startedAt + this.byteBucketMs
                <= staleBefore) {
            state.byteBuckets.shift();
        }
    }

    private usedBytes(state: ClientState): number {
        return state.byteBuckets.reduce(
            (total, bucket) => total + bucket.bytes, 0);
    }

    private addBytes(state: ClientState, bytes: number, now: number): void {
        if (bytes === 0) {
            return;
        }
        const last = state.byteBuckets[state.byteBuckets.length - 1];
        const startedAt = Math.max(
            Math.floor(now / this.byteBucketMs) * this.byteBucketMs,
            last?.startedAt ?? 0);
        if (last?.startedAt === startedAt) {
            last.bytes += bytes;
            return;
        }
        state.byteBuckets.push({ startedAt, bytes });
    }

    private byteRetryAfter(
        state: ClientState,
        bytes: number,
        now: number,
    ): number {
        let deficit = this.usedBytes(state) + bytes
            - this.options.byteLimit;
        for (const bucket of state.byteBuckets) {
            deficit -= bucket.bytes;
            if (deficit <= 0) {
                const expiresAt = bucket.startedAt + this.byteBucketMs
                    + this.options.byteWindowMs;
                return Math.max(1, Math.ceil((expiresAt - now) / 1000));
            }
        }
        return Math.max(1,
            Math.ceil(this.options.byteWindowMs / 1000));
    }

    private retryAfter(
        tokens: number,
        capacity: number,
        windowMs: number,
    ): number {
        return Math.max(1, Math.ceil((1 - tokens) * windowMs
            / capacity / 1000));
    }

    private evictStale(now: number): void {
        if (now < this.nextCleanupAt) {
            return;
        }
        const staleBefore = now - this.options.clientTtlMs;
        for (const [client, state] of this.clients) {
            if (state.lastSeenAt <= staleBefore) {
                this.clients.delete(client);
            }
        }
        this.nextCleanupAt = now + this.options.cleanupIntervalMs;
    }
}

function positiveInteger(
    environment: NodeJS.ProcessEnv,
    name: string,
    fallback: number,
): number {
    const raw = environment[name];
    if (raw === undefined) {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}

export function httpLimitOptions(
    environment: NodeJS.ProcessEnv,
): HttpLimitOptions {
    return {
        requestLimit: positiveInteger(environment,
            'NOVA_HTTP_RATE_LIMIT_REQUESTS',
            DEFAULT_HTTP_LIMIT_OPTIONS.requestLimit),
        requestWindowMs: positiveInteger(environment,
            'NOVA_HTTP_RATE_LIMIT_WINDOW_MS',
            DEFAULT_HTTP_LIMIT_OPTIONS.requestWindowMs),
        byteLimit: positiveInteger(environment,
            'NOVA_HTTP_BYTE_LIMIT_BYTES',
            DEFAULT_HTTP_LIMIT_OPTIONS.byteLimit),
        byteWindowMs: positiveInteger(environment,
            'NOVA_HTTP_BYTE_LIMIT_WINDOW_MS',
            DEFAULT_HTTP_LIMIT_OPTIONS.byteWindowMs),
        clientTtlMs: positiveInteger(environment,
            'NOVA_HTTP_LIMIT_CLIENT_TTL_MS',
            DEFAULT_HTTP_LIMIT_OPTIONS.clientTtlMs),
        maxClients: positiveInteger(environment,
            'NOVA_HTTP_LIMIT_MAX_CLIENTS',
            DEFAULT_HTTP_LIMIT_OPTIONS.maxClients),
        cleanupIntervalMs: DEFAULT_HTTP_LIMIT_OPTIONS.cleanupIntervalMs,
    };
}

export function httpLimitEnabled(environment: NodeJS.ProcessEnv): boolean {
    const raw = environment.NOVA_HTTP_LIMIT_ENABLED;
    if (raw === undefined) {
        return true;
    }
    if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) {
        return false;
    }
    throw new Error('NOVA_HTTP_LIMIT_ENABLED must be true or false');
}

export function isHttpLimitExempt(requestPath: string): boolean {
    return requestPath === HTTP_LIMIT_HEALTH_PATH;
}

function chunkBytes(chunk: any, encoding?: BufferEncoding): number {
    if (chunk === undefined || chunk === null) {
        return 0;
    }
    return Buffer.isBuffer(chunk)
        ? chunk.length
        : Buffer.byteLength(chunk, encoding);
}

export function setupHttpLimiter(
    app: Express,
    environment: NodeJS.ProcessEnv = process.env,
    now: () => number = Date.now,
): HttpLimiter | undefined {
    // Only Caddy publishes public ports. The app is exposed on Docker's
    // internal network, so public requests have exactly one trusted proxy hop.
    app.set('trust proxy', 1);

    if (!httpLimitEnabled(environment)) {
        return undefined;
    }

    const limiter = new HttpLimiter(httpLimitOptions(environment));
    app.use((req: express.Request, res: express.Response,
        next: express.NextFunction) => {
        if (isHttpLimitExempt(req.path)) {
            next();
            return;
        }

        const client = req.ip || req.socket.remoteAddress || 'unknown';
        const decision = limiter.check(client, now());
        if (!decision.allowed) {
            res.setHeader('Retry-After', String(decision.retryAfterSeconds));
            res.status(429).type('text/plain').send(REJECTION_BODY);
            return;
        }

        let responseBytes = 0;
        let byteCharged = false;
        let byteRejected = false;
        const originalWrite = res.write.bind(res);
        const originalEnd = res.end.bind(res);
        const rejectResponse = (
            byteDecision: HttpLimitDecision,
        ): express.Response => {
            byteRejected = true;
            res.statusCode = 429;
            res.setHeader('Retry-After',
                String(byteDecision.retryAfterSeconds));
            res.setHeader('Content-Type',
                'text/plain; charset=utf-8');
            res.setHeader('Content-Length',
                String(Buffer.byteLength(REJECTION_BODY)));
            for (const header of [
                'Accept-Ranges',
                'Cache-Control',
                'Content-Encoding',
                'Content-Range',
                'ETag',
                'Last-Modified',
            ]) {
                res.removeHeader(header);
            }
            return originalEnd(REJECTION_BODY) as express.Response;
        };
        res.write = ((chunk: any, encoding?: any, callback?: any) => {
            if (byteRejected) {
                const writeCallback = typeof encoding === 'function'
                    ? encoding : callback;
                writeCallback?.();
                return true;
            }
            responseBytes += chunkBytes(chunk,
                typeof encoding === 'string'
                    ? encoding as BufferEncoding : undefined);
            return originalWrite(chunk, encoding, callback);
        }) as typeof res.write;
        res.end = ((chunk?: any, encoding?: any, callback?: any) => {
            if (byteRejected) {
                const endCallback = typeof chunk === 'function'
                    ? chunk
                    : typeof encoding === 'function' ? encoding : callback;
                endCallback?.();
                return res;
            }
            responseBytes += chunkBytes(chunk,
                typeof encoding === 'string'
                    ? encoding as BufferEncoding : undefined);
            if (byteCharged) {
                return originalEnd(chunk, encoding, callback);
            }
            const byteDecision = limiter.consumeBytes(
                client, responseBytes, now());
            if (!byteDecision.allowed && !res.headersSent) {
                return rejectResponse(byteDecision);
            }
            if (!byteDecision.allowed) {
                limiter.recordBytes(client, responseBytes, now());
            }
            return originalEnd(chunk, encoding, callback);
        }) as typeof res.end;
        res.once('pipe', (source: NodeJS.ReadableStream) => {
            const gzipWillBuffer = /\bgzip\b/i.test(
                String(req.headers['accept-encoding'] ?? ''))
                && !/\.(?:png|mp3)(?:$|\?)/i.test(req.path);
            const contentLength = Number(res.getHeader('Content-Length'));
            if (gzipWillBuffer || !Number.isSafeInteger(contentLength)
                || contentLength < 0) {
                return;
            }
            const byteDecision = limiter.consumeBytes(
                client, contentLength, now());
            if (byteDecision.allowed) {
                byteCharged = true;
                return;
            }
            source.unpipe(res);
            source.resume();
            rejectResponse(byteDecision);
        });
        next();
    });
    return limiter;
}
