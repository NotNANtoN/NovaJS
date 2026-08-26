/**
 * Minimal Chrome DevTools Protocol client used by the live gameplay probes.
 *
 * Puppeteer is not a dependency of this repository, so the probes talk to a
 * Chrome for Testing binary directly over the DevTools WebSocket.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const CHROME_CANDIDATES = [
    process.env.NOVA_CHROME,
    join(process.env.HOME ?? '', '.cache/puppeteer/chrome/mac_arm-134.0.6998.35'
        + '/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS'
        + '/Google Chrome for Testing'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function chromeBinary() {
    for (const candidate of CHROME_CANDIDATES) {
        try {
            // eslint-disable-next-line no-undef
            if (require('node:fs').existsSync(candidate)) {
                return candidate;
            }
        } catch {
            // Fall through to the import-based check below.
        }
    }
    return CHROME_CANDIDATES[CHROME_CANDIDATES.length - 1];
}

async function fetchJson(url, attempts = 100) {
    for (let i = 0; i < attempts; i++) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                return await response.json();
            }
        } catch {
            // Chrome is not listening yet.
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out fetching ${url}`);
}

export async function launchChrome({ port = 9333, headless = true } = {}) {
    const fs = await import('node:fs');
    const binary = CHROME_CANDIDATES.find(c => fs.existsSync(c))
        ?? chromeBinary();
    const profile = mkdtempSync(join(tmpdir(), 'nova-probe-'));
    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
        '--window-size=1280,800',
        // Pixi needs a real WebGL context; headless Chrome only has a
        // software rasterizer.
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--enable-webgl',
        'about:blank',
    ];
    if (headless) {
        args.unshift('--headless=new');
    }
    const child = spawn(binary, args, { stdio: 'ignore' });
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    return {
        child,
        port,
        wsUrl: version.webSocketDebuggerUrl,
        close() {
            child.kill('SIGKILL');
            try {
                rmSync(profile, { recursive: true, force: true });
            } catch {
                // Best effort cleanup.
            }
        },
    };
}

export class CdpSession {
    #ws;
    #nextId = 1;
    #pending = new Map();
    #listeners = new Map();
    sessionId;

    constructor(ws, sessionId) {
        this.#ws = ws;
        this.sessionId = sessionId;
    }

    static async connect(wsUrl) {
        const ws = new WebSocket(wsUrl, { maxPayload: 512 * 1024 * 1024 });
        await new Promise((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
        });
        const session = new CdpSession(ws);
        ws.on('message', data => session.#onMessage(data));
        return session;
    }

    #onMessage(data) {
        const message = JSON.parse(data.toString());
        if (message.id !== undefined) {
            const pending = this.#pending.get(message.id);
            if (!pending) {
                return;
            }
            this.#pending.delete(message.id);
            if (message.error) {
                pending.reject(new Error(JSON.stringify(message.error)));
            } else {
                pending.resolve(message.result);
            }
            return;
        }
        for (const listener of this.#listeners.get(message.method) ?? []) {
            listener(message.params, message.sessionId);
        }
    }

    on(method, listener) {
        const listeners = this.#listeners.get(method) ?? [];
        listeners.push(listener);
        this.#listeners.set(method, listeners);
    }

    send(method, params = {}, sessionId = this.sessionId) {
        const id = this.#nextId++;
        const payload = { id, method, params };
        if (sessionId) {
            payload.sessionId = sessionId;
        }
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
            this.#ws.send(JSON.stringify(payload));
        });
    }

    close() {
        this.#ws.close();
    }
}

export async function openPage(browserWsUrl, url) {
    const browser = await CdpSession.connect(browserWsUrl);
    const { targetId } = await browser.send('Target.createTarget', { url });
    const { sessionId } = await browser.send('Target.attachToTarget', {
        targetId,
        flatten: true,
    });
    const page = new CdpSession(browser['__ws'] ?? null, sessionId);
    // Reuse the browser socket for the flattened session.
    const proxy = {
        send: (method, params) => browser.send(method, params, sessionId),
        on: (method, listener) => browser.on(method, (params, id) => {
            if (!id || id === sessionId) {
                listener(params);
            }
        }),
        close: () => browser.close(),
        targetId,
    };
    void page;
    await proxy.send('Runtime.enable');
    await proxy.send('Page.enable');
    await proxy.send('Log.enable');
    // Without this, a probe that fails because the page threw reports only the
    // missing end state, which says nothing about the cause.
    proxy.on('Runtime.exceptionThrown', params => {
        const details = params?.exceptionDetails;
        console.error('[page exception] '
            + (details?.exception?.description ?? details?.text ?? ''));
    });
    proxy.on('Runtime.consoleAPICalled', params => {
        if (params?.type !== 'error') {
            return;
        }
        console.error('[page console.error] ' + (params.args ?? [])
            .map(arg => arg.description ?? arg.value ?? '').join(' '));
    });
    return proxy;
}

export async function evaluate(page, expression, { awaitPromise = true } = {}) {
    const result = await page.send('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true,
        allowUnsafeEvalBlobs: true,
    });
    if (result.exceptionDetails) {
        throw new Error('Page evaluate failed: '
            + JSON.stringify(result.exceptionDetails.exception?.description
                ?? result.exceptionDetails.text));
    }
    return result.result.value;
}

export async function waitFor(page, expression, {
    timeoutMs = 60_000, intervalMs = 100, label = expression,
} = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            if (await evaluate(page, `(() => { try { return Boolean(${expression}); } catch (e) { return false; } })()`)) {
                return true;
            }
        } catch {
            // Page may be mid-navigation.
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timed out waiting for: ${label}`);
}

const KEY_CODES = {
    ArrowUp: { keyCode: 38, code: 'ArrowUp' },
    ArrowDown: { keyCode: 40, code: 'ArrowDown' },
    ArrowLeft: { keyCode: 37, code: 'ArrowLeft' },
    ArrowRight: { keyCode: 39, code: 'ArrowRight' },
    Control: { keyCode: 17, code: 'ControlLeft' },
    Shift: { keyCode: 16, code: 'ShiftLeft' },
    ' ': { keyCode: 32, code: 'Space' },
    Tab: { keyCode: 9, code: 'Tab' },
};

export async function keyDown(page, key) {
    const info = KEY_CODES[key] ?? { keyCode: key.charCodeAt(0), code: `Key${key.toUpperCase()}` };
    await page.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key,
        code: info.code,
        windowsVirtualKeyCode: info.keyCode,
        nativeVirtualKeyCode: info.keyCode,
    });
}

export async function keyUp(page, key) {
    const info = KEY_CODES[key] ?? { keyCode: key.charCodeAt(0), code: `Key${key.toUpperCase()}` };
    await page.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code: info.code,
        windowsVirtualKeyCode: info.keyCode,
        nativeVirtualKeyCode: info.keyCode,
    });
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
