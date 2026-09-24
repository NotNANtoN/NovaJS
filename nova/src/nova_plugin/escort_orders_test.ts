import 'jasmine';

/**
 * A captured or hired escort, flown by the real server systems while its
 * owner flies with input prediction: default/D keeps it with the flagship,
 * F sends it after the chosen target, V holds it where it is.
 */
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { MockGameData } from 'novadatainterface/MockGameData';
import { Position } from 'nova_ecs/datatypes/position';
import { DeterministicDelayedNetwork } from 'nova_ecs/plugins/delayed_network';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Comms, multiplayer, MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import { makeShip } from './make_ship';
import { makeSystem } from './make_system';
import { makeNpc } from './npc_plugin';
import { GovtComponent } from './npc_components';
import { PlatformResource } from './platform_plugin';
import { createInitialPlayerState, PlayerStateComponent } from './player_state';
import { EscortOrderComponent, HiredEscortComponent } from './escort_plugin';
import { TargetComponent } from './target_component';

const store = {
    ready: Promise.resolve(), getTokenForPeer: () => 'tok', get: async () => undefined,
    set: async () => undefined, save: async () => undefined, bindPeer() { },
    getSnapshots: async () => [],
} as any;

for (const inherentAI of [1, 3, 4]) it(`follows D/F/V orders over the network (inherentAI ${inherentAI})`, async () => {
    const network = new DeterministicDelayedNetwork({ delays: [40] });
    const gameData = new MockGameData();
    const original = gameData.data.Ship.get.bind(gameData.data.Ship);
    (gameData.data.Ship as any).get = async (id: string) => ({ ...(await original(id)), inherentAI });
    const server = makeSystem('nova:130', gameData, store);
    server.resources.set(PlatformResource, 'node');
    await server.addPlugin(multiplayer(network.connect('server')));
    server.resources.get(TimeResource)!.fixedDelta_ms = 1000 / 60;
    const client = makeSystem('nova:130', gameData);
    client.resources.set(PlatformResource, 'browser');
    await client.addPlugin(multiplayer(network.connect('pilot'), undefined, { inputPrediction: true }));
    client.resources.get(TimeResource)!.fixedDelta_ms = 1000 / 60;
    for (const w of [server, client]) w.singletonEntity.components.get(Comms)!.admins = new Set(['server']);

    const ship = makeShip({ ...getDefaultShipData(), id: 'nova:128', name: 'Shuttle' });
    const state = createInitialPlayerState();
    state.escorts = [{ id: 'capture-1', shipId: 'nova:128', dailyPay: 10 }];
    ship.components.set(PlayerStateComponent, state);
    ship.components.set(MultiplayerData, { owner: 'pilot' });
    client.entities.set('player', ship);

    const step = async () => { client.step(); server.step(); network.advance(); await new Promise(r => setTimeout(r, 0)); };
    const escortEntry = () => [...server.entities].find(([, e]) => e.components.has(HiredEscortComponent))!;
    const dist = (w: World, a: string, b: string) => {
        const pa = w.entities.get(a)!.components.get(MovementStateComponent)!.position;
        const pb = w.entities.get(b)!.components.get(MovementStateComponent)!.position;
        return pa.subtract(pb).length;
    };

    // Fly around: the escort must stay with the player (default: defend).
    for (let i = 0; i < 600; i++) {
        const p = client.entities.get('player')?.components.get(MovementStateComponent);
        if (p) { p.accelerating = i % 200 < 120 ? 1 : 0; p.turning = i % 120 < 25 ? 1 : 0; }
        await step();
    }
    const [escortId] = escortEntry();
    expect(dist(server, escortId, 'player')).toBeLessThan(450);

    // A hostile NPC far away attacking nobody: defend must NOT chase it.
    const enemyShip = await gameData.data.Ship.get('nova:128');
    const enemy = makeNpc(enemyShip);
    enemy.components.set(MultiplayerData, { owner: 'server' });
    enemy.components.set(GovtComponent, { id: 128 });
    const playerPos = server.entities.get('player')!.components.get(MovementStateComponent)!.position;
    enemy.components.get(MovementStateComponent)!.position = new Position(playerPos.x + 3000, playerPos.y);
    server.entities.set('enemy', enemy);
    const enemyAt = new Position(playerPos.x + 3000, playerPos.y);
    // A stationary target, so the attack test measures pursuit, not a race.
    const pinEnemy = () => {
        const m = server.entities.get('enemy')?.components.get(MovementStateComponent);
        if (m) { m.position = enemyAt; m.velocity = new Vector(0, 0); }
    };
    const stepAll = step;
    const stepPinned = async () => { pinEnemy(); await stepAll(); };
    for (let i = 0; i < 120; i++) {
        const p = client.entities.get('player')!.components.get(MovementStateComponent)!;
        p.accelerating = 0; p.turning = 0;
        await stepPinned();
    }
    expect(escortEntry()[1].components.get(TargetComponent)?.target).toBeUndefined();

    // F: attack the chosen target.
    client.entities.get('player')!.components.set(EscortOrderComponent, { mode: 'attack', sequence: 1, targetUuid: 'enemy' });
    for (let i = 0; i < 60; i++) await stepPinned();
    expect(escortEntry()[1].components.get(TargetComponent)?.target).toBe('enemy');
    // The enemy wanders at the same top speed, so the escort may not close
    // fast; it must pursue (head toward it) rather than stay in formation.
    const startToEnemy = dist(server, escortId, 'enemy');
    let closest = startToEnemy;
    for (let i = 0; i < 1200; i++) {
        await stepPinned();
        closest = Math.min(closest, dist(server, escortId, 'enemy'));
    }

    expect(escortEntry()[1].components.get(TargetComponent)?.target).toBe('enemy');
    expect(closest).toBeLessThan(700);

    // V: hold position where the escort is.
    client.entities.get('player')!.components.set(EscortOrderComponent, { mode: 'hold', sequence: 2 });
    for (let i = 0; i < 30; i++) await step();
    const held = escortEntry()[1].components.get(MovementStateComponent)!.position;
    const heldAt = new Position(held.x, held.y);
    for (let i = 0; i < 300; i++) {
        const p = client.entities.get('player')!.components.get(MovementStateComponent)!;
        // Fly away, then brake to a stop so the rejoin below is measurable.
        p.accelerating = i < 90 ? 1 : 0;
        p.turnBack = i >= 90;
        p.accelerating = i >= 90 && p.velocity.length > 5 ? 1 : p.accelerating;
        await step();
    }
    expect(escortEntry()[1].components.get(TargetComponent)?.target).toBeUndefined();
    expect(escortEntry()[1].components.get(MovementStateComponent)!.position.subtract(heldAt).length).toBeLessThan(250);

    // D: back to defending, it rejoins the player.
    client.entities.get('player')!.components.set(EscortOrderComponent, { mode: 'defend', sequence: 3 });
    for (let i = 0; i < 3000; i++) {
        const p = client.entities.get('player')!.components.get(MovementStateComponent)!;
        p.turnBack = true;
        p.accelerating = p.velocity.length > 5 ? 1 : 0;
        await step();
    }
    expect(dist(server, escortId, 'player')).toBeLessThan(450);
}, 120_000);
