/**
 * Where do freshly spawned ships actually appear?
 *
 * The player reported traffic arriving "super far away from the planets", and
 * the arrival radius was indeed larger than the entire inhabited coordinate
 * range. This measures the real distances in a live world rather than trusting
 * the constant, because the placement also depends on planet data being warm.
 *
 * Usage: node scripts/probe_spawn_distance.mjs [--url http://localhost:8200]
 */
import {
    evaluate,
    keyDown,
    keyUp,
    launchChrome,
    openPage,
    sleep,
    waitFor,
} from './cdp.mjs';

const url = process.argv.includes('--url')
    ? process.argv[process.argv.indexOf('--url') + 1]
    : 'http://localhost:8200';

const MEASURE = String.raw`
(() => {
  const ships = [];
  const planets = [];
  let player;
  for (const [uuid, entity] of window.system.entities) {
    const movement = entity.componentsByName.get('MovementState');
    if (!movement) { continue; }
    const at = { x: movement.position.x, y: movement.position.y };
    if (entity.componentsByName.has('Planet')) {
      planets.push({ uuid, ...at });
      continue;
    }
    if (entity.componentsByName.has('ShipControl')) {
      player = { uuid, ...at };
      continue;
    }
    if (entity.componentsByName.has('ShipData')) {
      ships.push({ uuid, name: entity.name, ...at });
    }
  }
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const nearestPlanet = ship => planets.length === 0 ? undefined
    : Math.min(...planets.map(planet => distance(ship, planet)));
  return {
    planetCount: planets.length,
    player,
    ships: ships.map(ship => ({
      name: ship.name,
      fromPlayer: player ? Math.round(distance(ship, player)) : undefined,
      fromNearestPlanet: Math.round(nearestPlanet(ship) ?? -1),
    })),
  };
})`;

const chrome = await launchChrome({ port: 9335, headless: true });
try {
    const page = await openPage(chrome.wsUrl, url);
    await waitFor(page, `document.querySelector('[data-menu-action]')`,
        { label: 'start menu', timeoutMs: 120_000 });
    await evaluate(page,
        `document.querySelector('[data-menu-action="New Pilot"]').click()`);
    await sleep(500);
    await evaluate(page, `(() => {
        const input = document.querySelector('input[type="text"]');
        if (input) {
            input.value = 'Probe';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const launch = [...document.querySelectorAll('button')]
            .find(b => (b.textContent || '').trim() === 'Launch');
        if (launch) { launch.click(); }
    })()`);
    await waitFor(page, `(() => {
        for (const [, e] of (window.system?.entities ?? [])) {
            if (e.componentsByName.has('ShipControl')) { return true; }
        }
        return false;
    })()`, { label: 'player ship', timeoutMs: 120_000 });
    // Give the server time to fill the system's traffic budget.
    await sleep(8000);

    const measured = await evaluate(page, `(${MEASURE})()`);
    console.log(JSON.stringify(measured, null, 1));

    const distances = measured.ships
        .map(ship => ship.fromNearestPlanet)
        .filter(distance => distance >= 0);
    if (distances.length === 0) {
        console.error('No other ships were visible, so nothing was measured.');
        process.exit(1);
    }
    const worst = Math.max(...distances);
    console.log(`\n${distances.length} ships, farthest is ${worst} `
        + `units from the nearest planet.`);
    // The player's own jump arrival radius is 1400, and every inhabited
    // stellar sits within about 2200 of the system origin. Traffic that
    // appears further out than the two combined is not in the same
    // neighbourhood as the planets, which is what the player saw.
    if (worst > 1400 + 2200) {
        console.error('FAIL: traffic is spawning outside the inhabited area.');
        process.exit(1);
    }
    console.log('OK: traffic appears within the inhabited area.');
} finally {
    chrome.close();
}
