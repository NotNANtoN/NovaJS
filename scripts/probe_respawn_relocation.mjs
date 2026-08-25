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
    port: Number(process.env.NOVA_PROBE_PORT ?? 9353),
});
const page = await openPage(chrome.wsUrl, 'http://localhost:8200');

async function tap(key) {
    await keyDown(page, key);
    await sleep(40);
    await evaluate(page, 'window.system.step()');
    await keyUp(page, key);
    await sleep(40);
    await evaluate(page, 'window.system.step()');
}

async function snapshot() {
    return evaluate(page, `(() => {
        window.system.step();
        const player = [...window.system.entities.values()].find(entity =>
            [...entity.components.keys()].some(
                component => component.name === 'ShipControl'));
        if (!player) {
            return { system: window.system.name };
        }
        const value = name => {
            const key = [...player.components.keys()].find(
                component => component.name === name);
            return key ? player.components.get(key) : undefined;
        };
        const movement = value('MovementState');
        return {
            system: window.system.name,
            phase: value('JumpStateComponent')?.phase,
            dead: Boolean(value('PlayerDeathComponent')),
            currentSystem: value('PlayerStateComponent')?.currentSystem,
            route: [...(value('JumpRouteComponent')?.route ?? [])],
            position: movement
                ? [movement.position.x, movement.position.y]
                : undefined,
            speed: movement?.velocity.length,
            remote: Boolean(value('RemoteMovementPresentation')),
            jumpSounds: [...(window.__respawnProbeJumpSounds ?? [])],
        };
    })()`);
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
        .some(entity => [...entity.components.keys()]
        .some(component => component.name === 'ShipControl'))`, {
        timeoutMs: 60_000,
        label: 'player ship',
    });
    // The player entity is installed just before startGame resumes the ticker.
    await sleep(500);

    await evaluate(page, `(() => {
        window.__respawnProbeJumpSounds = [];
        for (const system of window.system.systems) {
            const soundEvent = [...system.events].find(
                event => event.name === 'SoundEvent');
            if (!soundEvent) {
                continue;
            }
            const original = system.step.bind(system);
            system.step = (...args) => {
                if ([128, 130, 302].includes(Number(
                    String(args[0]?.id ?? '').split(':').at(-1)))) {
                    window.__respawnProbeJumpSounds.push(args[0].id);
                }
                return original(...args);
            };
        }
        const player = [...window.system.entities.values()].find(entity =>
            [...entity.components.keys()].some(
                component => component.name === 'ShipControl'));
        const routeKey = [...player.components.keys()].find(
            component => component.name === 'JumpRouteComponent');
        player.components.get(routeKey).route = ['nova:162', 'nova:531'];
    })()`);

    await tap('j');
    const normalPhases = [];
    let previous;
    let jumped;
    let lastNormal;
    for (let elapsed = 0; elapsed < 8_000; elapsed += 25) {
        const state = await snapshot();
        lastNormal = state;
        if (state.phase !== previous) {
            normalPhases.push(state.phase ?? 'ready');
            previous = state.phase;
        }
        if (state.system === 'nova:162' && !state.phase) {
            jumped = state;
            break;
        }
        await sleep(25);
    }
    assert(jumped, `normal hyperjump did not reach nova:162: ${
        JSON.stringify({ normalPhases, lastNormal })}`);
    for (const phase of ['spooling', 'departing', 'arriving']) {
        assert(normalPhases.includes(phase),
            `normal jump missed ${phase}: ${normalPhases}`);
    }

    await evaluate(page, `(() => {
        window.__respawnProbeJumpSounds = [];
        for (const system of window.system.systems) {
            const soundEvent = [...system.events].find(
                event => event.name === 'SoundEvent');
            if (!soundEvent) {
                continue;
            }
            const original = system.step.bind(system);
            system.step = (...args) => {
                if ([128, 130, 302].includes(Number(
                    String(args[0]?.id ?? '').split(':').at(-1)))) {
                    window.__respawnProbeJumpSounds.push(args[0].id);
                }
                return original(...args);
            };
        }
        const playerEntry = [...window.system.entities].find(([, entity]) =>
            [...entity.components.keys()].some(
                component => component.name === 'ShipControl'));
        const deathSystem = window.system.systems.find(
            system => system.name === 'PlayerDeathSystem');
        const deathEvent = [...deathSystem.events].find(
            event => event.name === 'DeathEvent');
        const timeKey = [...window.system.resources.keys()].find(
            resource => resource.name === 'time');
        window.system.emitNow(
            deathEvent,
            window.system.resources.get(timeKey),
            [playerEntry[0]],
        );
    })()`);

    const respawnPhases = [];
    let respawned;
    for (let elapsed = 0; elapsed < 10_000; elapsed += 25) {
        const state = await snapshot();
        if (state.phase) {
            respawnPhases.push(state.phase);
        }
        if (state.system === 'nova:130'
            && state.currentSystem === 'nova:130'
            && !state.dead) {
            respawned = state;
            break;
        }
        await sleep(25);
    }
    assert(respawned, 'death did not relocate player back to Sol');
    assert.deepEqual(respawnPhases, []);
    assert.deepEqual(respawned.route, ['nova:531']);
    assert.deepEqual(respawned.jumpSounds, []);
    assert.equal(respawned.speed, 0);
    assert.equal(respawned.remote, false);

    console.log(JSON.stringify({
        normalJump: {
            phases: normalPhases,
            destination: jumped.system,
            route: jumped.route,
        },
        respawn: {
            phases: respawnPhases,
            destination: respawned.system,
            route: respawned.route,
            jumpSounds: respawned.jumpSounds,
            position: respawned.position,
            speed: respawned.speed,
            remotePresentation: respawned.remote,
        },
    }, null, 2));
} finally {
    page.close();
    chrome.close();
}
