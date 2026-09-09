/**
 * Two real browsers, one server, one fight.
 *
 * The unit tests check the pieces of the netcode in isolation, which is weaker
 * evidence than the thing we actually care about: that when one pilot shoots
 * another, both of them see the same damage and the same death. Two separate
 * Chrome profiles are what make this a real test — each gets its own persistent
 * player token, so the server sees two distinct pilots rather than one.
 *
 * Usage: node scripts/probe_pvp.mjs [--url http://localhost:8200] [--headful]
 *        node scripts/probe_pvp.mjs --serve   (start dist/server.js itself)
 */
import { spawn } from 'node:child_process';
import {
    evaluate,
    keyDown,
    keyUp,
    launchChrome,
    openPage,
    sleep,
    waitFor,
} from './cdp.mjs';

const argv = process.argv;
const url = argv.includes('--url')
    ? argv[argv.indexOf('--url') + 1]
    : 'http://localhost:8200';
const headless = !argv.includes('--headful');
const serve = argv.includes('--serve');

/** Reads the state a client believes, for a ship named by uuid. */
const READ_SHIP = String.raw`
(uuid => {
  const entity = window.system?.entities?.get(uuid);
  if (!entity) { return { present: false, deathObserved: window.pvpProbe?.deathSeen ?? false }; }
  const stat = name => {
    const value = entity.componentsByName.get(name);
    return value ? { current: value.current, max: value.max } : undefined;
  };
  return {
    present: true,
    shield: stat('Shield'),
    armor: stat('Armor'),
    destructionStarted: entity.componentsByName.has('DestructionStartedComponent'),
    playerDeath: entity.componentsByName.has('PlayerDeathComponent'),
    fireLog: entity.componentsByName.get('FireLogComponent')?.shots?.length ?? 0,
    projectiles: [...window.system.entities].filter(
      ([, e]) => e.componentsByName.has('ProjectileData')).length,
    seenShots: window.pvpProbe?.shots.size ?? 0,
    drawnShots: window.pvpProbe?.drawn.size ?? 0,
    samples: window.pvpProbe?.samples,
    deathObserved: window.pvpProbe?.deathSeen ?? false,
    position: (() => { const p = entity.componentsByName.get('MovementState')?.position; return p ? [p.x, p.y] : null; })(),
  };
})`;

const openedChromes = [];

async function bootPilot(port, name) {
    const chrome = await launchChrome({ port, headless });
    openedChromes.push(chrome);
    const page = await openPage(chrome.wsUrl, url);
    let warnings = 0;
    page.on('Runtime.consoleAPICalled', ({ type, args }) => {
        if (type === 'warning' && String(args[0]?.value).startsWith('Failed') && warnings++ < 3) {
            console.warn(`[${name}]`, ...args.map(arg => arg.value ?? arg.description));
        }
    });
    await waitFor(page, `document.querySelector('[data-menu-action]')`,
        { label: `${name}: start menu`, timeoutMs: 120_000 });
    await evaluate(page,
        `document.querySelector('[data-menu-action="New Pilot"]').click()`);
    await sleep(500);
    await evaluate(page, `(() => {
        const input = document.querySelector('input[type="text"]');
        if (input) {
            input.value = ${JSON.stringify(name)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const launch = [...document.querySelectorAll('button')]
            .find(b => (b.textContent || '').trim() === 'Launch');
        if (launch) { launch.click(); }
    })()`);
    await waitFor(page, `document.querySelector('[data-menu-action="Enter Ship"]:not(:disabled)')`,
        { label: `${name}: enter ship button`, timeoutMs: 30_000 });
    await evaluate(page, `document.querySelector('[data-menu-action="Enter Ship"]').click()`);
    await waitFor(page, `window.system && window.app`,
        { label: `${name}: world`, timeoutMs: 120_000 });
    await waitFor(page, `(() => {
        for (const [, e] of window.system.entities) {
            if (e.componentsByName.has('ShipControl')) { return true; }
        }
        return document.querySelector('[data-nova-overlay="entering"] button') !== null;
    })()`, { label: `${name}: ship`, timeoutMs: 120_000 });
    const failure = await evaluate(page, `document.querySelector('[data-nova-overlay="entering"] button')
        ? document.querySelector('[data-nova-overlay="entering"]').textContent : null`);
    if (failure) throw new Error(`${name}: ${failure}`);
    await waitFor(page, `!document.querySelector('[data-nova-overlay="entering"]') || document.querySelector('[data-nova-overlay="entering"] button')`,
        { label: `${name}: flight assets and scene ready`, timeoutMs: 120_000 });
    const sceneFailure = await evaluate(page, `document.querySelector('[data-nova-overlay="entering"]')?.textContent`);
    if (sceneFailure) throw new Error(`${name}: ${sceneFailure}`);
    const uuid = await evaluate(page, `(() => {
        for (const [uuid, e] of window.system.entities) {
            if (e.componentsByName.has('ShipControl')) { return uuid; }
        }
    })()`);
    return { chrome, page, uuid, name };
}

/** Puts the two ships next to each other and aims the attacker. */
async function setUpDuel(attacker, victim) {
    // Movement is owning-client authority, so each pilot places its own ship.
    await evaluate(attacker.page, `(() => {
        const e = window.system.entities.get(${JSON.stringify(attacker.uuid)});
        const m = e.componentsByName.get('MovementState');
        e.components.set([...e.components.keys()].find(c => c.name === 'MovementState'), { ...m,
            position: new m.position.constructor(0, 0),
            velocity: new m.velocity.constructor(0, 0),
            rotation: new m.rotation.constructor(0),
        });
        e.componentsByName.get('TargetComponent').target = ${JSON.stringify(victim.uuid)};
    })()`);
    await evaluate(victim.page, `(() => {
        const e = window.system.entities.get(${JSON.stringify(victim.uuid)});
        const m = e.componentsByName.get('MovementState');
        e.components.set([...e.components.keys()].find(c => c.name === 'MovementState'), { ...m,
            position: new m.position.constructor(0, -120),
            velocity: new m.velocity.constructor(0, 0),
        });
    })()`);
    await sleep(1500);
}

async function trackShots(client, shooterUuid, victimUuid) {
    await evaluate(client.page, `(() => {
        const stats = window.pvpProbe = { shots: new Set(), drawn: new Set(), samples: [], deathSeen: false };
        window.app.ticker.add(() => {
            const target = window.system?.entities.get(${JSON.stringify(victimUuid)});
            if (target && (target.componentsByName.has('PlayerDeathComponent')
                || target.componentsByName.has('DestructionStartedComponent')
                || target.componentsByName.get('Armor')?.current <= 0)) stats.deathSeen = true;
            for (const [id, entity] of window.system?.entities ?? []) {
                if (!entity.componentsByName.has('ProjectileData') || entity.componentsByName.get('Source') !== ${JSON.stringify(shooterUuid)}) continue;
                stats.shots.add(id);
                const graphic = entity.componentsByName.get('AnimationGraphic');
                if (stats.samples.length < 1) stats.samples.push({ id, graphic: !!graphic, built: graphic?.built, disposed: graphic?.managed.disposed });
                if (graphic?.built && !graphic.managed.disposed) stats.drawn.add(id);
            }
        });
    })()`);
}

async function holdDuelPosition(victim) {
    // This probe measures a stationary-target duel, not autopilot pursuit after
    // knockback has pushed the target beyond the starting weapon's range.
    await evaluate(victim.page, `(() => {
        const e = window.system?.entities.get(${JSON.stringify(victim.uuid)});
        const m = e?.componentsByName.get('MovementState');
        if (m) e.components.set([...e.components.keys()].find(c => c.name === 'MovementState'), { ...m,
            position: new m.position.constructor(0, -120),
            velocity: new m.velocity.constructor(0, 0),
        });
    })()`);
}

const failures = [];
function check(label, condition, detail) {
    const ok = Boolean(condition);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`
        + (detail === undefined ? '' : ` ${JSON.stringify(detail)}`));
    if (!ok) {
        failures.push(label);
    }
}

let server;
if (serve) {
    server = spawn('node', ['dist/server.js'], { stdio: 'ignore' });
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                break;
            }
        } catch {
            // Not listening yet.
        }
        await sleep(500);
    }
}

let alice;
let bob;
try {
    [alice, bob] = await Promise.all([
        bootPilot(9333, 'Alice'),
        bootPilot(9334, 'Bob'),
    ]);
    console.log(`Alice ${alice.uuid}\nBob   ${bob.uuid}`);

    // Each pilot has to be able to see the other at all, or nothing that
    // follows means anything: interest management could have filtered them out.
    const aliceSeesBob = await evaluate(alice.page,
        `(${READ_SHIP})(${JSON.stringify(bob.uuid)})`);
    const bobSeesAlice = await evaluate(bob.page,
        `(${READ_SHIP})(${JSON.stringify(alice.uuid)})`);
    check('each client sees the other pilot',
        aliceSeesBob.present && bobSeesAlice.present,
        { aliceSeesBob: aliceSeesBob.present, bobSeesAlice: bobSeesAlice.present });

    await setUpDuel(alice, bob);

    const before = {
        onAlice: await evaluate(alice.page,
            `(${READ_SHIP})(${JSON.stringify(bob.uuid)})`),
        onBob: await evaluate(bob.page,
            `(${READ_SHIP})(${JSON.stringify(bob.uuid)})`),
    };
    console.log('before', JSON.stringify(before));

    // Alice opens fire. Bob does nothing: a one-sided fight makes the
    // attribution unambiguous.
    await Promise.all([trackShots(alice, alice.uuid, bob.uuid), trackShots(bob, alice.uuid, bob.uuid)]);
    await keyDown(alice.page, ' ');
    for (let i = 0; i < 16; i++) {
        await holdDuelPosition(bob);
        await sleep(250);
    }

    const during = {
        onAlice: await evaluate(alice.page,
            `(${READ_SHIP})(${JSON.stringify(bob.uuid)})`),
        onBob: await evaluate(bob.page,
            `(${READ_SHIP})(${JSON.stringify(bob.uuid)})`),
    };
    console.log('during', JSON.stringify(during));

    check('the shot exists on the shooter',
        during.onAlice.seenShots > 0 && during.onAlice.drawnShots > 0,
        { seen: during.onAlice.seenShots, drawn: during.onAlice.drawnShots });
    check('the victim also sees shots being fired at it',
        during.onBob.seenShots > 0 && during.onBob.drawnShots > 0,
        { seen: during.onBob.seenShots, drawn: during.onBob.drawnShots });

    const bobHealthOnAlice = (during.onAlice.shield?.current ?? 0)
        + (during.onAlice.armor?.current ?? 0);
    const bobHealthOnBob = (during.onBob.shield?.current ?? 0)
        + (during.onBob.armor?.current ?? 0);
    const startHealth = (before.onBob.shield?.current ?? 0)
        + (before.onBob.armor?.current ?? 0);
    check('the victim actually took damage', bobHealthOnBob < startHealth,
        { from: startHealth, to: bobHealthOnBob });
    // The point of the whole exercise: one authority, so both agree.
    check('both clients agree on the victim\'s health',
        Math.abs(bobHealthOnAlice - bobHealthOnBob)
            <= Math.max(2, startHealth * 0.05),
        { onAlice: bobHealthOnAlice, onBob: bobHealthOnBob });

    // Keep firing until the victim dies, so the kill itself is observed.
    for (let attempt = 0; attempt < 240; attempt++) {
        const state = await evaluate(bob.page,
            `(${READ_SHIP})(${JSON.stringify(bob.uuid)})`);
        if (state.playerDeath || state.destructionStarted || !state.present) {
            break;
        }
        await holdDuelPosition(bob);
        await sleep(250);
    }
    await keyUp(alice.page, ' ');
    await sleep(2000);

    const after = {
        onAlice: await evaluate(alice.page,
            `(${READ_SHIP})(${JSON.stringify(bob.uuid)})`),
        onBob: await evaluate(bob.page,
            `(${READ_SHIP})(${JSON.stringify(bob.uuid)})`),
    };
    console.log('after', JSON.stringify(after));

    const deadOnAlice = after.onAlice.playerDeath
        || after.onAlice.destructionStarted || after.onAlice.deathObserved;
    const deadOnBob = after.onBob.playerDeath || after.onBob.destructionStarted
        || after.onBob.deathObserved;
    check('the kill resolved for the victim', deadOnBob, after.onBob);
    check('the kill resolved for the shooter too', deadOnAlice, after.onAlice);
} finally {
    for (const chrome of openedChromes) chrome.close();
    server?.kill('SIGKILL');
}

if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:`);
    for (const failure of failures) {
        console.error(`  - ${failure}`);
    }
    process.exit(1);
}
console.log('\nAll checks passed.');
