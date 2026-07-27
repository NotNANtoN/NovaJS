// Puppeteer glue for driving OUR game headlessly and capturing frames.
//
// All game state is reached through the same console levers the project's
// tests use (window.displayWorld, window.app, window.novaAutopilot,
// document keydown for controls). Nothing here talks to shared/preview
// tooling: the caller owns the browser and the server.
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { CHROME_PATH, CHROME_ARGS, VIEWPORT, BASE_URL } from './config.mjs';

export async function launchBrowser() {
    return puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: true,
        protocolTimeout: 180000,
        args: CHROME_ARGS,
        defaultViewport: VIEWPORT,
        // Unique profile per run so a stale lock never blocks startup.
        userDataDir: path.join(os.tmpdir(), `nova-vc-chrome-${process.pid}-${Date.now()}`),
    });
}

/**
 * Open the game with URL params (e.g. {ship:'nova:164', system:'nova:130'})
 * and wait until the sim world and PIXI app exist and the first frames have
 * settled (sprites stream in asynchronously).
 */
export async function openGame(browser, params = {}, { settleMs = 6000, entry = 'game' } = {}) {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));

    const qs = new URLSearchParams({ reset: '1', ...params }).toString();
    await page.goto(`${BASE_URL}/?${qs}`, { waitUntil: 'networkidle2', timeout: 60000 });
    if (entry === 'title') {
        // The title screen shows before the game world is joined; wait for
        // it (and its resource load) rather than for displayWorld.
        await page.waitForFunction(() => window.novaTitle && window.app,
            { timeout: 60000 });
        await page.evaluate(() => window.novaTitle.buildPromise);
    } else {
        await page.waitForFunction(
            () => window.displayWorld && window.app && window.communicator?.uuid,
            { timeout: 60000 });
    }
    await sleep(settleMs);
    page._vcErrors = errors;
    return page;
}

/** Dispatch a keydown/keyup for a control `code` on document (where the
 * game's control listeners live). */
export async function pressKey(page, code, { holdMs = 60 } = {}) {
    await page.evaluate((c) => {
        document.dispatchEvent(new KeyboardEvent('keydown',
            { code: c, key: c, bubbles: true }));
    }, code);
    await sleep(holdMs);
    await page.evaluate((c) => {
        document.dispatchEvent(new KeyboardEvent('keyup',
            { code: c, key: c, bubbles: true }));
    }, code);
}

/** BFS the PIXI stage for a container by name; returns {visible,bounds} or null. */
export function findContainer(page, name) {
    return page.evaluate((n) => {
        let hit = null;
        (function walk(node) {
            if (!node || hit) return;
            if (node.name === n) { hit = node; return; }
            (node.children || []).forEach(walk);
        })(window.app.stage);
        if (!hit) return null;
        const b = hit.getBounds();
        return {
            visible: hit.visible,
            worldVisible: hit.worldVisible,
            bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
        };
    }, name);
}

/** Wait until a named PIXI container is worldVisible. */
export async function waitForContainer(page, name, { timeout = 15000 } = {}) {
    await page.waitForFunction((n) => {
        let vis = false;
        (function walk(node) {
            if (!node || vis) return;
            if (node.name === n && node.worldVisible) { vis = true; return; }
            (node.children || []).forEach(walk);
        })(window.app.stage);
        return vis;
    }, { timeout }, name);
}

/** Click the center of a named PIXI container (e.g. 'Button:Cargo'). */
export async function clickContainer(page, name) {
    const info = await findContainer(page, name);
    if (!info) {
        throw new Error(`Container not found: ${name}`);
    }
    const { x, y, width, height } = info.bounds;
    await page.mouse.click(x + width / 2, y + height / 2);
    await sleep(300);
}

/** Open the player-info dialog (control 'properties' = KeyP). */
export async function openPlayerInfo(page) {
    await pressKey(page, 'KeyP');
    await waitForContainer(page, 'PlayerInfo');
    await sleep(1000);
}

/** Open the starmap (control 'map' = KeyM) and wait for it to be visible. */
export async function openStarmap(page) {
    await pressKey(page, 'KeyM');
    await page.waitForFunction(() => {
        let vis = false;
        (function walk(n) {
            if (!n || vis) return;
            if (n.name === 'StarMap' && n.worldVisible) { vis = true; return; }
            (n.children || []).forEach(walk);
        })(window.app.stage);
        return vis;
    }, { timeout: 15000 });
    await sleep(1500);
}

/** Clicks a starmap button by its Button container name (e.g.
 * 'Button:Show Borders'), routing through the same pointer path. */
export async function clickStarmapButton(page, label) {
    await clickContainer(page, `Button:${label}`);
}

/**
 * Plots a route in the open starmap by reading the graph's own shortest-path
 * table (SystemGraph.routes, keyed by system id -> path from the current
 * system) so the driven systems are guaranteed reachable regardless of which
 * stock system names happen to sit near Sol. Pins the first system exactly
 * `hops` jumps away as a multi-jump waypoint; when `alsoSingle` is set, also
 * plain-clicks an adjacent system to set the weaker single-jump line.
 * Returns the picked system names for logging.
 */
export async function plotRoute(page, { hops = 3, alsoSingle = false } = {}) {
    const picked = await page.evaluate((hops, alsoSingle) => {
        const graph = window.novaStarmap?.systemGraph;
        if (!graph) {
            return null;
        }
        let multiId;
        let singleId;
        for (const [id, path] of graph.routes) {
            if (!multiId && path.length === hops) {
                multiId = id;
            }
            if (!singleId && path.length === 1) {
                singleId = id;
            }
        }
        // Fall back to any multi-hop system if none is exactly `hops` away.
        if (!multiId) {
            for (const [id, path] of graph.routes) {
                if (path.length >= 2) {
                    multiId = id;
                    break;
                }
            }
        }
        if (multiId) {
            graph.onClickSystem(multiId, true);
        }
        if (alsoSingle && singleId) {
            graph.onClickSystem(singleId, false);
        }
        const nameOf = (id) => graph.systems.get(id)?.name;
        return { multi: nameOf(multiId), single: alsoSingle ? nameOf(singleId) : undefined };
    }, hops, alsoSingle);
    await sleep(300);
    return picked;
}

/** Fires a title-screen action (about / newPilot / openPilot / setPrefs)
 * through the TitleScreen's action subject, which the browser.ts
 * orchestrator subscribes to open the corresponding HTML dialog. */
export async function fireTitleAction(page, action) {
    await page.evaluate((a) => {
        window.novaTitle?.action.next(a);
    }, action);
    await sleep(600);
}

/** Waits for a DOM element (title dialogs are HTML overlays) by testid. */
export async function waitForTestId(page, testid, { timeout = 8000 } = {}) {
    await page.waitForSelector(`[data-testid="${testid}"]`, { timeout });
}

/** Autopilot to a planet uuid and wait until docked (body.nova-docked +
 * visible Spaceport container). */
export async function landAt(page, planetUuid, { timeout = 90000 } = {}) {
    await page.evaluate((u) => window.novaAutopilot.navigateTo(u), planetUuid);
    await page.waitForFunction(() => {
        if (!document.body.classList.contains('nova-docked')) return false;
        let vis = false;
        (function walk(n) {
            if (!n || vis) return;
            if (n.name === 'Spaceport' && n.worldVisible) { vis = true; return; }
            (n.children || []).forEach(walk);
        })(window.app.stage);
        return vis;
    }, { timeout, polling: 200 });
    await sleep(2000);
}

/**
 * Hide developer-only overlays that a shipping build would not show, so the
 * chrome comparison is not swamped by them: the stats.js FPS panel (a fixed
 * DOM div) and the debug "Add Enemy" button (a PIXI container in the status
 * bar). Documented as a harness caveat in README.md.
 */
export async function hideDebugOverlays(page) {
    await page.evaluate(() => {
        // stats.js panel: fixed div pinned top-left with a high z-index.
        for (const d of document.querySelectorAll('div')) {
            const s = d.style;
            if (s && s.position === 'fixed' && parseInt(s.zIndex || '0', 10) >= 10000) {
                d.style.display = 'none';
            }
        }
        // Debug "Add Enemy" button lives inside the status bar container.
        (function walk(n) {
            if (!n) return;
            if (n.name === 'Button:Add Enemy') { n.visible = false; return; }
            (n.children || []).forEach(walk);
        })(window.app.stage);
    });
    await sleep(400); // let the continuously-running ticker repaint
}

export async function capture(page, filepath) {
    await page.screenshot({ path: filepath, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
