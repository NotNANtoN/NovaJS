/**
 * Sequential live probe for local explosion presentation cadence.
 *
 * Creates Raven rockets through the real WeaponEntry, expires one beside the
 * player and one in the camera background, then samples Pixi and TimeResource
 * once per rendered frame.
 */
import {
    evaluate,
    launchChrome,
    openPage,
    sleep,
    waitFor,
} from './cdp.mjs';

const url = process.argv.includes('--url')
    ? process.argv[process.argv.indexOf('--url') + 1]
    : 'http://localhost:8200';

async function startPilot(page) {
    await waitFor(page, `document.querySelector('[data-menu-action]')`, {
        timeoutMs: 120_000,
        label: 'start menu',
    });
    await evaluate(page,
        `document.querySelector('[data-menu-action="New Pilot"]').click()`);
    await sleep(400);
    await evaluate(page, `(() => {
        const launch = [...document.querySelectorAll('button')]
            .find(button => (button.textContent || '').trim() === 'Launch');
        launch?.click();
    })()`);
    await waitFor(page, `window.system && (() => {
        for (const [, entity] of window.system.entities) {
            if (entity.componentsByName.has('ShipControl')) return true;
        }
        return false;
    })()`, {
        timeoutMs: 120_000,
        label: 'player ship',
    });
}

const INSTALL = String.raw`
(() => {
  const probe = { samples: [], scenario: '', created: [], observed: new Map() };
  const textureIds = new WeakMap();
  let nextTextureId = 1;
  window.__explosionProbe = probe;
  const resource = name => [...window.system.resources]
    .find(([key]) => key.name === name)?.[1];
  const player = () => {
    for (const [uuid, entity] of window.system.entities) {
      if (entity.componentsByName.has('ShipControl')) return [uuid, entity];
    }
  };
  probe.sample = () => {
    const time = resource('time');
    const now = performance.now();
    const activeExplosions = new Set();
    for (const [uuid, entity] of window.system.entities) {
      if (!entity.componentsByName.has('ExplosionData')) continue;
      activeExplosions.add(uuid);
      const movement = entity.componentsByName.get('MovementState');
      const graphic = entity.componentsByName.get('AnimationGraphic');
      const sprite = graphic?.sprites?.get('baseImage');
      const texture = sprite?.pixiSprite?.texture;
      if (texture && !textureIds.has(texture)) {
        textureIds.set(texture, nextTextureId++);
      }
      if (graphic && !probe.observed.has(uuid)) {
        probe.observed.set(uuid, {
          scenario: probe.scenario,
          graphic,
          movement,
          deletionSampled: false,
        });
      }
      const observed = probe.observed.get(uuid);
      probe.samples.push({
        scenario: observed?.scenario ?? probe.scenario,
        uuid,
        t: now,
        simTime: time?.time,
        simDelta: time?.delta_ms,
        frame: sprite?.frame,
        progress: graphic?.progress,
        x: movement?.position?.x,
        y: movement?.position?.y,
        visible: Boolean(graphic?.container?.worldVisible),
        parent: Boolean(graphic?.container?.parent),
        parentIndex: graphic?.container?.parent
          ?.getChildIndex(graphic.container),
        zIndex: graphic?.container?.zIndex,
        textureId: texture ? textureIds.get(texture) : undefined,
        replicated: entity.componentsByName.has('MultiplayerData'),
        disposed: Boolean(graphic?.managed?.disposed),
        entityDeleted: false,
      });
    }
    for (const [uuid, observed] of probe.observed) {
      if (activeExplosions.has(uuid) || observed.deletionSampled) continue;
      observed.deletionSampled = true;
      probe.samples.push({
        scenario: observed.scenario,
        uuid,
        t: now,
        simTime: time?.time,
        simDelta: time?.delta_ms,
        x: observed.movement?.position?.x,
        y: observed.movement?.position?.y,
        visible: Boolean(observed.graphic.container?.worldVisible),
        parent: Boolean(observed.graphic.container?.parent),
        replicated: false,
        disposed: Boolean(observed.graphic.managed?.disposed),
        entityDeleted: true,
      });
    }
  };
  window.app.ticker.add(probe.sample);
  probe.explode = async (scenario, offsetX, offsetY) => {
    probe.scenario = scenario;
    const weaponEntries = resource('WeaponEntries');
    const entry = await weaponEntries.get('nova:138');
    const [playerUuid, playerEntity] = player();
    const movement = playerEntity.componentsByName.get('MovementState');
    const before = new Set(window.system.entities.keys());
    entry.fire(
      movement.position.add({ x: offsetX, y: offsetY }),
      movement.rotation,
      playerUuid,
      undefined,
      playerUuid,
      movement.velocity,
    );
    let created = [...window.system.entities]
      .find(([uuid, entity]) => !before.has(uuid)
        && entity.componentsByName.has('Projectile'));
    if (!created) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      created = [...window.system.entities]
        .find(([uuid, entity]) => !before.has(uuid)
          && entity.componentsByName.has('Projectile'));
    }
    if (!created) throw new Error('Raven rocket was not created');
    const uuid = created[0];
    await new Promise(resolve => requestAnimationFrame(
      () => requestAnimationFrame(resolve)));
    const entity = window.system.entities.get(uuid);
    const createComponent = entity && [...entity.components.keys()]
      .find(component => component.name === 'ProjectileFireTime');
    if (!entity) throw new Error('Rocket disappeared before expiration');
    if (!createComponent) throw new Error('Rocket has no creation timestamp');
    const time = resource('time');
    entity.components.set(createComponent, time.time - 5000);
    probe.created.push({ scenario, uuid });
    return uuid;
  };
  return true;
})()
`;

function summarize(samples, scenario) {
    const scenarioRows = samples.filter(sample => sample.scenario === scenario);
    const rows = scenarioRows.filter(sample => sample.frame !== undefined);
    const byUuid = new Map();
    for (const row of rows) {
        const values = byUuid.get(row.uuid) ?? [];
        values.push(row);
        byUuid.set(row.uuid, values);
    }
    const animation = [...byUuid.values()]
        .sort((a, b) => b.length - a.length)[0] ?? [];
    const lifecycle = animation.length
        ? scenarioRows.filter(row => row.uuid === animation[0].uuid)
        : [];
    const changes = animation.filter((row, index) =>
        index === 0 || row.frame !== animation[index - 1].frame);
    const intervals = changes.slice(1).map((row, index) =>
        row.t - changes[index].t);
    const renderedGaps = animation.slice(1).map((row, index) =>
        row.t - animation[index].t);
    return {
        renderedSamples: animation.length,
        uniqueFrames: [...new Set(animation.map(row => row.frame))],
        uniqueTextures: [...new Set(animation.map(row => row.textureId)
            .filter(textureId => textureId !== undefined))],
        durationMs: animation.length > 1
            ? animation.at(-1).t - animation[0].t
            : 0,
        frameChangeMedianMs: intervals.length
            ? intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)]
            : 0,
        renderGapMaxMs: renderedGaps.length
            ? Math.max(...renderedGaps)
            : 0,
        simDeltaMaxMs: animation.length
            ? Math.max(...animation.map(row => row.simDelta ?? 0))
            : 0,
        visibleSamples: animation.filter(row => row.visible && row.parent).length,
        replicatedSamples: animation.filter(row => row.replicated).length,
        parentIndices: [...new Set(animation.map(row => row.parentIndex)
            .filter(index => index !== undefined))],
        zIndices: [...new Set(animation.map(row => row.zIndex)
            .filter(index => index !== undefined))],
        disposedSamples: lifecycle.filter(row => row.disposed).length,
        deletedSamples: lifecycle.filter(row => row.entityDeleted).length,
        detachedAfterDeletion: lifecycle.some(row =>
            row.entityDeleted && !row.parent && row.disposed),
        position: animation.length
            ? [animation[0].x, animation[0].y]
            : undefined,
    };
}

async function main() {
    const chrome = await launchChrome({ headless: true });
    let page;
    try {
        page = await openPage(chrome.wsUrl, url);
        await startPilot(page);
        await evaluate(page, INSTALL);
        await sleep(1000);

        // First use includes texture/network loading. Exclude it so both
        // measured scenarios represent steady-state presentation.
        await evaluate(page,
            `window.__explosionProbe.explode('warmup', 300, 150)`);
        await sleep(2500);
        await evaluate(page,
            `window.__explosionProbe.samples.length = 0`);
        await evaluate(page,
            `window.__explosionProbe.explode('near', 20, 0)`);
        await sleep(1200);
        await evaluate(page,
            `window.__explosionProbe.explode('background', 450, 250)`);
        await sleep(1200);

        const samples = await evaluate(page,
            `window.__explosionProbe.samples`);
        const report = {
            near: summarize(samples, 'near'),
            background: summarize(samples, 'background'),
        };
        console.log(JSON.stringify(report, null, 2));
        for (const [scenario, result] of Object.entries(report)) {
            if (result.uniqueFrames.length < 8
                || result.frameChangeMedianMs > 75
                || result.visibleSamples === 0
                || result.deletedSamples === 0
                || result.disposedSamples === 0
                || !result.detachedAfterDeletion) {
                throw new Error(`${scenario} explosion cadence failed`);
            }
        }
    } finally {
        try {
            page?.close();
        } catch {
            // Best effort.
        }
        chrome.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
