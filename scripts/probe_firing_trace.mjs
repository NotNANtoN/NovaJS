/**
 * High-resolution trace of the firing-intent lifecycle:
 * key event -> ControlState -> WeaponsState.firing -> projectile entity.
 *
 * Samples far faster than the render loop so a single-frame intent that is
 * immediately overwritten by replication is still observed.
 */
import { launchChrome, openPage, evaluate, waitFor, keyDown, keyUp, sleep } from './cdp.mjs';

const url = 'http://localhost:8200';

const TRACE = String.raw`
(() => {
  const probe = { events: [], t0: performance.now() };
  window.__fire = probe;
  const log = (kind, data) => probe.events.push(
    Object.assign({ t: +(performance.now() - probe.t0).toFixed(1), kind }, data));

  window.addEventListener('keydown', e => log('keydown', { code: e.code }), true);
  window.addEventListener('keyup', e => log('keyup', { code: e.code }), true);

  const player = () => {
    for (const [uuid, e] of window.system.entities) {
      if (e.componentsByName.has('ShipControl')) return [uuid, e];
    }
  };

  let lastFiring = null;
  let lastStateObj = null;
  let lastComponentMapObj = null;
  let lastControl = null;
  let lastProjectiles = new Set();
  let lastOwed = null;

  const tick = () => {
    const sys = window.system;
    if (!sys) return;
    const p = player();
    if (!p) return;
    const names = p[1].componentsByName;
    const ws = names.get('WeaponsStateComponent');
    const local = names.get('WeaponsComponent');
    if (ws !== lastComponentMapObj) {
      log('weaponsStateComponentReplaced', {});
      lastComponentMapObj = ws;
    }
    if (ws) {
      for (const [id, s] of ws) {
        if (s !== lastStateObj) { log('weaponStateObjectReplaced', { id }); lastStateObj = s; }
        if (s.firing !== lastFiring) {
          log('firing', { id, firing: s.firing });
          lastFiring = s.firing;
        }
        const l = local && local.get ? local.get(id) : undefined;
        const owed = l && l.shotsOwed;
        if (owed !== lastOwed) { log('shotsOwed', { owed: owed === undefined ? null : +owed.toFixed(3) }); lastOwed = owed; }
      }
    }
    const controlRes = [...sys.resources.entries()].filter(([r]) => r.name === 'ControlStateResource')[0];
    if (controlRes) {
      const fp = JSON.stringify([...controlRes[1]]);
      if (fp !== lastControl) { log('controlState', { state: fp }); lastControl = fp; }
    }
    const now = new Set();
    for (const [uuid, e] of sys.entities) {
      if (!e.componentsByName.has('Projectile')) continue;
      now.add(uuid);
      if (!lastProjectiles.has(uuid)) {
        const g = e.componentsByName.get('AnimationGraphic');
        log('projectileCreated', {
          uuid: uuid.slice(0, 8), name: e.name,
          hasGraphic: Boolean(g),
          disposed: Boolean(g && g.managed && g.managed.disposed),
          destroyed: Boolean(g && g.container && g.container.destroyed),
          hasParent: Boolean(g && g.container && g.container.parent),
        });
      }
    }
    for (const uuid of lastProjectiles) {
      if (!now.has(uuid)) log('projectileRemoved', { uuid: uuid.slice(0, 8) });
    }
    lastProjectiles = now;
  };

  probe.timer = setInterval(tick, 4);
  return 'traced';
})()
`;

async function main() {
    const chrome = await launchChrome({ headless: true });
    let page;
    try {
        page = await openPage(chrome.wsUrl, url);
        const logs = [];
        page.on('Runtime.consoleAPICalled', p => logs.push(
            p.args.map(a => a.value ?? a.description).join(' ')));
        await waitFor(page, `document.querySelector('[data-menu-action]')`, { timeoutMs: 120_000, label: 'menu' });
        await evaluate(page, `document.querySelector('[data-menu-action="New Pilot"]').click()`);
        await sleep(600);
        await evaluate(page, `(() => { const b=[...document.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='Launch'); if(b) b.click(); })()`);
        await waitFor(page, `window.system && (() => { for (const [,e] of window.system.entities) if (e.componentsByName.has('ShipControl')) return true; return false; })()`,
            { timeoutMs: 120_000, label: 'player ship' });
        await sleep(2000);
        await evaluate(page, TRACE);
        await sleep(600);
        await evaluate(page, `window.__fire.events.length = 0; window.__fire.t0 = performance.now();`);

        await keyDown(page, ' ');
        await sleep(80);
        await keyUp(page, ' ');
        await sleep(1200);
        await keyDown(page, ' ');
        await sleep(80);
        await keyUp(page, ' ');
        await sleep(1200);
        await keyDown(page, ' ');
        await sleep(2500);
        await keyUp(page, ' ');
        await sleep(1000);

        const events = await evaluate(page, `window.__fire.events`);
        for (const e of events) {
            console.log(String(e.t).padStart(8), e.kind, JSON.stringify(
                Object.fromEntries(Object.entries(e).filter(([k]) => k !== 't' && k !== 'kind'))));
        }
        console.log('--- console ---');
        console.log(logs.filter(l => /warn|error|Error/i.test(l)).slice(0, 20).join('\n'));
    } finally {
        try { page?.close(); } catch { /* ignore */ }
        chrome.close();
    }
}

main().catch(e => { console.error(e); process.exit(1); });
