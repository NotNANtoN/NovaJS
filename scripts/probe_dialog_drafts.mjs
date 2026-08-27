/**
 * Opens every dialog that can be shown while the world is stepping and
 * reports any exception, in particular the revoked-Immer-proxy crashes that
 * come from a dialog holding component data across an await.
 *
 * Usage: node scripts/probe_dialog_drafts.mjs [--url http://localhost:8200]
 *                                             [--headful]
 */
import { evaluate, keyDown, keyUp, launchChrome, openPage, sleep, waitFor }
    from './cdp.mjs';

const url = process.argv.includes('--url')
    ? process.argv[process.argv.indexOf('--url') + 1]
    : 'http://localhost:8200';
const headless = !process.argv.includes('--headful');

const SPACEPORT_SERVICES = [
    'Trade Center', 'Outfitter', 'Shipyard', 'Mission BBS', 'Bar', 'Ship Info',
];

async function tap(page, key, holdMs = 60) {
    await keyDown(page, key);
    await sleep(holdMs);
    await keyUp(page, key);
}

async function main() {
    const chrome = await launchChrome({ headless });
    let page;
    const problems = [];
    try {
        page = await openPage(chrome.wsUrl, url);
        page.on('Runtime.exceptionThrown', params => {
            const text = params.exceptionDetails?.exception?.description
                ?? params.exceptionDetails?.text ?? '';
            problems.push(String(text).split('\n')[0]);
        });
        page.on('Runtime.consoleAPICalled', params => {
            if (params.type !== 'error') {
                return;
            }
            const text = params.args
                .map(a => a.value ?? a.description ?? '').join(' ');
            if (/revoked|Uncaught/i.test(text)) {
                problems.push(text.split('\n')[0]);
            }
        });

        await waitFor(page, `document.querySelector('[data-menu-action]')`,
            { label: 'start menu', timeoutMs: 90_000 });
        await evaluate(page,
            `document.querySelector('[data-menu-action="New Pilot"]').click()`);
        await sleep(700);
        await evaluate(page, `(() => {
            const input = document.querySelector('input[type="text"]');
            if (input) {
                input.value = 'Drafts';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            [...document.querySelectorAll('button')]
                .find(b => (b.textContent || '').trim() === 'Launch')?.click();
        })()`);
        await waitFor(page,
            `document.querySelector('[data-menu-action="Enter Ship"]')`,
            { label: 'spaceport', timeoutMs: 60_000 });

        // The spaceport runs on top of a stepping world, so its dialogs are
        // exposed to the same revoked drafts as the in-flight ones.
        for (const service of SPACEPORT_SERVICES) {
            const clicked = await evaluate(page, `(() => {
                const button = [...document.querySelectorAll('*')]
                    .find(node => (node.textContent || '').trim()
                        === ${JSON.stringify(service)}
                        && node.children.length === 0);
                if (!button) return false;
                button.click();
                return true;
            })()`);
            if (!clicked) {
                continue;
            }
            await sleep(2_500);
            await evaluate(page, `(() => {
                const back = [...document.querySelectorAll('*')].find(node =>
                    ['Leave', 'Done', 'Back', 'Cancel']
                        .includes((node.textContent || '').trim())
                    && node.children.length === 0);
                back?.click();
            })()`);
            await sleep(500);
        }

        await evaluate(page,
            `document.querySelector('[data-menu-action="Enter Ship"]')?.click()`);
        await waitFor(page, `window.system && window.app`,
            { label: 'game world', timeoutMs: 60_000 });
        await sleep(2_000);

        const baselineBefore = await evaluate(page, `(() => {
            const time = [...window.system.resources.entries()]
                .find(([r]) => r.name === 'time');
            return time ? time[1].time : null;
        })()`);
        await sleep(1200);
        const baselineAfter = await evaluate(page, `(() => {
            const time = [...window.system.resources.entries()]
                .find(([r]) => r.name === 'time');
            return time ? time[1].time : null;
        })()`);
        console.log('baseline stepping:', baselineAfter > baselineBefore,
            'delta', (baselineAfter ?? 0) - (baselineBefore ?? 0));
        console.log('dom state:', await evaluate(page, `(() => ({
            menuVisible: Boolean(document.querySelector('[data-menu-action]')),
            enterShip: Boolean(
                document.querySelector('[data-menu-action="Enter Ship"]')),
        }))()`));

        // A pilot who has been in a fight has legal records, and the ship
        // info dialog walks them across an await. Without them the crashing
        // branch is never entered.
        console.log('legal records seeded:', await evaluate(page, `(() => {
            for (const [, entity] of window.system.entities) {
                const state = entity.componentsByName.get('PlayerStateComponent');
                if (state) {
                    state.legalRecords = { 'nova:151': -40, 'nova:152': 12 };
                    return true;
                }
            }
            return false;
        })()`));

        const clockNow = () => evaluate(page, `(() => {
            const time = [...window.system.resources.entries()]
                .find(([r]) => r.name === 'time');
            return time ? time[1].time : null;
        })()`);

        // In flight: pilot info, mission log, hail, map. Each is opened from
        // inside an async system step, so the world keeps stepping under it.
        // The same key closes it again; Escape would pause the world and hide
        // the very condition being tested.
        const stepping = {};
        for (const key of ['p', 'i', 'h', 'm']) {
            await tap(page, key);
            const before = await clockNow();
            await sleep(2_500);
            stepping[key] = {
                stepped: (await clockNow()) > before,
                visibleDialogs: await evaluate(page, `(() => {
                    const open = [];
                    for (const [resource, value] of
                            window.system.resources.entries()) {
                        if (value && value.container
                                && value.container.visible) {
                            open.push(resource.name);
                        }
                    }
                    return open;
                })()`),
            };
            await tap(page, key);
            await sleep(600);
        }

        console.log('per dialog:', JSON.stringify(stepping));
        const revoked = problems.filter(p => /revoked/i.test(p));
        console.log('revoked-proxy errors:', revoked.length);
        for (const problem of [...new Set(revoked)].slice(0, 5)) {
            console.log('  ', problem);
        }
        console.log('other errors:', [...new Set(
            problems.filter(p => !/revoked/i.test(p)))].slice(0, 6));
    } finally {
        try { page?.close(); } catch { /* ignore */ }
        chrome.close();
    }
}

await main();
