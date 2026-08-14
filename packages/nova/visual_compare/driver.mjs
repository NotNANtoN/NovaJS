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

    // mute=1: harness runs never play the title theme / sfx (audio
    // escapes Chrome's "new" headless mode). Scenarios can override.
    const qs = new URLSearchParams(
        { reset: '1', mute: '1', ...params }).toString();
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

/**
 * Open the game restoring a crafted localStorage save (novajs:save v1),
 * so scenarios can start with credits, cargo, active missions and outfits
 * the default fresh pilot lacks. The save is injected before any page
 * script runs (evaluateOnNewDocument) and the URL omits ?reset (which
 * would wipe it). `save` is the SaveData payload (ship/outfits/system
 * required; credits/cargo/missions/... optional — see save_game.ts).
 */
export async function openGameWithSave(browser, save, { settleMs = 6000 } = {}) {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));

    const envelope = JSON.stringify({ version: 1, data: save });
    await page.evaluateOnNewDocument((key, val) => {
        try { window.localStorage.setItem(key, val); } catch { /* ignore */ }
    }, 'novajs:save', envelope);

    // No ?reset — that wipes the save before it is read. ?enter skips the
    // title screen and boots straight into the game using the save's
    // ship/system (browser.ts autoEnter), without overriding them.
    await page.goto(`${BASE_URL}/?enter=1`,
        { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(
        () => window.displayWorld && window.app && window.communicator?.uuid,
        { timeout: 60000 });
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

/** BFS the PIXI stage for a container by name; returns {visible,bounds} or
 * null. Names are not unique: the trade centre's button row and the
 * outfitter's/trade centre's quantity dialogs each own a 'Button:Buy'
 * (the shipyard's says 'Buy Ship'), and most are hidden — so prefer a
 * worldVisible match, falling back to the first match only when none is
 * visible. */
export function findContainer(page, name) {
    return page.evaluate((n) => {
        let hit = null;
        let firstAny = null;
        (function walk(node) {
            if (!node || hit) return;
            if (node.name === n) {
                if (!firstAny) firstAny = node;
                if (node.worldVisible) { hit = node; return; }
            }
            (node.children || []).forEach(walk);
        })(window.app.stage);
        hit = hit || firstAny;
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

/** Option/Alt-click a named container — the bulk-quantity trigger for
 * the outfitter's and trade center's Buy/Sell buttons. */
export async function optionClick(page, name) {
    const info = await findContainer(page, name);
    if (!info) {
        throw new Error(`Container not found: ${name}`);
    }
    const { x, y, width, height } = info.bounds;
    await page.keyboard.down('Alt');
    await page.mouse.click(x + width / 2, y + height / 2);
    await page.keyboard.up('Alt');
    await sleep(300);
}

/** Press a control key N times, spaced far enough apart for edge-triggered
 * grid navigation to register each press as distinct. */
export async function pressKeyN(page, code, n, { gapMs = 140 } = {}) {
    for (let i = 0; i < n; i++) {
        await pressKey(page, code);
        await sleep(gapMs);
    }
}

/** If a mission-offer popup (bar entry) is up, dismiss it so the surface
 * behind it (the bar's own buttons) is visible. Clicks Refuse when
 * present, otherwise Accept/OK, until no OfferPopup is worldVisible. */
export async function dismissOfferPopup(page, { max = 6 } = {}) {
    for (let i = 0; i < max; i++) {
        const popup = await findContainer(page, 'OfferPopup');
        if (!popup || !popup.worldVisible) {
            return;
        }
        // Prefer Refuse (leaves no follow-on briefing accept chain);
        // fall back to the accept/OK button label.
        const refuse = await findContainer(page, 'Button:Refuse');
        const target = (refuse && refuse.worldVisible)
            ? refuse : await firstVisibleButton(page,
                ['Button:No', 'Button:OK', 'Button:Okay', 'Button:Accept',
                    'Button:Yes']);
        if (!target) {
            return;
        }
        const { x, y, width, height } = target.bounds;
        await page.mouse.click(x + width / 2, y + height / 2);
        await sleep(500);
    }
}

async function firstVisibleButton(page, names) {
    for (const name of names) {
        const info = await findContainer(page, name);
        if (info && info.worldVisible) {
            return info;
        }
    }
    return null;
}

/**
 * Render the hail/comms dialog for a crafted HailContext, centered on
 * screen. The plugin only centers the dialog on the real 'y' control
 * path, so we position its container ourselves before show(); show()
 * blocks on dismissal, so it's fired without awaiting. Deterministic —
 * no ship spawning / targeting needed — which is what the chrome
 * measurement wants.
 */
export async function showHail(page, context) {
    await page.evaluate((ctx) => {
        const dialog = window.novaHailDialog;
        dialog.container.position.set(960, 540);
        void dialog.show(ctx);
    }, context);
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
 * DOM div) and the debug buttons ("Add Enemy", "Give 1M Credits", "Clear
 * Legal Record" — PIXI containers stacked in the status bar). Documented as
 * a harness caveat in README.md.
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
        // The debug buttons live inside the status bar container.
        const debugButtons = new Set([
            'Button:Add Enemy', 'Button:Give 1M Credits',
            'Button:Clear Legal Record',
        ]);
        (function walk(n) {
            if (!n) return;
            if (debugButtons.has(n.name)) { n.visible = false; return; }
            (n.children || []).forEach(walk);
        })(window.app.stage);
    });
    await sleep(400); // let the continuously-running ticker repaint
}

/**
 * Opens the boarding plunder dialog (PICT 8515), or the capture-assignment
 * dialog (PICT 8516) when `capture: 'succeeded'` is passed.
 *
 * Boarding is normally reached by disabling a ship, pulling alongside
 * (close / speed-matched / axis-aligned) and pressing 'b' — a physics setup
 * that is slow and non-deterministic headless. The dialogs themselves are
 * pure display slaves of the synced BoardingComponent on the player's ship
 * (display/boarding_plugin.ts), so — exactly like showHail drives the comm
 * dialog directly — we spawn a shuttle to act as the boarded victim, then
 * inject the BoardingComponent on the display player. The rendered dialog is
 * pixel-identical to one reached through the real gate; only the state's
 * provenance differs. The Boarding component singleton is reached through
 * window.novaSimSerializer (the sim serializer's componentsByName registry),
 * the only in-page handle on the synced-component instances.
 */
export async function openBoarding(page,
    { capture = 'none', cargo = 9, ammo = 0 } = {}) {
    // Spawn a shuttle to be the boarded victim (has Cargo + Fuel components
    // the plunder dialog reads).
    await page.evaluate(() => {
        const dw = window.displayWorld;
        for (const [k] of dw.events) {
            if (k.name === 'AddEnemyEvent') {
                dw.emit(k, { shipId: 'nova:128' });
                break;
            }
        }
    });
    await sleep(4000);
    const ok = await page.evaluate((capture, cargo, ammo) => {
        const dw = window.displayWorld;
        const Boarding = window.novaSimSerializer?.componentsByName?.get('Boarding');
        if (!Boarding) return false;
        let playerId, player;
        for (const [id, e] of dw.entities) {
            if ([...e.components.keys()].some(c => c.name === 'ShipControl')) {
                playerId = id; player = e; break;
            }
        }
        let targetId, target;
        for (const [id, e] of dw.entities) {
            if (id === playerId) continue;
            const names = [...e.components.keys()].map(c => c.name);
            if (names.includes('ShipData') && names.includes('Cargo')) {
                targetId = id; target = e; break;
            }
        }
        if (!player || !targetId) return false;
        const Cargo = [...target.components.keys()].find(c => c.name === 'Cargo');
        if (Cargo && cargo > 0) target.components.get(Cargo).set('Metal', cargo);
        player.components.set(Boarding, {
            target: targetId, creditsAvailable: 1000, ammoAvailable: ammo,
            cargoTaken: false, creditsTaken: false, fuelTaken: false,
            ammoTaken: false, capture, crimeApplied: false,
        });
        return true;
    }, capture, cargo, ammo);
    if (!ok) throw new Error('openBoarding: could not inject BoardingComponent');
    await waitForContainer(page,
        capture === 'succeeded' ? 'CaptureAssignment' : 'PlunderDialog');
    await sleep(800);
}

export async function capture(page, filepath) {
    await page.screenshot({ path: filepath, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
