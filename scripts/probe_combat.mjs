/**
 * Live browser probe for the single-shot lifecycle and flight continuity.
 *
 * It instruments the running Pixi ticker so every rendered frame is sampled,
 * which is what distinguishes a real visual regression (a projectile that
 * exists and collides but is never drawn) from a simulation-only check.
 *
 * Usage: node scripts/probe_combat.mjs [--url http://localhost:8200] [--headful]
 */
import { launchChrome, openPage, evaluate, waitFor, keyDown, keyUp, sleep } from './cdp.mjs';

const url = process.argv.includes('--url')
    ? process.argv[process.argv.indexOf('--url') + 1]
    : 'http://localhost:8200';
const headless = !process.argv.includes('--headful');

const INSTRUMENT = String.raw`
(() => {
  if (window.__novaProbe) { return 'already'; }
  const probe = {
    frames: [],
    sounds: [],
    shots: [],
    damage: [],
    keys: [],
    maxFrames: 20000,
  };
  window.__novaProbe = probe;

  const origAddEventListener = window.addEventListener.bind(window);
  for (const type of ['keydown', 'keyup']) {
    origAddEventListener(type, e => {
      probe.keys.push({ t: performance.now(), type, code: e.code });
    }, true);
  }

  probe.reset = () => {
    probe.frames.length = 0;
    probe.sounds.length = 0;
    probe.shots.length = 0;
    probe.damage.length = 0;
    probe.keys.length = 0;
  };

  const findPlayer = () => {
    const sys = window.system;
    if (!sys) return undefined;
    for (const [uuid, entity] of sys.entities) {
      if (entity.componentsByName.has('ShipControl')) {
        return [uuid, entity];
      }
    }
    return undefined;
  };
  probe.findPlayer = findPlayer;

  const sample = () => {
    const sys = window.system;
    if (!sys) return;
    const t = performance.now();
    const player = findPlayer();
    const byName = player && player[1].componentsByName;
    const movement = byName && byName.get('MovementState');
    const weapons = byName && byName.get('WeaponsStateComponent');
    const weaponsLocal = byName && byName.get('WeaponsComponent');
    const controls = sys.resources && [...sys.resources.entries()]
      .filter(([r]) => r.name === 'ControlState')[0];

    const projectiles = [];
    for (const [uuid, entity] of sys.entities) {
      const names = entity.componentsByName;
      if (!names.has('Projectile')) continue;
      const m = names.get('MovementState');
      const graphic = names.get('AnimationGraphic');
      const loaded = names.get('AnimationGraphicLoaded');
      let container;
      if (graphic && graphic.container) {
        container = {
          x: graphic.container.position.x,
          y: graphic.container.position.y,
          visible: graphic.container.visible,
          worldVisible: graphic.container.worldVisible,
          destroyed: Boolean(graphic.container.destroyed),
          hasParent: Boolean(graphic.container.parent),
          children: graphic.container.children.length,
          alpha: graphic.container.worldAlpha,
          disposed: Boolean(graphic.managed && graphic.managed.disposed),
        };
      }
      const owner = names.get('Owner') && names.get('Owner').owner;
      const source = names.get('Source');
      projectiles.push({
        uuid,
        name: entity.name,
        mine: Boolean(player && (owner === player[0] || source === player[0])),
        hasGraphic: Boolean(graphic),
        hasLoaded: Boolean(loaded),
        container,
        pos: m ? [m.position.x, m.position.y] : null,
        vel: m ? [m.velocity.x, m.velocity.y] : null,
        source: names.get('Source'),
        owner: names.get('Owner') && names.get('Owner').owner,
        createTime: names.get('CreateTime'),
      });
    }

    let weaponsSummary;
    if (weapons) {
      weaponsSummary = [];
      for (const [id, s] of weapons) {
        const local = weaponsLocal && weaponsLocal.get
          ? weaponsLocal.get(id) : undefined;
        weaponsSummary.push({
          id, firing: s.firing, count: s.count,
          shotsOwed: local && local.shotsOwed,
          burstCount: local && local.burstCount,
        });
      }
    }

    const timeRes = [...sys.resources.entries()]
      .filter(([r]) => r.name === 'time')[0];

    probe.frames.push({
      t,
      playerUuid: player && player[0],
      pos: movement ? [movement.position.x, movement.position.y] : null,
      vel: movement ? [movement.velocity.x, movement.velocity.y] : null,
      rot: movement ? movement.rotation.angle : null,
      accel: movement ? movement.accelerating : null,
      turning: movement ? movement.turning : null,
      remote: Boolean(byName && byName.has('RemoteMovementPresentation')),
      controls: controls ? [...controls[1].keys()] : null,
      weapons: weaponsSummary,
      simTime: timeRes ? timeRes[1].time : null,
      simDelta: timeRes ? timeRes[1].delta_ms : null,
      projectiles,
    });
    if (probe.frames.length > probe.maxFrames) probe.frames.shift();
  };

  window.app.ticker.add(sample);

  // Rendered-frame sampling alone cannot prove a shot was never created: a
  // main-thread stall can hide a short-lived projectile between two ticks.
  // Census runs on every simulation step, so "no projectile" means the
  // entity truly never existed.
  probe.census = new Map();
  probe.resetCensus = () => probe.census.clear();
  const censusStep = () => {
    const sys = window.system;
    if (!sys) return;
    const t = performance.now();
    const player = findPlayer();
    for (const [uuid, entity] of sys.entities) {
      const names = entity.componentsByName;
      if (!names.has('Projectile')) continue;
      const owner = names.get('Owner') && names.get('Owner').owner;
      const source = names.get('Source');
      if (!player || (owner !== player[0] && source !== player[0])) continue;
      if (!probe.census.has(uuid)) {
        probe.census.set(uuid, { firstT: t, lastT: t, name: entity.name });
      } else {
        probe.census.get(uuid).lastT = t;
      }
    }
  };

  probe.attachEvents = () => {
    const sys = window.system;
    if (!sys || sys.__probeAttached) return false;
    sys.__probeAttached = true;
    const origStep = sys.step.bind(sys);
    sys.step = (...args) => {
      const result = origStep(...args);
      censusStep();
      return result;
    };
    for (const [event, subject] of sys.events) {
      if (event.name === 'SoundEvent') {
        subject.subscribe(v => probe.sounds.push({ t: performance.now(), id: v && v.id }));
      }
      if (event.name === 'DamagedEvent') {
        subject.subscribe(v => probe.damage.push({
          t: performance.now(), damager: v && v.damager,
        }));
      }
    }
    return true;
  };
  return 'installed';
})()
`;

async function main() {
    const chrome = await launchChrome({ headless });
    let page;
    try {
        page = await openPage(chrome.wsUrl, url);
        const logs = [];
        page.on('Runtime.consoleAPICalled', params => {
            logs.push(params.args.map(a => a.value ?? a.description).join(' '));
        });
        page.on('Runtime.exceptionThrown', params => {
            logs.push('EXCEPTION ' + JSON.stringify(
                params.exceptionDetails?.exception?.description
                ?? params.exceptionDetails?.text));
        });

        await waitFor(page, `document.querySelector('[data-menu-action]')`, {
            label: 'start menu', timeoutMs: 120_000,
        });

        // New Pilot -> name entry -> confirm.
        await evaluate(page, `document.querySelector('[data-menu-action="New Pilot"]').click()`);
        await sleep(500);
        console.log(await evaluate(page, `(() => {
            const input = document.querySelector('input[type="text"]');
            if (input) { input.value = 'Probe'; input.dispatchEvent(new Event('input', {bubbles:true})); }
            const buttons = [...document.querySelectorAll('button')];
            const launch = buttons.find(b => (b.textContent || '').trim() === 'Launch');
            if (launch) launch.click();
            return { clicked: Boolean(launch), buttons: buttons.map(b => (b.textContent||'').trim()) };
        })()`));

        await waitFor(page, `window.system && window.app`, {
            label: 'game world', timeoutMs: 120_000,
        });
        await waitFor(page, `(() => { for (const [,e] of window.system.entities) { if (e.componentsByName.has('ShipControl')) return true; } return false; })()`, {
            label: 'player ship', timeoutMs: 120_000,
        });

        console.log('Game booted. Installing instrumentation.');
        console.log(await evaluate(page, INSTRUMENT));
        await evaluate(page, `window.__novaProbe.attachEvents()`);
        // Weapon entries and sprite sheets load asynchronously on first use.
        // Warm them up so the measurement is of steady-state gameplay.
        await keyDown(page, ' ');
        await sleep(1200);
        await keyUp(page, ' ');
        await sleep(1500);

        const report = { url, scenarios: {} };

        // --- Scenario 1: five single taps while stationary ---
        await evaluate(page, `window.__novaProbe.reset()`);
        await evaluate(page, `window.__novaProbe.resetCensus()`);
        await sleep(300);
        for (let i = 0; i < 5; i++) {
            await keyDown(page, ' ');
            await sleep(60);
            await keyUp(page, ' ');
            await sleep(900);
        }
        await sleep(400);
        report.scenarios.singleTaps = await evaluate(page, `(() => {
            const p = window.__novaProbe;
            const seen = new Map();
            for (const f of p.frames) {
                for (const proj of f.projectiles) {
                    if (!proj.mine) continue;
                    let rec = seen.get(proj.uuid);
                    if (!rec) {
                        rec = { uuid: proj.uuid, name: proj.name, firstT: f.t,
                                frames: 0, drawnFrames: 0, hasGraphicFrames: 0,
                                disposedFrames: 0, positions: [], containerPos: [] };
                        seen.set(proj.uuid, rec);
                    }
                    rec.frames++;
                    rec.lastT = f.t;
                    if (proj.hasGraphic) rec.hasGraphicFrames++;
                    if (proj.container && proj.container.worldVisible
                        && !proj.container.destroyed && proj.container.hasParent
                        && proj.container.children > 0) rec.drawnFrames++;
                    if (proj.container && proj.container.disposed) rec.disposedFrames++;
                    if (rec.positions.length < 40 && proj.pos) rec.positions.push(proj.pos);
                    if (rec.containerPos.length < 40 && proj.container)
                        rec.containerPos.push([proj.container.x, proj.container.y]);
                }
            }
            const shots = [...seen.values()];
            const keydowns = p.keys.filter(k => k.type === 'keydown' && k.code === 'Space');
            // Simulation-step census, immune to rendered-frame stalls.
            const spawns = [...p.census.entries()]
                .map(([uuid, v]) => ({ uuid, firstT: v.firstT }))
                .sort((a, b) => a.firstT - b.firstT);
            // Greedy one-to-one matching so two taps cannot claim one shot.
            const usedSpawn = new Set();
            const latencies = keydowns.map(k => {
                const spawn = spawns.find(
                    s => s.firstT >= k.t && !usedSpawn.has(s.uuid));
                if (!spawn) return null;
                usedSpawn.add(spawn.uuid);
                return Math.round(spawn.firstT - k.t);
            });
            return {
                taps: keydowns.length,
                tapLatenciesMs: latencies,
                missedTaps: latencies.filter(l => l === null).length,
                spawnedProjectiles: spawns.length,
                keyEvents: p.keys.length,
                soundCount: p.sounds.length,
                projectileCount: shots.length,
                visibleProjectiles: shots.filter(s => s.drawnFrames > 0).length,
                invisibleButAlive: shots.filter(s => s.drawnFrames === 0).length,
                neverDrawnDespiteLongLife:
                    shots.filter(s => s.drawnFrames === 0 && s.frames > 2).length,
                shots: shots.map(s => ({
                    uuid: s.uuid, name: s.name, frames: s.frames,
                    drawnFrames: s.drawnFrames, hasGraphicFrames: s.hasGraphicFrames,
                    disposedFrames: s.disposedFrames,
                    lifeMs: Math.round(s.lastT - s.firstT),
                    firstPos: s.positions[0], lastPos: s.positions[s.positions.length-1],
                })),
                sounds: p.sounds,
            };
        })()`);

        // --- Scenario 2: held fire ---
        await evaluate(page, `window.__novaProbe.reset()`);
        await keyDown(page, ' ');
        await sleep(3000);
        await keyUp(page, ' ');
        await sleep(1200);
        report.scenarios.heldFire = await evaluate(page, `(() => {
            const p = window.__novaProbe;
            const seen = new Map();
            for (const f of p.frames) {
                for (const proj of f.projectiles) {
                    if (!proj.mine) continue;
                    let rec = seen.get(proj.uuid);
                    if (!rec) { rec = { drawn: 0, frames: 0, firstT: f.t }; seen.set(proj.uuid, rec); }
                    rec.frames++;
                    if (proj.container && proj.container.worldVisible && !proj.container.destroyed
                        && proj.container.hasParent && proj.container.children > 0) rec.drawn++;
                }
            }
            const shots = [...seen.values()].sort((a,b)=>a.firstT-b.firstT);
            const gaps = [];
            for (let i = 1; i < shots.length; i++) gaps.push(Math.round(shots[i].firstT - shots[i-1].firstT));
            const firingFrames = p.frames.filter(f => f.weapons && f.weapons.some(w => w.firing)).length;
            return {
                total: shots.length,
                visible: shots.filter(s => s.drawn > 0).length,
                invisible: shots.filter(s => s.drawn === 0).length,
                neverDrawnDespiteLongLife:
                    shots.filter(s => s.drawn === 0 && s.frames > 2).length,
                gaps,
                soundCount: p.sounds.length,
                firingFrames,
                totalFrames: p.frames.length,
                lastWeapons: p.frames[p.frames.length-1] && p.frames[p.frames.length-1].weapons,
            };
        })()`);

        // --- Scenario 3: flight continuity ---
        await evaluate(page, `window.__novaProbe.reset()`);
        const flight = async (keys, ms) => {
            for (const k of keys) await keyDown(page, k);
            await sleep(ms);
            for (const k of keys) await keyUp(page, k);
        };
        await flight(['ArrowUp'], 1200);
        await flight(['ArrowUp', 'ArrowLeft'], 1200);
        await flight(['ArrowUp'], 1200);
        await flight(['ArrowUp', 'ArrowRight'], 1200);
        await sleep(1500);
        report.scenarios.flight = await evaluate(page, `(() => {
            const p = window.__novaProbe;
            const frames = p.frames.filter(f => f.pos);
            const deltas = [], frameGaps = [];
            for (let i = 1; i < frames.length; i++) {
                const a = frames[i-1], b = frames[i];
                const dx = b.pos[0]-a.pos[0], dy = b.pos[1]-a.pos[1];
                const dt = b.t - a.t;
                deltas.push({ dt: +dt.toFixed(2), d: +Math.hypot(dx,dy).toFixed(3),
                              speed: dt > 0 ? +(Math.hypot(dx,dy)/dt*1000).toFixed(1) : 0,
                              simDelta: b.simDelta });
                frameGaps.push(dt);
            }
            const speeds = deltas.map(d => d.speed);
            const jumps = deltas.filter((d,i) => i > 2 && d.d > 6 * (deltas[i-1].d || 0.001) && d.d > 12);
            frameGaps.sort((a,b)=>a-b);
            return {
                frames: frames.length,
                remoteOnPlayer: frames.filter(f => f.remote).length,
                medianFrameGap: +frameGaps[Math.floor(frameGaps.length/2)].toFixed(2),
                p95FrameGap: +frameGaps[Math.floor(frameGaps.length*0.95)].toFixed(2),
                maxFrameGap: +frameGaps[frameGaps.length-1].toFixed(2),
                framesOver50ms: frameGaps.filter(g => g > 50).length,
                framesOver100ms: frameGaps.filter(g => g > 100).length,
                maxSpeed: Math.max(...speeds),
                positionJumps: jumps.length,
                jumpSamples: jumps.slice(0, 10),
                zeroMoveFrames: deltas.filter(d => d.d === 0).length,
                simDeltaZeroFrames: deltas.filter(d => d.simDelta === 0).length,
            };
        })()`);

        report.consoleErrors = logs.filter(l => /error|Error|EXCEPTION|warn/i.test(l)).slice(0, 40);
        console.log(JSON.stringify(report, null, 2));
    } finally {
        try { page?.close(); } catch { /* ignore */ }
        chrome.close();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
