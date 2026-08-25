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
    port: Number(process.env.NOVA_PROBE_PORT ?? 9344),
});
const page = await openPage(chrome.wsUrl, 'http://localhost:8200');

async function press(key) {
    await keyDown(page, key);
    await sleep(40);
    await evaluate(page, 'window.system.step()');
    await keyUp(page, key);
    await sleep(40);
    await evaluate(page, 'window.system.step()');
}

try {
    await waitFor(page,
        "document.querySelector('[data-menu-action=\"New Pilot\"]')", {
            timeoutMs: 60_000,
            label: 'new pilot action',
        });
    await evaluate(page,
        "document.querySelector('[data-menu-action=\"New Pilot\"]').click()");
    await waitFor(page,
        "[...document.querySelectorAll('button')].some(button => "
        + "button.textContent === 'Launch')", {
            label: 'new pilot launch',
        });
    await evaluate(page,
        "[...document.querySelectorAll('button')].find(button => "
        + "button.textContent === 'Launch').click()");
    await waitFor(page, `window.system && [...window.system.entities.values()]
        .some(entity => {
            const names = [...entity.components.keys()]
                .map(component => component.name);
            return names.includes('ShipControl')
                && names.includes('ShipData')
                && names.includes('AnimationGraphic');
        })`, {
        timeoutMs: 60_000,
        label: 'player ship',
    });

    const destruction = await evaluate(page, `(async () => {
        const component = (entity, name) => {
            const key = [...entity.components.keys()].find(
                candidate => candidate.name === name);
            return key ? entity.components.get(key) : undefined;
        };
        const resource = name => {
            const key = [...window.system.resources.keys()].find(
                candidate => candidate.name === name);
            return key ? window.system.resources.get(key) : undefined;
        };
        const playerEntry = [...window.system.entities].find(([, entity]) =>
            [...entity.components.keys()].some(
                candidate => candidate.name === 'ShipControl'));
        const deathSystem = window.system.systems.find(
            system => system.name === 'PlayerDeathSystem');
        const deathEvent = deathSystem
            ? [...deathSystem.events].find(
                event => event.name === 'DeathEvent')
            : undefined;
        if (!playerEntry || !deathEvent) {
            throw new Error('Missing player or DeathEvent');
        }
        const [uuid, player] = playerEntry;
        window.system.emitNow(deathEvent, resource('time'), [uuid]);
        window.system.step();

        const startedAt = performance.now();
        let explosionSeen = false;
        let explosionGoneAt;
        let overlayAt;
        let respawnAt;
        let messageAtState;
        let respawnAtState;
        let intactShipHidden = false;
        while (performance.now() - startedAt < 10_000) {
            const stage = resource('Stage');
            const explosions = [...window.system.entities.values()].filter(
                entity => [...entity.components.keys()].some(
                    candidate => candidate.name === 'ExplosionData'));
            if (explosions.length > 0) {
                explosionSeen = true;
            } else if (explosionSeen && explosionGoneAt === undefined) {
                explosionGoneAt = performance.now() - startedAt;
            }
            if (stage?.getChildByName('PlayerDeathOverlay')
                && overlayAt === undefined) {
                overlayAt = performance.now() - startedAt;
            }
            const death = component(player, 'PlayerDeathComponent');
            messageAtState ??= death?.messageAt;
            respawnAtState ??= death?.respawnAt;
            const graphic = component(player, 'AnimationGraphic');
            intactShipHidden ||= death !== undefined
                && graphic?.container.visible === false;
            if (explosionSeen && !death) {
                respawnAt = performance.now() - startedAt;
                break;
            }
            await new Promise(requestAnimationFrame);
        }
        return {
            explosionSeen,
            explosionGoneAt,
            overlayAt,
            respawnAt,
            messageAtState,
            respawnAtState,
            intactShipHidden,
        };
    })()`);
    assert(destruction.explosionSeen, 'final ship explosion never appeared');
    assert(destruction.intactShipHidden,
        'intact player sprite remained visible during destruction');
    assert(destruction.explosionGoneAt !== undefined,
        'final explosion did not complete');
    assert(destruction.overlayAt !== undefined,
        'destruction message did not appear');
    assert(destruction.overlayAt >= destruction.explosionGoneAt,
        `message preceded explosion completion: ${JSON.stringify(destruction)}`);
    assert(destruction.respawnAtState - destruction.messageAtState >= 2_500,
        `respawn message hold was too short: ${JSON.stringify(destruction)}`);

    await evaluate(page, `(() => {
        const player = [...window.system.entities.values()].find(entity =>
            [...entity.components.keys()].some(
                component => component.name === 'ShipControl'));
        const routeKey = [...player.components.keys()].find(
            component => component.name === 'JumpRouteComponent');
        player.components.get(routeKey).route = ['nova:162', 'nova:531'];
    })()`);
    const jumpInitialPosition = await evaluate(page, `(() => {
        const player = [...window.system.entities.values()].find(entity =>
            [...entity.components.keys()].some(
                component => component.name === 'ShipControl'));
        const movementKey = [...player.components.keys()].find(
            component => component.name === 'MovementState');
        const movement = player.components.get(movementKey);
        return [movement.position.x, movement.position.y];
    })()`);
    const jumpStartedAt = Date.now();
    await press('j');
    const jumpProbeStartedAt = performance.now();
    const phases = [];
    let previousPhase;
    let maxVelocity;
    let spoolStart = jumpInitialPosition;
    let spoolEnd;
    let departurePeakSpeed = 0;
    let arrivalStartSpeed;
    let arrivalStartPosition;
    let arrivalEndSpeed;
    let spoolFrames = 0;
    let maxDeltaSeconds = 0;
    let remotePresentationSeen = false;
    let jump;
    let lastSnapshot;
    while (performance.now() - jumpProbeStartedAt < 30_000) {
        // Poll from Node instead of awaiting in-page across world teardown.
        // Replacing the system world can strand a long Runtime.evaluate promise.
        const snapshot = await evaluate(page, `(() => {
            window.system.step();
            const player = [...window.system.entities.values()].find(entity =>
                [...entity.components.keys()].some(
                    component => component.name === 'ShipControl'));
            if (!player) {
                return {
                    system: window.system.name,
                    plugins: [...window.system.plugins].map(
                        plugin => plugin.name),
                    entityCount: window.system.entities.size,
                    rootEntities: [...window.world.entities.keys()],
                };
            }
            const stateKey = [...player.components.keys()].find(
                component => component.name === 'JumpStateComponent');
            const movementKey = [...player.components.keys()].find(
                component => component.name === 'MovementState');
            const physicsKey = [...player.components.keys()].find(
                component => component.name === 'MovementPhysics');
            const routeKey = [...player.components.keys()].find(
                component => component.name === 'JumpRouteComponent');
            const timeKey = [...window.system.resources.keys()].find(
                resource => resource.name === 'time');
            const state = stateKey ? player.components.get(stateKey) : undefined;
            const movement = player.components.get(movementKey);
            const physics = player.components.get(physicsKey);
            const time = window.system.resources.get(timeKey);
            return {
                system: window.system.name,
                phase: state?.phase,
                maxVelocity: physics.maxVelocity,
                speed: movement.velocity.length,
                position: [movement.position.x, movement.position.y],
                velocity: [movement.velocity.x, movement.velocity.y],
                route: [...player.components.get(routeKey).route],
                deltaSeconds: time.delta_s,
                hasRemotePresentation: [...player.components.keys()].some(
                    component =>
                        component.name === 'RemoteMovementPresentation'),
            };
        })()`);
        lastSnapshot = snapshot;
        maxVelocity ??= snapshot.maxVelocity;
        maxDeltaSeconds = Math.max(
            maxDeltaSeconds, snapshot.deltaSeconds ?? 0);
        remotePresentationSeen ||= snapshot.hasRemotePresentation ?? false;
        if (snapshot.phase === 'spooling') {
            spoolFrames++;
            spoolEnd = snapshot.position;
        } else if (snapshot.phase === 'departing') {
            spoolEnd = snapshot.position;
            departurePeakSpeed = Math.max(
                departurePeakSpeed, snapshot.speed);
        } else if (snapshot.phase === 'arriving') {
            arrivalStartSpeed ??= snapshot.speed;
            arrivalStartPosition ??= snapshot.position;
            arrivalEndSpeed = snapshot.speed;
        }
        if (snapshot.phase !== previousPhase) {
            phases.push({
                phase: snapshot.phase ?? 'ready',
                at: performance.now() - jumpProbeStartedAt,
            });
            previousPhase = snapshot.phase;
        }
        if (snapshot.system === 'nova:162' && !snapshot.phase
            && snapshot.position) {
            jump = {
                phases,
                system: snapshot.system,
                route: snapshot.route,
                position: snapshot.position,
                velocity: snapshot.velocity,
                profile: {
                    maxVelocity,
                    spoolStart,
                    spoolEnd,
                    departurePeakSpeed,
                    arrivalStartSpeed,
                    arrivalStartPosition,
                    arrivalEndSpeed,
                    spoolFrames,
                    maxDeltaSeconds,
                    remotePresentationSeen,
                },
            };
            break;
        }
        await sleep(25);
    }
    assert(jump, `Jump lifecycle did not complete: ${JSON.stringify({
        phases,
        lastSnapshot,
    })}`);
    assert.equal(jump.system, 'nova:162');
    assert.deepEqual(jump.route, ['nova:531']);
    assert(jump.phases.some(({ phase }) => phase === 'spooling'),
        `spooling phase missing: ${JSON.stringify(jump.phases)}`);
    assert(jump.phases.some(({ phase }) => phase === 'departing'),
        `departure phase missing: ${JSON.stringify(jump.phases)}`);
    assert(jump.phases.some(({ phase }) => phase === 'arriving'),
        `arrival phase missing: ${JSON.stringify(jump.phases)}`);
    const spoolDistance = Math.hypot(
        jump.profile.spoolEnd[0] - jump.profile.spoolStart[0],
        jump.profile.spoolEnd[1] - jump.profile.spoolStart[1],
    );
    assert(spoolDistance > jump.profile.maxVelocity,
        `departure did not move visibly in-system: ${JSON.stringify(jump.profile)}`);
    assert(jump.profile.departurePeakSpeed
        >= jump.profile.maxVelocity * 3.3,
    `departure boost was clamped: ${JSON.stringify(jump.profile)}`);
    assert(jump.profile.arrivalStartSpeed
        >= jump.profile.maxVelocity * 2.7,
    `arrival did not start fast: ${JSON.stringify(jump.profile)}`);
    assert(jump.profile.arrivalEndSpeed
        < jump.profile.arrivalStartSpeed,
    `arrival did not decelerate: ${JSON.stringify(jump.profile)}`);
    assert(Math.abs(jump.profile.arrivalStartPosition[0] + 1_358.73) < 20,
        `wrong west-side arrival: ${
            JSON.stringify(jump.profile.arrivalStartPosition)}`);
    assert(Math.abs(jump.profile.arrivalStartPosition[1] - 339.68) < 20,
        `wrong arrival vector: ${
            JSON.stringify(jump.profile.arrivalStartPosition)}`);
    assert(jump.velocity[0] > 0 && jump.velocity[1] < 0,
        `wrong arrival travel direction: ${JSON.stringify(jump.velocity)}`);

    await press('m');
    await waitFor(page, `(() => {
        const key = [...window.system.resources.keys()].find(
            resource => resource.name === 'Starmap');
        return window.system.resources.get(key)?.container.visible;
    })()`, { label: 'first destination map open' });
    const mapFirstOpen = await evaluate(page, `(() => {
        const key = [...window.system.resources.keys()].find(
            resource => resource.name === 'Starmap');
        const map = window.system.resources.get(key);
        const graph = map.systemGraph;
        const currentGraphics = graph.systemCircles.get('nova:162')[1];
        return {
            position: [graph.mapContainer.position.x,
                graph.mapContainer.position.y],
            currentMarkerParts: currentGraphics.geometry.graphicsData.length,
        };
    })()`);
    assert(Math.abs(mapFirstOpen.position[0] - 148) < 1);
    assert(Math.abs(mapFirstOpen.position[1] - 229.5) < 1);
    assert(mapFirstOpen.currentMarkerParts >= 3,
        `current marker missing: ${JSON.stringify(mapFirstOpen)}`);

    await evaluate(page, `(() => {
        const key = [...window.system.resources.keys()].find(
            resource => resource.name === 'Starmap');
        window.system.resources.get(key).systemGraph
            .mapContainer.position.set(12, 34);
    })()`);
    await press('m');
    await waitFor(page, `(() => {
        const key = [...window.system.resources.keys()].find(
            resource => resource.name === 'Starmap');
        return !window.system.resources.get(key)?.container.visible;
    })()`, { label: 'map close' });
    await press('m');
    await waitFor(page, `(() => {
        const key = [...window.system.resources.keys()].find(
            resource => resource.name === 'Starmap');
        return window.system.resources.get(key)?.container.visible;
    })()`, { label: 'map reopen' });
    const reopenedPan = await evaluate(page, `(() => {
        const key = [...window.system.resources.keys()].find(
            resource => resource.name === 'Starmap');
        const position = window.system.resources.get(key)
            .systemGraph.mapContainer.position;
        return [position.x, position.y];
    })()`);
    assert.deepEqual(reopenedPan, [12, 34]);

    console.log(JSON.stringify({
        destruction,
        jump: {
            ...jump,
            wallClockMs: Date.now() - jumpStartedAt,
        },
        map: { firstOpen: mapFirstOpen, reopenedPan },
    }, null, 2));
} finally {
    page.close();
    chrome.close();
}
