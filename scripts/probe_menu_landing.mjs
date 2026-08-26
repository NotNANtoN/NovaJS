import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
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
    port: Number(process.env.NOVA_PROBE_PORT ?? 9343),
});
const page = await openPage(chrome.wsUrl, 'http://localhost:8200');
const simulateStalePlanetSchema =
    process.env.NOVA_STALE_PLANET_SCHEMA !== '0';

async function pressLanding() {
    await keyDown(page, 'l');
    await sleep(30);
    await evaluate(page, 'window.system.step()');
    await keyUp(page, 'l');
    await sleep(30);
    await evaluate(page, 'window.system.step()');
}

async function placePlayer(x, y) {
    await evaluate(page, `(() => {
        const player = [...window.system.entities.values()].find(entity =>
            [...entity.components.keys()].some(
                component => component.name === 'ShipControl'));
        const movementKey = [...player.components.keys()].find(
            component => component.name === 'MovementState');
        const movement = player.components.get(movementKey);
        movement.position.x = ${x};
        movement.position.y = ${y};
        movement.velocity.x = 0;
        movement.velocity.y = 0;
    })()`);
}

async function screenshot(name) {
    const capture = await page.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
    });
    writeFileSync(`/tmp/${name}.png`, Buffer.from(capture.data, 'base64'));
}

function expectStalePlanetShape(data) {
    for (const field of [
        'flags',
        'techLevel',
        'specialTech',
        'canLand',
        'inhabited',
        'hasCommodityExchange',
        'hasOutfitter',
        'hasShipyard',
        'hasBar',
    ]) {
        assert.equal(data?.[field], undefined,
            `expected stale local PlanetData.${field} to be absent`);
    }
}

try {
    await waitFor(page, "document.querySelector('[data-nova-logo]')", {
        timeoutMs: 60_000,
        label: 'retail menu logo',
    });
    await page.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: 20, y: 20, button: 'left', clickCount: 1,
    });
    await page.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: 20, y: 20, button: 'left', clickCount: 1,
    });
    await waitFor(page,
        'window.novaTitleMusicState'
        + ' && window.novaTitleMusicState().created'
        + ' && !window.novaTitleMusicState().paused',
        { label: 'Nova title music playback after gesture' });
    const titleMusic = await evaluate(page, `({
        gestureDispatched: true,
        ...window.novaTitleMusicState(),
    })`);
    assert.match(titleMusic.url, /\/music\/Nova%20Music\.mp3$/);
    assert.equal(titleMusic.loop, true);
    const cadence = await evaluate(page, `(async () => {
        const logo = document.querySelector('[data-nova-logo]');
        const logoChanges = [];
        const rafTimes = [];
        const pixiTimes = [];
        let previousRaf;
        const onPixiTick = () => pixiTimes.push(performance.now());
        window.app.ticker.add(onPixiTick);
        const observer = new MutationObserver(() => {
            logoChanges.push({
                at: Number(logo.dataset.logoTimestamp),
                frame: Number(logo.dataset.logoFrame),
            });
        });
        observer.observe(logo, {
            attributes: true,
            attributeFilter: ['data-logo-frame'],
        });
        const startedAt = performance.now();
        function sampleRaf(now) {
            if (previousRaf !== undefined) {
                rafTimes.push(now - previousRaf);
            }
            previousRaf = now;
            if (now - startedAt < 2_200) {
                requestAnimationFrame(sampleRaf);
            }
        }
        requestAnimationFrame(sampleRaf);
        setTimeout(() => {
            const blockedUntil = performance.now() + 160;
            while (performance.now() < blockedUntil) {
                // Deliberately produce one render gap.
            }
        }, 800);
        await new Promise(resolve => setTimeout(resolve, 2_300));
        observer.disconnect();
        window.app.ticker.remove(onPixiTick);
        const gaps = values => values.slice(1)
            .map((value, index) => value - values[index]);
        const median = values => {
            const sorted = [...values].sort((a, b) => a - b);
            return sorted[Math.floor(sorted.length / 2)] ?? 0;
        };
        const logoIntervals = gaps(logoChanges.map(change => change.at));
        const pixiIntervals = gaps(pixiTimes);
        return {
            changes: logoChanges.length,
            distinctFrames: new Set(
                logoChanges.map(change => change.frame)).size,
            medianLogoMs: median(logoIntervals),
            maxLogoGapMs: Math.max(...logoIntervals),
            minLogoGapMs: Math.min(...logoIntervals),
            medianRafMs: median(rafTimes),
            maxRafGapMs: Math.max(...rafTimes),
            medianPixiMs: median(pixiIntervals),
            maxPixiGapMs: Math.max(...pixiIntervals),
        };
    })()`);
    assert(cadence.changes >= 15, `too few logo changes: ${cadence.changes}`);
    assert(cadence.distinctFrames >= 5,
        `too few logo frames: ${cadence.distinctFrames}`);
    assert(cadence.medianLogoMs >= 80 && cadence.medianLogoMs <= 125,
        `unexpected logo cadence: ${cadence.medianLogoMs}ms`);
    assert(cadence.maxRafGapMs >= 120,
        `induced render gap was not measured: ${cadence.maxRafGapMs}ms`);
    assert(cadence.minLogoGapMs >= 8,
        `logo replayed missed frames in a burst: ${cadence.minLogoGapMs}ms`);

    await evaluate(page,
        "document.querySelector('[data-menu-action=\"About Nova\"]').click()");
    await waitFor(page, "!document.querySelector('[data-nova-logo]')", {
        label: 'logo animation teardown',
    });
    await evaluate(page,
        "[...document.querySelectorAll('button')].find(button => "
        + "button.textContent === 'Back').click()");
    await waitFor(page, "document.querySelectorAll('[data-nova-logo]').length === 1", {
        label: 'single restarted logo animation',
    });

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
        label: 'player ship in Sol',
    });
    await waitFor(page, 'window.world', {
        timeoutMs: 60_000,
        label: 'gameplay ticker installation',
    });
    await waitFor(page, 'window.app.ticker.count > 0', {
        timeoutMs: 10_000,
        label: 'active gameplay ticker callback',
    });
    await sleep(250);
    const worldStepError = await evaluate(page, `(() => {
        try {
            window.system.step();
            return undefined;
        } catch (error) {
            return error?.stack ?? String(error);
        }
    })()`);
    assert.equal(worldStepError, undefined,
        `gameplay world step failed: ${worldStepError}`);
    await waitFor(page, `[...window.system.entities.values()]
        .some(entity => entity.name === 'Earth'
        && [...entity.components.keys()]
        .some(component => component.name === 'PlanetData'))`, {
        timeoutMs: 60_000,
        label: 'Earth resource in Sol',
    });
    const settledStepError = await evaluate(page, `(async () => {
        try {
            for (let index = 0; index < 20; index++) {
                window.system.step();
                await Promise.resolve();
            }
            return undefined;
        } catch (error) {
            return error?.stack ?? String(error);
        }
    })()`);
    assert.equal(settledStepError, undefined,
        `settled gameplay step failed: ${settledStepError}`);
    await evaluate(page, `(() => {
        window.__landingKeys = [];
        window.__landingSteps = [];
        window.__controlSteps = [];
        document.addEventListener('keydown', event =>
            window.__landingKeys.push({
                type: event.type, key: event.key, code: event.code,
                repeat: event.repeat,
            }));
        document.addEventListener('keyup', event =>
            window.__landingKeys.push({
                type: event.type, key: event.key, code: event.code,
                repeat: event.repeat,
            }));
        const gameWorld = window.system;
        for (const name of ['ControlEventSystem', 'UpdateControlState']) {
            const system = gameWorld?.systems.find(
                candidate => candidate.name === name);
            const step = system.step.bind(system);
            system.step = (...args) => {
                window.__controlSteps.push({
                    name,
                    event: name === 'ControlEventSystem'
                        ? {
                            type: args[0].type,
                            code: args[0].code,
                            key: args[0].key,
                            repeat: args[0].repeat,
                        }
                        : args[0],
                    state: name === 'UpdateControlState'
                        ? [...args[1]]
                        : undefined,
                });
                step(...args);
                if (name === 'UpdateControlState') {
                    window.__controlSteps.push({
                        name: name + ':after',
                        state: [...args[1]],
                    });
                }
            };
        }
        const landingSystem = gameWorld?.systems.find(
            system => system.name === 'AttemptLandingSystem');
        if (!landingSystem) {
            throw new Error(JSON.stringify(
                gameWorld?.systems.map(system => system.name)));
        }
        const originalStep = landingSystem.step.bind(landingSystem);
        landingSystem.step = (...args) => {
            const [, , planetTarget, landingInput, controls] = args;
            const before = {
                target: planetTarget.target,
                held: landingInput.held,
                control: controls.get('land'),
            };
            originalStep(...args);
            window.__landingSteps.push({
                before,
                after: {
                    target: planetTarget.target,
                    held: landingInput.held,
                    control: controls.get('land'),
                },
            });
        };
    })()`);

    const landingState = () => evaluate(page, `(() => {
        const entries = [...window.system.entities];
        const player = entries.find(([, entity]) =>
            [...entity.components.keys()].some(
                component => component.name === 'ShipControl'));
        const earth = entries.find(([, entity]) => entity.name === 'Earth');
        const jupiter = entries.find(([, entity]) => entity.name === 'Jupiter');
        const componentValue = (entity, name) => {
            if (!entity) {
                return undefined;
            }
            const component = [...entity.components.keys()].find(
                candidate => candidate.name === name);
            return component ? entity.components.get(component) : undefined;
        };
        const playerMovement = player
            ? componentValue(player[1], 'MovementState')
            : undefined;
        const earthMovement = componentValue(earth?.[1], 'MovementState');
        const jupiterMovement = componentValue(jupiter?.[1], 'MovementState');
        const earthData = componentValue(earth?.[1], 'PlanetData');
        const jupiterData = componentValue(jupiter?.[1], 'PlanetData');
        const earthRuntime = componentValue(earth?.[1], 'Planet');
        const jupiterRuntime = componentValue(jupiter?.[1], 'Planet');
        const gameDataResource = [...window.system.resources.keys()].find(
            resource => resource.name === 'GameData');
        const gameData = gameDataResource
            ? window.system.resources.get(gameDataResource)
            : undefined;
        const sourceFields = data => data ? {
            id: data.id,
            name: data.name,
            flags: data.flags,
            techLevel: data.techLevel,
            specialTech: data.specialTech,
            canLand: data.canLand,
            inhabited: data.inhabited,
            hasCommodityExchange: data.hasCommodityExchange,
            hasOutfitter: data.hasOutfitter,
            hasShipyard: data.hasShipyard,
            hasBar: data.hasBar,
        } : undefined;
        const controlResource = [...window.system.resources.keys()].find(
            resource => resource.name === 'ControlStateResource');
        const controls = controlResource
            ? window.system.resources.get(controlResource)
            : undefined;
        const timeResource = [...window.system.resources.keys()].find(
            resource => resource.name === 'time');
        const gameTime = timeResource
            ? window.system.resources.get(timeResource)
            : undefined;
        const statusBarResource = [...window.system.resources.keys()].find(
            resource => resource.name === 'StatusBar');
        const statusBar = statusBarResource
            ? window.system.resources.get(statusBarResource)
            : undefined;
        const landingMessage = statusBar?.container
            .getChildByName('LandingMessage');
        const landingMessageText = landingMessage
            ?.getChildByName('LandingMessageText');
        return {
            playerUuid: player?.[0],
            earthUuid: earth?.[0],
            jupiterUuid: jupiter?.[0],
            planetTarget: player
                ? componentValue(player[1], 'PlanetTargetComponent')?.target
                : undefined,
            landingHeld: player
                ? componentValue(player[1], 'LandingInputComponent')?.held
                : undefined,
            earthData: sourceFields(earthData),
            jupiterData: sourceFields(jupiterData),
            earthRuntime: sourceFields(earthRuntime),
            jupiterRuntime: sourceFields(jupiterRuntime),
            earthSourceData: sourceFields(
                gameData?.data.Planet.getCached('nova:128')),
            jupiterSourceData: sourceFields(
                gameData?.data.Planet.getCached('nova:159')),
            playerPosition: playerMovement
                ? [playerMovement.position.x, playerMovement.position.y]
                : undefined,
            playerVelocity: playerMovement
                ? [playerMovement.velocity.x, playerMovement.velocity.y]
                : undefined,
            earthPosition: earthMovement
                ? [earthMovement.position.x, earthMovement.position.y]
                : undefined,
            jupiterPosition: jupiterMovement
                ? [jupiterMovement.position.x, jupiterMovement.position.y]
                : undefined,
            distanceSquared: playerMovement && earthMovement
                ? earthMovement.position.subtract(
                    playerMovement.position).lengthSquared
                : undefined,
            speedSquared: playerMovement?.velocity.lengthSquared,
            tickerCount: window.app.ticker.count,
            tickerStarted: window.app.ticker.started,
            gameFrame: gameTime?.frame,
            gameTime: gameTime?.time,
            landControl: controls?.get('land'),
            resourceNames: [...window.system.resources.keys()]
                .map(resource => resource.name),
            playerComponents: player
                ? [...player[1].components.keys()].map(component => component.name)
                : [],
            queuedEvents: (window.system.eventQueue ?? []).map(
                queued => queued.event?.name),
            keyEvents: window.__landingKeys,
            landingSteps: window.__landingSteps,
            controlSteps: window.__controlSteps,
            landingMessageVisible: landingMessage?.visible ?? false,
            landingMessage: landingMessageText?.text,
            spaceportVisible: Boolean(
                componentValue(earth?.[1], 'Spaceport')?.container?.visible),
        };
    })()`);
    // Simulate an old immutable browser-cache schema by stripping eligibility
    // only from local PlanetData. The replicated server Planet descriptor must
    // remain authoritative.
    if (simulateStalePlanetSchema) {
        await evaluate(page, `(() => {
            for (const entity of window.system.entities.values()) {
                const dataKey = [...entity.components.keys()].find(
                    component => component.name === 'PlanetData');
                if (!dataKey) {
                    continue;
                }
                const data = entity.components.get(dataKey);
                delete data.flags;
                delete data.techLevel;
                delete data.specialTech;
                delete data.canLand;
                delete data.inhabited;
                delete data.hasCommodityExchange;
                delete data.hasOutfitter;
                delete data.hasShipyard;
                delete data.hasBar;
            }
        })()`);
    }
    // Jupiter is a real retail non-landable stellar. Position only changes the
    // range setup; runtime eligibility remains exactly as server-spawned.
    await placePlayer(-1700, 900);
    const beforeLanding = await landingState();
    await pressLanding();
    const afterJupiterTarget = await landingState();
    if (afterJupiterTarget.planetTarget !== afterJupiterTarget.jupiterUuid) {
        console.error(JSON.stringify({
            beforeLanding,
            afterJupiterTarget,
        }, null, 2));
    }
    assert.equal(afterJupiterTarget.planetTarget, afterJupiterTarget.jupiterUuid);
    assert.equal(
        afterJupiterTarget.jupiterData.canLand,
        simulateStalePlanetSchema ? undefined : false,
    );
    assert.equal(
        afterJupiterTarget.jupiterData.inhabited,
        simulateStalePlanetSchema ? undefined : false,
    );
    assert.equal(afterJupiterTarget.jupiterRuntime.canLand, false);
    assert.equal(afterJupiterTarget.jupiterRuntime.inhabited, false);
    await pressLanding();
    const afterJupiterRejection = await landingState();
    assert.equal(
        afterJupiterRejection.landingMessage,
        'Landing is not permitted on Jupiter.',
    );

    await placePlayer(0, 400);
    await pressLanding();
    const afterEarthTarget = await landingState();
    assert.equal(afterEarthTarget.planetTarget, afterEarthTarget.earthUuid);
    assert.equal(
        afterEarthTarget.earthData.canLand,
        simulateStalePlanetSchema ? undefined : true,
    );
    assert.equal(
        afterEarthTarget.earthData.inhabited,
        simulateStalePlanetSchema ? undefined : true,
    );
    assert.equal(afterEarthTarget.earthRuntime.canLand, true);
    assert.equal(afterEarthTarget.earthRuntime.inhabited, true);
    if (simulateStalePlanetSchema) {
        expectStalePlanetShape(afterEarthTarget.earthData);
        expectStalePlanetShape(afterEarthTarget.earthSourceData);
    }
    assert.match(afterEarthTarget.landingMessage, /press L again/i);
    await pressLanding();
    await sleep(250);
    const afterLanding = await landingState();
    if (afterLanding.playerUuid !== undefined
        || !afterLanding.spaceportVisible) {
        console.error(JSON.stringify({
            beforeLanding,
            afterJupiterTarget,
            afterJupiterRejection,
            afterEarthTarget,
            afterLanding,
        }, null, 2));
    }
    assert.equal(afterLanding.playerUuid, undefined,
        'second distinct Earth press did not land');
    assert.equal(afterLanding.spaceportVisible, true,
        'Earth spaceport did not become visible after satisfying range');

    const earthSpaceportState = () => evaluate(page, `(() => {
        const earth = [...window.system.entities.values()]
            .find(entity => entity.name === 'Earth');
        const key = [...earth.components.keys()]
            .find(component => component.name === 'Spaceport');
        const spaceport = earth.components.get(key);
        const dataKey = [...earth.components.keys()]
            .find(component => component.name === 'PlanetData');
        const localData = earth.components.get(dataKey);
        const resolvedData = spaceport.resolvedPlanetData;
        const metadata = data => ({
            flags: data?.flags,
            techLevel: data?.techLevel,
            specialTech: data?.specialTech,
            canLand: data?.canLand,
            inhabited: data?.inhabited,
            hasCommodityExchange: data?.hasCommodityExchange,
            hasOutfitter: data?.hasOutfitter,
            hasShipyard: data?.hasShipyard,
            hasBar: data?.hasBar,
        });
        const barButton = spaceport.serviceButtons.bar.container;
        const landingPict = spaceport.container.children[1];
        const barBounds = barButton.getBounds();
        const barCenter = {
            x: barBounds.x + barBounds.width / 2,
            y: barBounds.y + barBounds.height / 2,
        };
        const hitInsideBar = barButton.interactive
            && barBounds.contains(barCenter.x, barCenter.y);
        const bounds = value => {
            const result = value.getBounds();
            return { x: result.x, y: result.y, width: result.width,
                height: result.height };
        };
        const texts = container => {
            const values = [];
            const visit = child => {
                if (typeof child.text === 'string') values.push(child.text);
                for (const nested of child.children ?? []) visit(nested);
            };
            visit(container);
            return values;
        };
        const panelSize = container => {
            const sprite = container.children.find(child => child.texture);
            return sprite ? {
                width: sprite.texture.orig.width,
                height: sprite.texture.orig.height,
            } : undefined;
        };
        const contentContained = container => {
            const panel = container.children.find(child => child.texture);
            if (!panel) return false;
            const panelBounds = panel.getBounds();
            let contained = true;
            const visit = child => {
                if (typeof child.text === 'string' && child.visible) {
                    const renderBounds = (child.mask ?? child).getBounds();
                    contained &&= renderBounds.x >= panelBounds.x - 1
                        && renderBounds.y >= panelBounds.y - 1
                        && renderBounds.right <= panelBounds.right + 1
                        && renderBounds.bottom <= panelBounds.bottom + 1;
                }
                for (const nested of child.children ?? []) visit(nested);
            };
            visit(container);
            return contained;
        };
        return {
            localPlanetData: metadata(localData),
            resolvedPlanetData: metadata(resolvedData),
            barButtonVisible: barButton.visible,
            barButtonBounds: bounds(barButton),
            barHitTestable: hitInsideBar,
            landingBounds: bounds(landingPict),
            barAboveLanding:
                spaceport.container.getChildIndex(barButton)
                > spaceport.container.getChildIndex(landingPict),
            barVisible: spaceport.bar.container.visible,
            barPanelSize: panelSize(spaceport.bar.container),
            missionVisible: spaceport.missionBbs.container.visible,
            missionPanelSize: panelSize(spaceport.missionBbs.container),
            infoVisible: spaceport.missionInfo.container.visible,
            infoPanelSize: panelSize(spaceport.missionInfo.container),
            missionTexts: texts(spaceport.missionBbs.container),
            missionOfferIds:
                spaceport.missionBbs.offers.map(offer => offer.mission.id),
            missionContentContained:
                contentContained(spaceport.missionBbs.container),
            infoContentContained:
                contentContained(spaceport.missionInfo.container),
            visibleDialogs: [
                spaceport.bar.container,
                spaceport.missionBbs.container,
                spaceport.missionInfo.container,
                spaceport.tradeCenter.container,
                spaceport.outfitter.container,
                spaceport.shipyard.container,
            ].filter(container => container.visible).length,
            boundControls: [
                spaceport,
                spaceport.bar,
                spaceport.missionBbs,
                spaceport.missionInfo,
                spaceport.tradeCenter,
                spaceport.outfitter,
                spaceport.shipyard,
            ].filter(menu => menu.controls.controlsSubscription).length,
            // Naming the offender matters more than counting: a stray binding
            // is what leaves a pilot unable to leave a dialog.
            boundMenus: Object.entries({
                spaceport,
                bar: spaceport.bar,
                missionBbs: spaceport.missionBbs,
                missionInfo: spaceport.missionInfo,
                tradeCenter: spaceport.tradeCenter,
                outfitter: spaceport.outfitter,
                shipyard: spaceport.shipyard,
            }).filter(([, menu]) => menu.controls.controlsSubscription)
                .map(([name]) => name),
            briefingGraphicChildren:
                spaceport.missionBbs.briefingGraphic.children.length,
        };
    })()`);
    const initialSpaceport = await earthSpaceportState();
    if (simulateStalePlanetSchema) {
        expectStalePlanetShape(initialSpaceport.localPlanetData);
    }
    assert.equal(initialSpaceport.resolvedPlanetData.flags, 0x2214204f);
    assert.equal(initialSpaceport.resolvedPlanetData.hasBar, true);
    assert.equal(initialSpaceport.resolvedPlanetData.hasCommodityExchange, true);
    assert.equal(initialSpaceport.resolvedPlanetData.hasOutfitter, true);
    assert.equal(initialSpaceport.resolvedPlanetData.hasShipyard, true);
    assert.ok(initialSpaceport.resolvedPlanetData.techLevel >= 0);
    assert.equal(initialSpaceport.barButtonVisible, true);
    assert.equal(initialSpaceport.barAboveLanding, true);
    assert.equal(initialSpaceport.barHitTestable, true);
    assert.equal(initialSpaceport.visibleDialogs, 0);
    assert.equal(initialSpaceport.boundControls, 1,
        `bound menus: ${initialSpaceport.boundMenus.join(', ')}`);
    assert.ok(initialSpaceport.barButtonBounds.width > 0);
    await screenshot('novajs-earth-spaceport');

    await evaluate(page, `(() => {
        const earth = [...window.system.entities.values()]
            .find(entity => entity.name === 'Earth');
        const key = [...earth.components.keys()]
            .find(component => component.name === 'Spaceport');
        earth.components.get(key).serviceButtons.bar.click.next(undefined);
    })()`);
    await sleep(250);
    const barAfterClick = await earthSpaceportState();
    assert.equal(barAfterClick.barVisible, true,
        `Earth Bar did not open: ${JSON.stringify(barAfterClick)}`);
    await waitFor(page, `(() => {
        const earth = [...window.system.entities.values()]
            .find(entity => entity.name === 'Earth');
        const key = [...earth.components.keys()]
            .find(component => component.name === 'Spaceport');
        return earth.components.get(key).bar.container.visible;
    })()`, { label: 'Earth Bar open' });
    const openBar = await earthSpaceportState();
    assert.equal(openBar.barVisible, true);
    assert.equal(openBar.visibleDialogs, 1);
    assert.equal(openBar.boundControls, 1);
    assert.deepEqual(openBar.barPanelSize,
        { width: 263, height: 185 });
    await waitFor(page, `(() => {
        const earth = [...window.system.entities.values()]
            .find(entity => entity.name === 'Earth');
        const key = [...earth.components.keys()]
            .find(component => component.name === 'Spaceport');
        return !earth.components.get(key).bar.loading;
    })()`, { timeoutMs: 90_000, label: 'Earth Bar postings' });
    await screenshot('novajs-earth-bar');
    await evaluate(page, `(() => {
        const earth = [...window.system.entities.values()]
            .find(entity => entity.name === 'Earth');
        const key = [...earth.components.keys()]
            .find(component => component.name === 'Spaceport');
        earth.components.get(key).bar.done();
    })()`);
    await waitFor(page, `!(() => {
        const earth = [...window.system.entities.values()]
            .find(entity => entity.name === 'Earth');
        const key = [...earth.components.keys()]
            .find(component => component.name === 'Spaceport');
        return earth.components.get(key).bar.container.visible;
    })()`, { label: 'Earth Bar close' });

    await evaluate(page, `(() => {
        const earth = [...window.system.entities.values()]
            .find(entity => entity.name === 'Earth');
        const key = [...earth.components.keys()]
            .find(component => component.name === 'Spaceport');
        earth.components.get(key).serviceButtons.missionBBS.click.next(undefined);
    })()`);
    await waitFor(page, `(() => {
        const earth = [...window.system.entities.values()]
            .find(entity => entity.name === 'Earth');
        const key = [...earth.components.keys()]
            .find(component => component.name === 'Spaceport');
        return earth.components.get(key).missionBbs.container.visible;
    })()`, { label: 'Mission Computer immediate shell' });
    const immediateMission = await earthSpaceportState();
    assert.equal(immediateMission.missionVisible, true);
    assert.equal(immediateMission.visibleDialogs, 1);
    assert.equal(immediateMission.boundControls, 1);
    assert.deepEqual(immediateMission.missionPanelSize,
        { width: 510, height: 201 });
    assert.ok(immediateMission.missionTexts.some(text =>
        /Loading mission postings|No missions|▶/.test(text)));
    await screenshot('novajs-earth-mission-immediate');
    await waitFor(page, `(() => {
        const earth = [...window.system.entities.values()]
            .find(entity => entity.name === 'Earth');
        const key = [...earth.components.keys()]
            .find(component => component.name === 'Spaceport');
        const bbs = earth.components.get(key).missionBbs;
        return bbs.offers.length > 0;
    })()`, { timeoutMs: 90_000, label: 'Mission Computer postings' });
    const populatedMission = await earthSpaceportState();
    assert.ok(populatedMission.missionTexts.every(text =>
        !/<[A-Za-z][^>]*>/.test(text)));
    assert.equal(populatedMission.missionContentContained, true);
    assert.ok(populatedMission.missionOfferIds.every(id =>
        !id.startsWith('proc:')));
    assert.equal(populatedMission.briefingGraphicChildren, 0);
    await screenshot('novajs-earth-mission-populated');

    await evaluate(page, `(() => {
        const earth = [...window.system.entities.values()]
            .find(entity => entity.name === 'Earth');
        const key = [...earth.components.keys()]
            .find(component => component.name === 'Spaceport');
        const bbs = earth.components.get(key).missionBbs;
        bbs.moveSelection(1);
        bbs.controls.controls.missions();
    })()`);
    await waitFor(page, `(() => {
        const earth = [...window.system.entities.values()]
            .find(entity => entity.name === 'Earth');
        const key = [...earth.components.keys()]
            .find(component => component.name === 'Spaceport');
        return earth.components.get(key).missionInfo.container.visible;
    })()`, { label: 'Mission Info open' });
    const openInfo = await earthSpaceportState();
    assert.equal(openInfo.infoVisible, true);
    assert.equal(openInfo.visibleDialogs, 1);
    assert.equal(openInfo.boundControls, 1);
    assert.equal(openInfo.infoContentContained, true);
    assert.deepEqual(openInfo.infoPanelSize,
        { width: 471, height: 155 });
    await screenshot('novajs-earth-mission-info');
    await evaluate(page, `(() => {
        const earth = [...window.system.entities.values()]
            .find(entity => entity.name === 'Earth');
        const key = [...earth.components.keys()]
            .find(component => component.name === 'Spaceport');
        earth.components.get(key).missionInfo.done();
    })()`);
    await waitFor(page, `(() => {
        const earth = [...window.system.entities.values()]
            .find(entity => entity.name === 'Earth');
        const key = [...earth.components.keys()]
            .find(component => component.name === 'Spaceport');
        const spaceport = earth.components.get(key);
        return spaceport.missionBbs.container.visible
            && !spaceport.missionInfo.container.visible;
    })()`, { label: 'Mission Info return to BBS' });
    await evaluate(page, `(() => {
        const earth = [...window.system.entities.values()]
            .find(entity => entity.name === 'Earth');
        const key = [...earth.components.keys()]
            .find(component => component.name === 'Spaceport');
        earth.components.get(key).missionBbs.done();
    })()`);

    console.log(JSON.stringify({
        cadence,
        titleMusic,
        landing: {
            schemaMode: simulateStalePlanetSchema ? 'stale-local' : 'fresh',
            earthUuid: afterEarthTarget.earthUuid,
            earthLiveData: afterEarthTarget.earthData,
            earthRuntimeData: afterEarthTarget.earthRuntime,
            earthSourceData: afterEarthTarget.earthSourceData,
            jupiterUuid: afterJupiterTarget.jupiterUuid,
            jupiterLiveData: afterJupiterTarget.jupiterData,
            jupiterRuntimeData: afterJupiterTarget.jupiterRuntime,
            jupiterSourceData: afterJupiterTarget.jupiterSourceData,
            nonLandableRejection: afterJupiterRejection.landingMessage,
            targetAfterEarthFirstPress: afterEarthTarget.planetTarget,
            playerRemovedAfterEarthSecondPress:
                afterLanding.playerUuid === undefined,
            satisfiedDistanceSquared: 160_000,
            spaceportVisible: afterLanding.spaceportVisible,
            earthSpaceport: initialSpaceport,
            populatedMissionComputer: populatedMission,
            screenshots: [
                '/tmp/novajs-earth-spaceport.png',
                '/tmp/novajs-earth-bar.png',
                '/tmp/novajs-earth-mission-immediate.png',
                '/tmp/novajs-earth-mission-populated.png',
                '/tmp/novajs-earth-mission-info.png',
            ],
        },
    }, null, 2));
} finally {
    page.close();
    chrome.close();
}
