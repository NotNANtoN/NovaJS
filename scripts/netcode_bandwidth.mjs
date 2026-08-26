#!/usr/bin/env node

const FPS = 60;
const DURATION_SECONDS = 30;
const SHIP_COUNT = 24;
const MOVEMENT_INTERVAL_FRAMES = 6;
const INTEREST_RADIUS = 6_000;
const POSITION_QUANTUM = 0.25;
const VELOCITY_QUANTUM = 0.1;
const ANGLE_QUANTUM = 0.001;

const COMPONENT_ORDER = [
    'MultiplayerData',
    'MovementState',
    'MovementPhysics',
    'ShipComponent',
    'WeaponsStateComponent',
    'Shield',
    'Armor',
    'Target',
];

function roundTo(value, quantum) {
    return Math.round(value / quantum) * quantum;
}

function quantizedMovement(state) {
    return {
        position: {
            x: roundTo(state.position.x, POSITION_QUANTUM),
            y: roundTo(state.position.y, POSITION_QUANTUM),
        },
        velocity: {
            x: roundTo(state.velocity.x, VELOCITY_QUANTUM),
            y: roundTo(state.velocity.y, VELOCITY_QUANTUM),
        },
        rotation: { angle: roundTo(state.rotation.angle, ANGLE_QUANTUM) },
        turning: state.turning,
        turnBack: state.turnBack,
        accelerating: state.accelerating,
        targetSpeed: state.targetSpeed === undefined
            ? undefined
            : roundTo(state.targetSpeed, VELOCITY_QUANTUM),
    };
}

function movementDelta(previous, current) {
    const delta = {};
    for (const field of [
        'position',
        'velocity',
        'rotation',
        'turning',
        'turnBack',
        'accelerating',
        'targetSpeed',
    ]) {
        if (JSON.stringify(previous?.[field]) !== JSON.stringify(current[field])) {
            delta[field] = current[field];
        }
    }
    return delta;
}

function makeShips() {
    return Array.from({ length: SHIP_COUNT }, (_, index) => {
        const near = index < 12;
        const radius = index === 0
            ? 0
            : near
                ? 700 + index * 390
                : 7_000 + (index - 12) * 220;
        const angle = index * 2.399963229728653;
        return {
            uuid: `ship-${String(index).padStart(2, '0')}`,
            owner: index === 0 ? 'client-1' : 'server',
            position: {
                x: Math.cos(angle) * radius,
                y: Math.sin(angle) * radius,
            },
            velocity: {
                x: 45 + (index % 5) * 17.123456789,
                y: -35 + (index % 7) * 11.987654321,
            },
            rotation: angle,
            turning: index % 3 === 0 ? 0.22 : 0,
            accelerating: index % 4 === 0 ? 1 : 0,
            target: `ship-${String((index + 1) % 12).padStart(2, '0')}`,
            shield: 400 - index * 3,
            armor: 250 - index * 2,
        };
    });
}

function movementState(ship) {
    return {
        position: { ...ship.position },
        velocity: { ...ship.velocity },
        rotation: { angle: ship.rotation },
        turning: Math.sign(ship.turning),
        turnBack: false,
        accelerating: ship.accelerating,
        targetSpeed: 450.123456789,
    };
}

function fullComponents(ship, mode) {
    const movement = mode !== 'baseline'
        ? quantizedMovement(movementState(ship))
        : movementState(ship);
    return new Map([
        ['MultiplayerData', { owner: ship.owner }],
        ['MovementState', movement],
        ['MovementPhysics', {
            maxVelocity: 500.123456789,
            turnRate: 2.345678901,
            acceleration: 180.987654321,
            movementType: 0,
        }],
        ['ShipComponent', { id: `nova:${128 + (Number(ship.uuid.slice(-2)) % 8)}` }],
        ['WeaponsStateComponent', [
            ['nova:1000', { count: 2, firing: false, target: ship.target }],
            ['nova:1001', { count: 12, firing: false, target: ship.target }],
        ]],
        ['Shield', { current: ship.shield, max: 400, recharge: 4.25 }],
        ['Armor', { current: ship.armor, max: 250, recharge: 0 }],
        ['Target', { target: ship.target }],
    ]);
}

function inInterest(ship) {
    return ship.owner === 'client-1'
        || Math.hypot(ship.position.x, ship.position.y) <= INTEREST_RADIUS;
}

function wireFrame(message) {
    return JSON.stringify({
        message: {
            type: 1,
            message: {
                room: 'nova:128',
                message,
            },
            source: 'server',
        },
    });
}

function encodedBytes(message) {
    return Buffer.byteLength(wireFrame(message));
}

function addEntityComponent(groups, section, componentName, uuid, value) {
    const group = groups.get(componentName);
    let entity = group[section].get(uuid);
    if (!entity) {
        entity = section === 'state'
            ? { components: [] }
            : { componentDeltas: [] };
        group[section].set(uuid, entity);
    }
    entity[section === 'state' ? 'components' : 'componentDeltas']
        .push([componentName, value]);
}

function materializeMessage(groups, throughIndex, sentAt) {
    const stateByEntity = new Map();
    const deltaByEntity = new Map();
    const movementUuids = new Set();
    for (let index = 0; index <= throughIndex; index++) {
        const [componentName, group] = [...groups][index];
        for (const [uuid, entity] of group.state) {
            const target = stateByEntity.get(uuid) ?? { components: [] };
            target.components.push(...entity.components);
            stateByEntity.set(uuid, target);
        }
        for (const [uuid, entity] of group.delta) {
            const target = deltaByEntity.get(uuid) ?? { componentDeltas: [] };
            target.componentDeltas.push(...entity.componentDeltas);
            deltaByEntity.set(uuid, target);
        }
        if (componentName === 'MovementState') {
            for (const uuid of [...group.state.keys(), ...group.delta.keys()]) {
                movementUuids.add(uuid);
            }
        }
    }
    return {
        ...(stateByEntity.size > 0 ? { state: [...stateByEntity] } : {}),
        ...(deltaByEntity.size > 0 ? { delta: [...deltaByEntity] } : {}),
        ...(movementUuids.size > 0 ? {
            movementTimestamps: [...movementUuids].map(uuid => [uuid, sentAt]),
            movementSequences: [...movementUuids].map(
                (uuid, index) => [uuid, sentAt * SHIP_COUNT + index]),
        } : {}),
        sentAt,
    };
}

function simulate(mode) {
    const ships = makeShips();
    const lastMovement = new Map();
    const bytesByComponent = new Map(
        COMPONENT_ORDER.map(name => [name, 0]));
    let envelopeBytes = 0;
    let totalBytes = 0;
    let framesSent = 0;

    for (let frame = 0; frame < DURATION_SECONDS * FPS; frame++) {
        const groups = new Map(COMPONENT_ORDER.map(name => [name, {
            state: new Map(),
            delta: new Map(),
        }]));
        const visibleShips = mode === 'optimized'
            ? ships.filter(inInterest)
            : ships;

        if (frame === 0) {
            for (const ship of visibleShips) {
                for (const [componentName, value] of fullComponents(ship, mode)) {
                    addEntityComponent(
                        groups, 'state', componentName, ship.uuid, value);
                }
                lastMovement.set(
                    ship.uuid,
                    mode !== 'baseline'
                        ? quantizedMovement(movementState(ship))
                        : movementState(ship),
                );
            }
        } else {
            const movementTick = frame % MOVEMENT_INTERVAL_FRAMES === 0;
            if (movementTick) {
                for (const ship of visibleShips) {
                    const current = mode !== 'baseline'
                        ? quantizedMovement(movementState(ship))
                        : movementState(ship);
                    const value = mode !== 'baseline'
                        ? movementDelta(lastMovement.get(ship.uuid), current)
                        : current;
                    if (Object.keys(value).length > 0) {
                        addEntityComponent(
                            groups, 'delta', 'MovementState', ship.uuid, value);
                    }
                    lastMovement.set(ship.uuid, current);
                }
            }

            if (frame % 30 === 0) {
                for (const ship of visibleShips.filter((_, index) => index < 10)) {
                    addEntityComponent(groups, 'delta', 'WeaponsStateComponent',
                        ship.uuid, [['nova:1000', {
                            count: 2,
                            firing: frame % 60 === 0,
                            target: ship.target,
                        }]]);
                }
            }
            if (frame % 15 === 0) {
                for (const ship of visibleShips.filter((_, index) => index < 8)) {
                    ship.shield = Math.max(0, ship.shield - 0.75);
                    addEntityComponent(groups, 'delta', 'Shield', ship.uuid,
                        [[{
                            op: 'replace',
                            path: ['current'],
                            value: ship.shield,
                        }], []]);
                }
            }
        }

        for (const ship of ships) {
            ship.position.x += ship.velocity.x / FPS;
            ship.position.y += ship.velocity.y / FPS;
            ship.rotation += ship.turning / FPS;
        }

        const hasPayload = [...groups.values()].some(
            group => group.state.size > 0 || group.delta.size > 0);
        if (!hasPayload) {
            continue;
        }

        const sentAt = frame * 1000 / FPS;
        let previousBytes = encodedBytes({ sentAt });
        envelopeBytes += previousBytes;
        for (let index = 0; index < COMPONENT_ORDER.length; index++) {
            const message = materializeMessage(groups, index, sentAt);
            const currentBytes = encodedBytes(message);
            bytesByComponent.set(
                COMPONENT_ORDER[index],
                bytesByComponent.get(COMPONENT_ORDER[index])
                    + currentBytes - previousBytes,
            );
            previousBytes = currentBytes;
        }
        totalBytes += previousBytes;
        framesSent++;
    }

    return {
        mode,
        scene: {
            durationSeconds: DURATION_SECONDS,
            ships: SHIP_COUNT,
            shipsInsideInterest: makeShips().filter(inInterest).length,
            serverHz: FPS,
            movementSnapshotHz: FPS / MOVEMENT_INTERVAL_FRAMES,
            interestRadius: mode === 'optimized' ? INTEREST_RADIUS : null,
        },
        bytesPerSecond: totalBytes / DURATION_SECONDS,
        totalBytes,
        framesSent,
        breakdown: Object.fromEntries([
            ['Protocol envelopes', envelopeBytes / DURATION_SECONDS],
            ...[...bytesByComponent].map(
                ([name, bytes]) => [name, bytes / DURATION_SECONDS]),
        ]),
    };
}

function print(result) {
    console.log(`${result.mode}: ${result.bytesPerSecond.toFixed(1)} bytes/s `
        + `(${(result.bytesPerSecond * 8 / 1000).toFixed(1)} kbit/s)`);
    for (const [name, bytes] of Object.entries(result.breakdown)
        .sort((a, b) => b[1] - a[1])) {
        console.log(`  ${name.padEnd(24)} ${bytes.toFixed(1)} bytes/s`);
    }
}

const requestedMode = process.argv[2] ?? 'compare';
if (!['baseline', 'quantized', 'optimized', 'compare', '--json']
    .includes(requestedMode)) {
    console.error('Usage: node scripts/netcode_bandwidth.mjs '
        + '[baseline|quantized|optimized|compare|--json]');
    process.exitCode = 1;
} else {
    const baseline = simulate('baseline');
    const quantized = simulate('quantized');
    const optimized = simulate('optimized');
    if (requestedMode === '--json') {
        console.log(JSON.stringify({ baseline, quantized, optimized }, null, 2));
    } else if (requestedMode === 'baseline') {
        print(baseline);
    } else if (requestedMode === 'quantized') {
        print(quantized);
    } else if (requestedMode === 'optimized') {
        print(optimized);
    } else {
        print(baseline);
        print(quantized);
        print(optimized);
        const reduction =
            (1 - optimized.bytesPerSecond / baseline.bytesPerSecond) * 100;
        console.log(`reduction: ${reduction.toFixed(1)}%`);
    }
}
