/** Local-only test proxy: delay real WebSocket frames without delaying asset loads. */
import http from 'node:http';
import https from 'node:https';
import WebSocket, { WebSocketServer } from 'ws';

export async function startLagProxy({ target, latencyMs = 25, jitterMs = 0 }) {
    if (![latencyMs, jitterMs].every(value => Number.isFinite(value) && value >= 0 && value <= 1000)) {
        throw new Error('Test latency/jitter must be between 0 and 1000 milliseconds');
    }
    const origin = new URL(target);
    const transport = origin.protocol === 'https:' ? https : http;
    const timers = new Set();
    const sockets = new Set();
    const stats = { frames: 0, bytes: 0 };
    const server = http.createServer((req, res) => {
        const upstream = transport.request({
            hostname: origin.hostname, port: origin.port || (origin.protocol === 'https:' ? 443 : 80),
            method: req.method, path: req.url,
            headers: { ...req.headers, host: origin.host },
        }, response => {
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(res);
        });
        upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        req.on('aborted', () => upstream.destroy());
        req.pipe(upstream);
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, downstream => {
            const destination = new URL(req.url, origin);
            destination.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
            destination.host = origin.host;
            const upstream = new WebSocket(destination);
            sockets.add(downstream);
            sockets.add(upstream);
            let closed = false;
            const pairTimers = new Set();
            const close = () => {
                if (closed) return;
                closed = true;
                for (const timer of pairTimers) { clearTimeout(timer); timers.delete(timer); }
                sockets.delete(downstream);
                sockets.delete(upstream);
                downstream.terminate();
                upstream.terminate();
            };
            function forward(from, to) {
                let lastDue = 0;
                let index = 0;
                const waiting = [];
                const send = (data, binary) => {
                    if (closed) return;
                    if (to.readyState === WebSocket.OPEN) to.send(data, { binary });
                    else if (to.readyState === WebSocket.CONNECTING) waiting.push([data, binary]);
                };
                to.once('open', () => {
                    for (const [data, binary] of waiting) send(data, binary);
                    waiting.length = 0;
                });
                from.on('message', (data, binary) => {
                    const jitter = [0, -1, 1, -0.5, 0.5][index++ % 5] * jitterMs;
                    const now = performance.now();
                    // Preserve TCP/WebSocket ordering even when delays vary.
                    const due = Math.max(lastDue, now + Math.max(0, latencyMs + jitter));
                    lastDue = due;
                    stats.frames++;
                    stats.bytes += data.length;
                    const timer = setTimeout(() => {
                        timers.delete(timer);
                        pairTimers.delete(timer);
                        send(data, binary);
                    }, Math.max(0, due - now));
                    timers.add(timer);
                    pairTimers.add(timer);
                });
            }
            forward(downstream, upstream);
            forward(upstream, downstream);
            for (const peer of [downstream, upstream]) {
                peer.on('error', close);
                peer.on('close', close);
            }
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        stats,
        async close() {
            for (const timer of timers) clearTimeout(timer);
            for (const socket of sockets) socket.terminate();
            server.closeAllConnections();
            await Promise.all([
                new Promise(resolve => server.close(resolve)),
                new Promise(resolve => wss.close(resolve)),
            ]);
        },
    };
}
