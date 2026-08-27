/**
 * Live probe for three reported symptoms:
 *   1. ships that appear and vanish again
 *   2. destruction-like sounds while merely being hit
 *   3. shots that are not visible while fighting
 *
 * Usage: node scripts/probe_bug_report.mjs [--url http://localhost:8200]
 *                                          [--headful] [--seconds 25]
 */
import {
    evaluate, keyDown, keyUp, launchChrome, openPage, sleep, waitFor,
} from './cdp.mjs';

const url = process.argv.includes('--url')
    ? process.argv[process.argv.indexOf('--url') + 1]
    : 'http://localhost:8200';
const seconds = process.argv.includes('--seconds')
    ? Number(process.argv[process.argv.indexOf('--seconds') + 1])
    : 25;
const headless = !process.argv.includes('--headful');
const provoke = process.argv.includes('--provoke');

const INSTRUMENT = String.raw`
(() => {
  if (window.__bugProbe) { return 'already'; }
  const probe = {
    sounds: [],
    shipEvents: [],
    shotSamples: [],
    seenShips: new Map(),
    frames: 0,
  };
  window.__bugProbe = probe;

  // Every play goes through getCached first, so this records the exact
  // sequence of sound ids the game asks for.
  const soundData = window.gameData && window.gameData.data
    && window.gameData.data.Sound;
  if (soundData) {
    const origCached = soundData.getCached.bind(soundData);
    soundData.getCached = id => {
      probe.sounds.push({ t: Math.round(performance.now()), id });
      return origCached(id);
    };
    const origGet = soundData.get.bind(soundData);
    soundData.get = id => {
      probe.sounds.push({ t: Math.round(performance.now()), id, load: true });
      return origGet(id);
    };
  }

  const playerUuid = () => {
    const sys = window.system;
    if (!sys) return undefined;
    for (const [uuid, entity] of sys.entities) {
      if (entity.componentsByName.has('ShipControl')) return uuid;
    }
    return undefined;
  };

  const positionOf = entity => {
    const movement = entity.componentsByName.get('MovementState');
    return movement ? movement.position : undefined;
  };

  probe.sample = () => {
    const sys = window.system;
    if (!sys) return;
    const t = Math.round(performance.now());
    const me = playerUuid();
    const meEntity = me && sys.entities.get(me);
    const mePos = meEntity && positionOf(meEntity);
    const distanceFromMe = entity => {
      const p = positionOf(entity);
      if (!p || !mePos) return null;
      return Math.round(Math.hypot(p.x - mePos.x, p.y - mePos.y));
    };
    const planets = [];
    for (const [, entity] of sys.entities) {
      if (entity.componentsByName.has('PlanetData')
          || entity.componentsByName.has('Planet')) {
        const p = positionOf(entity);
        if (p) planets.push({ name: entity.name, x: p.x, y: p.y });
      }
    }
    const nearestPlanet = entity => {
      const p = positionOf(entity);
      if (!p || planets.length === 0) return null;
      let best = null;
      for (const planet of planets) {
        const d = Math.round(Math.hypot(planet.x - p.x, planet.y - p.y));
        if (best === null || d < best.d) best = { d, name: planet.name };
      }
      return best;
    };
    if (meEntity) {
      const health = meEntity.componentsByName.get('Health');
      if (health) {
        probe.health = {
          t,
          shield: health.shield && health.shield.current,
          armor: health.armor && health.armor.current,
        };
        probe.healthLog = probe.healthLog || [];
        probe.healthLog.push(probe.health);
      }
    }
    const explosions = [];
    for (const [, entity] of sys.entities) {
      if (entity.componentsByName.has('ExplosionData')) {
        explosions.push({ name: entity.name, d: distanceFromMe(entity) });
      }
    }
    if (explosions.length) {
      probe.explosionLog = probe.explosionLog || [];
      probe.explosionLog.push({ t, explosions });
    }
    const present = new Set();

    let projectiles = 0;
    let drawn = 0;
    let undrawn = 0;
    const undrawnDetail = [];

    for (const [uuid, entity] of sys.entities) {
      const names = entity.componentsByName;
      if (names.has('Ship')) {
        present.add(uuid);
        if (!probe.seenShips.has(uuid)) {
          probe.seenShips.set(uuid, { firstSeen: t, lastSeen: t,
            firstDistance: distanceFromMe(entity) });
          probe.shipEvents.push({ t, kind: 'appear', uuid,
            name: entity.name,
            mine: uuid === me });
        } else {
          const record = probe.seenShips.get(uuid);
          record.lastSeen = t;
          record.lastDistance = distanceFromMe(entity);
          record.lastPlanet = nearestPlanet(entity);
          const movement = entity.componentsByName.get('MovementState');
          record.lastSpeed = movement
            ? Math.round(Math.hypot(movement.velocity.x, movement.velocity.y))
            : null;
        }
      }
      if (names.has('Projectile')) {
        projectiles++;
        const graphic = names.get('AnimationGraphic');
        const container = graphic && graphic.container;
        const visible = Boolean(container && container.parent
          && container.worldVisible && container.worldAlpha > 0);
        if (visible) { drawn++; } else {
          undrawn++;
          if (undrawnDetail.length < 3) {
            undrawnDetail.push({
              name: entity.name,
              hasGraphic: Boolean(graphic),
              hasContainer: Boolean(container),
              hasParent: Boolean(container && container.parent),
              worldVisible: container ? container.worldVisible : null,
              alpha: container ? container.worldAlpha : null,
              loaded: names.has('AnimationGraphicLoaded'),
            });
          }
        }
      }
    }

    for (const [uuid, record] of probe.seenShips) {
      if (record.lastSeen === t || record.gone) continue;
      record.gone = t;
      probe.shipEvents.push({ t, kind: 'vanish', uuid,
        lifetimeMs: t - record.firstSeen,
        lastDistance: record.lastDistance });
    }

    probe.shotSamples.push({ t, projectiles, drawn, undrawn, undrawnDetail });
  };

  // Per-frame projectile visibility: how long a shot exists before it is
  // actually drawn, and how long it lives in total.
  probe.shotLives = new Map();
  probe.attachFrameHook = () => {
    if (probe.frameHooked || !window.app) return 'no-app';
    probe.frameHooked = true;
    window.app.ticker.add(() => {
      probe.frames++;
      const sys = window.system;
      if (!sys) return;
      const t = performance.now();
      const alive = new Set();
      for (const [uuid, entity] of sys.entities) {
        if (!entity.componentsByName.has('Projectile')) continue;
        alive.add(uuid);
        let record = probe.shotLives.get(uuid);
        if (!record) {
          record = { firstSeen: t, name: entity.name, frames: 0,
            framesUndrawn: 0 };
          probe.shotLives.set(uuid, record);
        }
        record.frames++;
        record.lastSeen = t;
        const graphic = entity.componentsByName.get('AnimationGraphic');
        const container = graphic && graphic.container;
        const drawn = Boolean(container && container.parent
          && container.worldVisible && container.worldAlpha > 0);
        if (drawn) {
          if (record.firstDrawn === undefined) record.firstDrawn = t;
        } else {
          record.framesUndrawn++;
        }
      }
      for (const [uuid, record] of probe.shotLives) {
        if (!alive.has(uuid) && record.gone === undefined) {
          record.gone = t;
        }
      }
    });
    return 'hooked';
  };

  probe.shotReport = () => {
    const done = [...probe.shotLives.values()]
      .filter(r => r.gone !== undefined);
    const rows = done.map(r => ({
      name: r.name,
      lifeMs: Math.round(r.gone - r.firstSeen),
      invisibleMs: r.firstDrawn === undefined
        ? Math.round(r.gone - r.firstSeen)
        : Math.round(r.firstDrawn - r.firstSeen),
      frames: r.frames,
      framesUndrawn: r.framesUndrawn,
      neverDrawn: r.firstDrawn === undefined,
    }));
    const invisible = rows.map(r => r.invisibleMs).sort((a, b) => a - b);
    return {
      shots: rows.length,
      neverDrawn: rows.filter(r => r.neverDrawn).length,
      medianInvisibleMs: invisible[Math.floor(invisible.length / 2)],
      worstInvisibleMs: invisible[invisible.length - 1],
      medianLifeMs: rows.map(r => r.lifeMs)
        .sort((a, b) => a - b)[Math.floor(rows.length / 2)],
      sample: rows.slice(0, 12),
      totalFrames: probe.frames,
    };
  };

  // Returns which way to turn to face the current target, so the driver can
  // hold the matching arrow key and actually land hits.
  probe.steerToTarget = () => {
    const sys = window.system;
    const me = playerUuid();
    if (!sys || !me) return 'none';
    const meEntity = sys.entities.get(me);
    const target = meEntity && meEntity.componentsByName.get('Target');
    const targetUuid = target && (target.target || target.uuid || target);
    const targetEntity = typeof targetUuid === 'string'
      ? sys.entities.get(targetUuid) : undefined;
    const mine = meEntity && meEntity.componentsByName.get('MovementState');
    const theirs = targetEntity
      && targetEntity.componentsByName.get('MovementState');
    if (!mine || !theirs) return 'none';
    const wanted = Math.atan2(theirs.position.y - mine.position.y,
      theirs.position.x - mine.position.x);
    let error = wanted - mine.rotation.angle;
    while (error > Math.PI) error -= Math.PI * 2;
    while (error < -Math.PI) error += Math.PI * 2;
    if (Math.abs(error) < 0.12) return 'none';
    return error > 0 ? 'right' : 'left';
  };

  probe.time = () => {
    const sys = window.system;
    if (!sys) return null;
    for (const [resource, value] of sys.resources.entries()) {
      if (/time/i.test(resource.name)) {
        return { name: resource.name, time: value && value.time };
      }
    }
    return null;
  };

  probe.summary = () => {
    const ships = [...probe.seenShips.entries()].map(([uuid, r]) => ({
      uuid: uuid.slice(0, 8),
      lifetimeMs: (r.gone ?? r.lastSeen) - r.firstSeen,
      vanished: Boolean(r.gone),
      firstDistance: r.firstDistance,
      lastDistance: r.lastDistance,
      lastPlanet: r.lastPlanet,
      lastSpeed: r.lastSpeed,
    }));
    const counts = {};
    for (const s of probe.sounds) {
      counts[s.id] = (counts[s.id] || 0) + 1;
    }
    const worst = probe.shotSamples
      .filter(s => s.undrawn > 0)
      .slice(0, 5);
    return {
      soundCounts: counts,
      soundOrder: probe.sounds.slice(0, 40),
      ships,
      shortLivedShips: ships.filter(s => s.vanished && s.lifetimeMs < 4000),
      maxProjectiles: Math.max(0, ...probe.shotSamples.map(s => s.projectiles)),
      samplesWithProjectiles:
        probe.shotSamples.filter(s => s.projectiles > 0).length,
      samplesWithUndrawn: probe.shotSamples.filter(s => s.undrawn > 0).length,
      undrawnExamples: worst,
      vanishedShips: ships.filter(s => s.vanished),
      appearedNearby: ships.filter(s => s.firstDistance !== null
        && s.firstDistance < 3000),
      explosionLog: (probe.explosionLog || []).slice(0, 25),
      health: probe.healthLog
        ? [probe.healthLog[0], probe.healthLog[probe.healthLog.length - 1]]
        : null,
    };
  };
  return 'installed';
})()
`;

async function startPilot(page) {
    await waitFor(page, `document.querySelector('[data-menu-action]')`, {
        label: 'start menu', timeoutMs: 120_000,
    });
    await evaluate(page,
        `document.querySelector('[data-menu-action="New Pilot"]').click()`);
    await sleep(600);
    // The name dialog confirms with the button that is not Back/Cancel.
    console.log('name dialog:', await evaluate(page, `(() => {
        const input = document.querySelector('input[type="text"]');
        if (input) {
            input.value = 'Probe';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const buttons = [...document.querySelectorAll('button')]
            .map(b => (b.textContent || '').trim());
        const confirm = [...document.querySelectorAll('button')]
            .find(b => (b.textContent || '').trim() === 'Launch');
        if (confirm) confirm.click();
        return buttons;
    })()`));
    await waitFor(page,
        `document.querySelector('[data-menu-action="Enter Ship"]')`,
        { label: 'main menu after pilot creation', timeoutMs: 30_000 });
    console.log('after name:', await evaluate(page, `(() => {
        const actions = [...document.querySelectorAll('[data-menu-action]')]
            .map(b => ({ action: b.dataset.menuAction, disabled: b.disabled }));
        const enter = document.querySelector('[data-menu-action="Enter Ship"]');
        if (enter && !enter.disabled) enter.click();
        return actions;
    })()`));
    await waitFor(page, `window.system && window.app`, {
        label: 'game world', timeoutMs: 120_000,
    });
    await waitFor(page,
        `(() => { for (const [,e] of window.system.entities) {`
        + ` if (e.componentsByName.has('ShipControl')) return true; }`
        + ` return false; })()`,
        { label: 'player ship', timeoutMs: 120_000 });
}

async function main() {
    const chrome = await launchChrome({ headless });
    let page;
    try {
        page = await openPage(chrome.wsUrl, url);
        const logs = [];
        page.on('Runtime.consoleAPICalled', params => {
            logs.push(params.args
                .map(a => a.value ?? a.description).join(' '));
        });
        page.on('Runtime.exceptionThrown', params => {
            logs.push('EXCEPTION ' + JSON.stringify(
                params.exceptionDetails?.exception?.description
                ?? params.exceptionDetails?.text));
        });

        await startPilot(page);
        console.log('booted:', await evaluate(page, INSTRUMENT));

        console.log('frame hook:',
            await evaluate(page, `window.__bugProbe.attachFrameHook()`));
        console.log('state after entering:', await evaluate(page, `(() => {
            const buttons = [...document.querySelectorAll('button')]
                .map(b => (b.textContent || '').trim()).filter(Boolean);
            let spaceport = 0;
            let ships = 0;
            for (const [, e] of window.system.entities) {
                if (e.componentsByName.has('Spaceport')) spaceport++;
                if (e.componentsByName.has('Ship')) ships++;
            }
            return { buttons, spaceport, ships,
                resources: [...window.system.resources.entries()]
                    .map(([r]) => r.name).filter(n => /spaceport|landed/i.test(n)) };
        })()`));
        console.log('time before targeting:',
            await evaluate(page, `window.__bugProbe.time()`));
        if (provoke) {
            await keyDown(page, 'r');
            await sleep(120);
            await keyUp(page, 'r');
            await sleep(600);
            console.log('time after targeting:',
                await evaluate(page, `window.__bugProbe.time()`));
        }

        for (let elapsed = 0; elapsed < seconds * 1000; elapsed += 250) {
            if (elapsed % 4000 === 0) {
                if (provoke) {
                    await keyDown(page, 'r');
                    await sleep(60);
                    await keyUp(page, 'r');
                }
                await keyDown(page, ' ');
            }
            if (elapsed % 4000 === 2000) {
                await keyUp(page, ' ');
            }
            const turn = provoke ? await evaluate(page,
                `window.__bugProbe.steerToTarget()`) : 'none';
            if (turn === 'left' || turn === 'right') {
                const key = turn === 'left' ? 'ArrowLeft' : 'ArrowRight';
                await keyDown(page, key);
                await sleep(120);
                await keyUp(page, key);
            }
            await evaluate(page, `window.__bugProbe.sample()`);
            await sleep(150);
        }
        await keyUp(page, ' ');

        console.log('time at end:',
            await evaluate(page, `window.__bugProbe.time()`));
        // Distance attenuation, end to end: a sound placed far from the
        // player must not even be fetched, while a nearby one must be.
        console.log('SOUND ' + JSON.stringify(await evaluate(page, `(() => {
            const sys = window.system;
            let event;
            for (const system of sys.systems) {
                for (const candidate of system.events) {
                    if (candidate.name === 'WeaponFire') event = candidate;
                }
            }
            if (!event) return { error: 'no SoundEvent' };
            let me;
            for (const [uuid, entity] of sys.entities) {
                if (entity.componentsByName.has('ShipControl')) me = entity;
            }
            const at = me.componentsByName.get('MovementState').position;
            const before = window.__bugProbe.sounds.length;
            sys.emitNow(event, { id: 'nova:301',
                position: { x: at.x + 9000, y: at.y } });
            const afterFar = window.__bugProbe.sounds.length;
            sys.emitNow(event, { id: 'nova:301',
                position: { x: at.x + 50, y: at.y } });
            const afterNear = window.__bugProbe.sounds.length;
            return {
                requestedForFarSound: afterFar - before,
                requestedForNearSound: afterNear - afterFar,
            };
        })()`)));
        console.log('SHOTS ' + JSON.stringify(
            await evaluate(page, `window.__bugProbe.shotReport()`)));
        const summary = await evaluate(page, `window.__bugProbe.summary()`);
        console.log(JSON.stringify(summary, null, 2));
        const interesting = logs.filter(line =>
            /EXCEPTION|Unable|error|Error|warn/i.test(line));
        console.log('notable logs:', interesting.slice(-15));
    } finally {
        try { page?.close(); } catch { /* ignore */ }
        chrome.close();
    }
}

await main();
