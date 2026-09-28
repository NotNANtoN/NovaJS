/**
 * Live probe for the debug menu. Needs a local server started with a debug
 * token, e.g.
 *   NOVA_DEBUG_TOKEN=probe NOVA_PLAYER_DATA=/tmp/dbg.json NOVA_PORT=8311 node dist/server.js
 *   node scripts/probe_debug_menu.mjs
 * Never point this at production.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { evaluate, launchChrome, openPage, sleep, waitFor } from './cdp.mjs';

const base = process.env.NOVA_PROBE_URL ?? 'http://localhost:8311';
const token = process.env.NOVA_DEBUG_TOKEN ?? 'probe';
const chrome = await launchChrome({ port: Number(process.env.NOVA_PROBE_PORT ?? 9351) });
const problems = [];
let page;

async function screenshot(name) {
    const capture = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`/tmp/${name}.png`, Buffer.from(capture.data, 'base64'));
    console.log(`screenshot /tmp/${name}.png`);
}

const clickText = text => evaluate(page, `(() => {
    const node = [...document.querySelectorAll('button')]
        .find(b => (b.textContent || '').trim() === ${JSON.stringify(text)});
    node?.click();
    return Boolean(node);
})()`);

try {
    page = await openPage(chrome.wsUrl, `${base}/?debug=${token}`);
    page.on('Runtime.exceptionThrown', params => {
        problems.push(String(params.exceptionDetails?.exception?.description
            ?? params.exceptionDetails?.text).split('\n')[0]);
    });
    await waitFor(page, `document.querySelector('[data-menu-action]')`,
        { label: 'start menu', timeoutMs: 120_000 });
    await evaluate(page, `document.querySelector('[data-menu-action="New Pilot"]').click()`);
    await sleep(700);
    await evaluate(page, `(() => {
        const input = document.querySelector('input[type="text"]');
        if (input) { input.value = 'Debug'; input.dispatchEvent(new Event('input', { bubbles: true })); }
        [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Launch')?.click();
    })()`);
    await waitFor(page, `document.querySelector('[data-menu-action="Enter Ship"]')`,
        { label: 'spaceport', timeoutMs: 90_000 });
    await evaluate(page, `document.querySelector('[data-menu-action="Enter Ship"]')?.click()`);
    await waitFor(page, `window.system && window.app && window.myShip`, { label: 'flight', timeoutMs: 120_000 });
    await waitFor(page, `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'DEBUG')`,
        { label: 'debug button', timeoutMs: 30_000 });
    await sleep(1500);
    assert.ok(await clickText('DEBUG'), 'debug button clickable');
    await sleep(1000);
    await screenshot('debug_menu_open');
    const panel = await evaluate(page, `(() => {
        const headings = [...document.querySelectorAll('h3')].map(h => h.textContent.trim());
        const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'DEBUG');
        const rect = button.getBoundingClientRect();
        return { headings, button: [Math.round(rect.left), Math.round(rect.top), innerWidth, innerHeight] };
    })()`);
    console.log('panel:', JSON.stringify(panel));
    assert.ok(await clickText('GIVE PLANET BUSTER'), 'planet buster button');
    await sleep(2500);
    console.log('state:', JSON.stringify(await evaluate(page, `(() => ({
        myShip: Boolean(window.myShip),
        entities: window.system ? window.system.entities.size : -1,
        status: [...document.querySelectorAll('.nd-dim')].map(n => n.textContent).slice(0, 4),
        menu: Boolean(document.querySelector('[data-menu-action]')),
    }))()`)));
    const outfits = await evaluate(page, `(() => {
        const player = window.myShip;
        const key = [...player.components.keys()].find(c => c.name === 'OutfitsStateComponent');
        return [...player.components.get(key).keys()];
    })()`);
    console.log('outfits after give:', outfits);
    assert.ok(outfits.includes('debug:planetbuster'), 'planet buster installed');
    await screenshot('debug_menu_buster');

    const firstButton = label => evaluate(page, `(() => {
        const node = [...document.querySelectorAll('button')]
            .find(b => (b.textContent || '').trim() === ${JSON.stringify(label)});
        node?.click();
        return Boolean(node);
    })()`);
    const playerState = () => evaluate(page, `(() => {
        const key = [...window.myShip.components.keys()].find(c => c.name === 'PlayerStateComponent');
        const s = window.myShip.components.get(key);
        return { shipId: s.shipId, bit100: s.missionBits[100], destroyed: [...s.destroyedStellars] };
    })()`);

    // Switch hull: pick the list entry for the Pegasus (nova:132).
    await evaluate(page, `(() => {
        const search = [...document.querySelectorAll('input[type=search]')][0];
        search.value = 'Pegasus';
        search.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(300);
    assert.ok(await firstButton('Switch'), 'switch button');
    await waitFor(page, `(() => {
        const key = [...window.myShip.components.keys()].find(c => c.name === 'PlayerStateComponent');
        return window.myShip.components.get(key).shipId !== 'nova:128';
    })()`, { label: 'hull switch', timeoutMs: 15_000 });

    // Control bit 100.
    assert.ok(await evaluate(page, `(() => {
        const input = [...document.querySelectorAll('input')].find(i => i.placeholder === 'bit #');
        input.value = '100';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const set = [...input.parentElement.querySelectorAll('button')]
            .find(b => b.textContent.trim() === 'Set');
        set?.click();
        return Boolean(set);
    })()`), 'set bit');
    await sleep(500);

    // Destroy the first stellar in the system for this pilot.
    assert.ok(await firstButton('Destroy'), 'destroy stellar');
    await sleep(2000);
    const after = await playerState();
    console.log('after actions:', JSON.stringify(after));
    assert.equal(after.bit100, true);
    assert.ok(after.destroyed.length >= 1, 'stellar destroyed for pilot');
    await screenshot('debug_menu_actions');
    console.log(problems.length ? `page errors: ${problems.join(' | ')}` : 'no page errors');
    assert.equal(problems.length, 0);
    console.log('DEBUG MENU PROBE OK');
} finally {
    chrome.close?.();
}
