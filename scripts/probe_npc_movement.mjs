import assert from 'node:assert/strict';
import {
    evaluate,
    keyDown,
    keyUp,
    launchChrome,
    openPage,
    sleep,
    waitFor,
} from './cdp.mjs';

const chrome = await launchChrome({
    port: Number(process.env.NOVA_PROBE_PORT ?? 9351),
});
const page = await openPage(chrome.wsUrl, 'http://localhost:8200');

async function tap(key) {
    await keyDown(page, key);
    await sleep(50);
    await keyUp(page, key);
    await sleep(100);
}

try {
    await waitFor(page,
        "document.querySelector('[data-menu-action=\"New Pilot\"]')",
        { timeoutMs: 60_000, label: 'main menu' });
    await evaluate(page,
        "document.querySelector('[data-menu-action=\"New Pilot\"]').click()");
    await waitFor(page,
        "[...document.querySelectorAll('button')].some(button => "
        + "button.textContent === 'Launch')",
        { label: 'new pilot launch' });
    await evaluate(page,
        "[...document.querySelectorAll('button')].find(button => "
        + "button.textContent === 'Launch').click()");
    await waitFor(page, `window.system && [...window.system.entities.values()]
        .filter(entity => {
            const entries = [...entity.components.entries()];
            return entries.some(([component]) => component.name === 'Ship')
                && entries.some(([component, value]) =>
                    component.name === 'MultiplayerData'
                    && value.owner === 'server');
        }).length >= 3`, {
        timeoutMs: 60_000,
        label: 'three NPC ships',
    });
    await evaluate(page, `(() => {
        window.__npcProbeErrors = [];
        window.addEventListener('error', event =>
            window.__npcProbeErrors.push(event.error?.stack ?? event.message));
        window.addEventListener('unhandledrejection', event =>
            window.__npcProbeErrors.push(
                event.reason?.stack ?? String(event.reason)));
    })()`);

    const snapshot = () => evaluate(page, `(() => {
        const value = (entity, name) => {
            const component = [...entity.components.keys()].find(
                candidate => candidate.name === name);
            return component ? entity.components.get(component) : undefined;
        };
        const timeKey = [...window.system.resources.keys()].find(
            resource => resource.name === 'time');
        const time = window.system.resources.get(timeKey);
        const npcs = [...window.system.entities]
            .filter(([, entity]) => {
                const entries = [...entity.components.entries()];
                return entries.some(([component]) => component.name === 'Ship')
                    && entries.some(([component, value]) =>
                        component.name === 'MultiplayerData'
                        && value.owner === 'server');
            })
            .slice(0, 3)
            .map(([uuid, entity]) => {
                const movement = value(entity, 'MovementState');
                const remote = value(entity, 'RemoteMovementPresentation');
                return {
                    uuid,
                    position: [movement.position.x, movement.position.y],
                    velocity: [movement.velocity.x, movement.velocity.y],
                    accelerating: movement.accelerating,
                    turnTo: typeof movement.turnTo === 'string'
                        ? movement.turnTo
                        : movement.turnTo?.angle ?? movement.turnTo,
                    remoteSamples: remote?.snapshots?.length,
                    remoteLastSampleTime:
                        remote?.snapshots?.at(-1)?.mappedTime,
                };
            });
        return {
            frame: time.frame,
            time: time.time,
            npcs,
            errors: [...window.__npcProbeErrors],
        };
    })()`);

    const samples = [await snapshot()];
    for (let index = 0; index < 12; index++) {
        await sleep(250);
        samples.push(await snapshot());
    }

    // Exercise two UI/control transitions implicated by the playtest without
    // mutating any NPC movement or authority state.
    await tap('m');
    await sleep(500);
    await tap('Escape');
    await tap('l');
    for (let index = 0; index < 8; index++) {
        await sleep(250);
        samples.push(await snapshot());
    }

    const start = samples[0];
    const end = samples.at(-1);
    assert(end.frame > start.frame, 'browser world time stopped advancing');
    assert.deepEqual(end.errors, [], `runtime errors: ${end.errors.join('\\n')}`);
    const movement = start.npcs.map(npc => {
        const final = end.npcs.find(candidate => candidate.uuid === npc.uuid);
        const distance = final
            ? Math.hypot(
                final.position[0] - npc.position[0],
                final.position[1] - npc.position[1],
            )
            : undefined;
        return {
            uuid: npc.uuid,
            distance,
            start: npc.position,
            end: final?.position,
            finalVelocity: final?.velocity,
            remoteSamples: final?.remoteSamples,
        };
    });
    assert.equal(movement.filter(entry => (entry.distance ?? 0) > 1).length, 3,
        `all three NPCs did not move: ${JSON.stringify(movement)}`);

    console.log(JSON.stringify({
        frameAdvance: end.frame - start.frame,
        timeAdvanceMs: end.time - start.time,
        movement,
        sampledFrames: samples.length,
        errors: end.errors,
    }, null, 2));
} finally {
    page.close();
    chrome.close();
}
