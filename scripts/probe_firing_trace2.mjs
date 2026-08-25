/**
 * Follow-up trace: record every WeaponsStateComponent replacement together
 * with the firing flag it carried, so a replication overwrite of local
 * trigger intent is distinguishable from intent never being set.
 */
import { launchChrome, openPage, evaluate, waitFor, keyDown, keyUp, sleep } from './cdp.mjs';

const TRACE = String.raw`
(() => {
  const probe = { log: [], t0: performance.now() };
  window.__f2 = probe;
  const rel = () => +(performance.now() - probe.t0).toFixed(1);
  window.addEventListener('keydown', e => probe.log.push([rel(), 'keydown', e.code]), true);
  window.addEventListener('keyup', e => probe.log.push([rel(), 'keyup', e.code]), true);

  const player = () => {
    for (const [uuid, e] of window.system.entities)
      if (e.componentsByName.has('ShipControl')) return e;
  };

  const entity = player();
  probe.entity = entity;

  // ComponentMap is an EventMap: observe every set of the weapons component.
  entity.components.events.add.subscribe(([component, value]) => {
    if (component.name !== 'WeaponsStateComponent') return;
    const firing = [...value].map(([id, s]) => id + '=' + s.firing).join(',');
    probe.log.push([rel(), 'setWeaponsState', firing]);
  });

  const origStep = window.system.step.bind(window.system);
  window.system.step = (...args) => {
    const before = entity.componentsByName.get('WeaponsStateComponent');
    const b = before ? [...before].map(([i,s]) => s.firing).join(',') : '?';
    const r = origStep(...args);
    const after = entity.componentsByName.get('WeaponsStateComponent');
    const a = after ? [...after].map(([i,s]) => s.firing).join(',') : '?';
    if (b !== a) probe.log.push([rel(), 'stepChangedFiring', b + '->' + a]);
    return r;
  };

  let lastProj = new Set();
  probe.timer = setInterval(() => {
    const now = new Set();
    for (const [uuid, e] of window.system.entities) {
      if (!e.componentsByName.has('Projectile')) continue;
      now.add(uuid);
      if (!lastProj.has(uuid)) {
        const g = e.componentsByName.get('AnimationGraphic');
        probe.log.push([rel(), 'projectile', uuid.slice(0,8)
          + ' graphic=' + Boolean(g)
          + ' disposed=' + Boolean(g && g.managed && g.managed.disposed)
          + ' parent=' + Boolean(g && g.container && g.container.parent)]);
      }
    }
    lastProj = now;
  }, 4);
  return 'ok';
})()
`;

async function main() {
    const chrome = await launchChrome({ headless: true });
    let page;
    try {
        page = await openPage(chrome.wsUrl, 'http://localhost:8200');
        await waitFor(page, `document.querySelector('[data-menu-action]')`, { timeoutMs: 120_000, label: 'menu' });
        await evaluate(page, `document.querySelector('[data-menu-action="New Pilot"]').click()`);
        await sleep(600);
        await evaluate(page, `(() => { const b=[...document.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='Launch'); if(b) b.click(); })()`);
        await waitFor(page, `window.system && (() => { for (const [,e] of window.system.entities) if (e.componentsByName.has('ShipControl')) return true; return false; })()`,
            { timeoutMs: 120_000, label: 'player ship' });
        await sleep(2500);
        console.log(await evaluate(page, TRACE));
        await sleep(400);
        await evaluate(page, `window.__f2.log.length = 0; window.__f2.t0 = performance.now();`);

        await keyDown(page, ' ');
        await sleep(1500);
        await keyUp(page, ' ');
        await sleep(800);

        const log = await evaluate(page, `window.__f2.log`);
        for (const row of log) console.log(String(row[0]).padStart(8), row[1], row[2]);
    } finally {
        try { page?.close(); } catch { /* ignore */ }
        chrome.close();
    }
}

main().catch(e => { console.error(e); process.exit(1); });
