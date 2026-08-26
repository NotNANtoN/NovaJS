import 'jasmine';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { Entity } from 'nova_ecs/entity';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import {
    MovementPhysics,
    MovementPhysicsComponent,
    MovementState,
    MovementStateComponent,
    MovementType,
} from 'nova_ecs/plugins/movement_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import {
    FinishJumpEvent,
    InitiateJumpEvent,
} from './jump_plugin';
import { EntityBudgetResource, createEntityBudget } from './entity_budget';
import { GameDataResource } from './game_data_resource';
import {
    GovtComponent,
    NpcAIComponent,
} from './npc_plugin';
import {
    NpcTrafficComponent,
    NpcTrafficPlugin,
    NpcTrafficRandomResource,
    NpcTrafficResource,
} from './npc_traffic_plugin';
import {
    createArrivingTrafficState,
    NpcTrafficState,
} from './npc_traffic';
import { PlanetComponent } from './planet_plugin';
import { PlatformResource } from './platform_plugin';
import { ShipDataComponent } from './ship_plugin';
import { SystemIdResource } from './system_id_resource';
import { TargetComponent } from './target_component';

const TRAFFIC_PHYSICS: MovementPhysics = {
    acceleration: 200,
    maxVelocity: 400,
    movementType: MovementType.INERTIAL,
    turnRate: 3,
};

const time = {
    time: 0,
    delta_ms: 1_000 / 60,
    delta_s: 1 / 60,
    frame: 0,
};

function movementAt(x: number, y: number): MovementState {
    return {
        accelerating: 0,
        position: new Position(x, y),
        rotation: new Angle(0),
        turnBack: false,
        turning: 0,
        velocity: new Vector(0, 0),
    };
}

function traderData() {
    const data = getDefaultShipData();
    return {
        ...data,
        id: 'nova:128',
        name: 'Trader',
        inherentAI: 1,
        physics: {
            ...data.physics,
            acceleration: TRAFFIC_PHYSICS.acceleration,
            speed: TRAFFIC_PHYSICS.maxVelocity,
            turnRate: TRAFFIC_PHYSICS.turnRate,
        },
    };
}

function planetAt(
    uuid: string,
    id: string,
    x: number,
): Entity {
    return new Entity(id)
        .addComponent(PlanetComponent, {
            id,
            name: id,
            canLand: true,
            inhabited: true,
        })
        .addComponent(MovementStateComponent, movementAt(x, 0));
}

function gameDataWithLinks() {
    const systems = new Map([
        ['nova:test', { links: ['nova:next'] }],
        ['nova:next', { links: [] }],
    ]);
    return {
        data: {
            System: {
                getCached: (id: string) => systems.get(id),
            },
        },
    } as never;
}

async function trafficWorld() {
    const world = new World('npc-traffic-test');
    world.resources.set(GameDataResource, gameDataWithLinks());
    world.resources.set(SystemIdResource, 'nova:test');
    world.resources.set(PlatformResource, 'node');
    world.resources.set(TimeResource, time);
    world.resources.set(
        EntityBudgetResource,
        createEntityBudget('modern'),
    );
    world.resources.set(NpcTrafficRandomResource, () => 0);
    await world.addPlugin(NpcTrafficPlugin);
    return world;
}

function makeTrader(
    state: NpcTrafficState,
    position = new Position(0, 0),
    target?: string,
): Entity {
    return new Entity('ambient trader')
        .addComponent(NpcAIComponent, undefined)
        .addComponent(NpcTrafficComponent, state)
        .addComponent(ShipDataComponent, traderData())
        .addComponent(GovtComponent, { id: 128 })
        .addComponent(MovementStateComponent, {
            ...movementAt(position.x, position.y),
            position,
        })
        .addComponent(MovementPhysicsComponent, TRAFFIC_PHYSICS)
        .addComponent(TargetComponent, { target })
        .addComponent(MultiplayerData, { owner: 'server' });
}

describe('NPC traffic ECS lifecycle', () => {
    beforeEach(() => {
        time.time = 0;
        time.frame = 0;
    });

    it('yields an errand to a live combat target', async () => {
        const world = await trafficWorld();
        world.entities.set('planet earth', planetAt(
            'planet earth', 'nova:128', 1_000));
        const trader = makeTrader({
            phase: 'travelling',
            destination: 'planet earth',
            readyAt: 0,
        }, new Position(0, 0), 'attacker');
        world.entities.set('trader', trader);
        world.entities.set('attacker', new Entity('attacker'));

        world.step();

        const movement = trader.components.get(MovementStateComponent)!;
        expect(movement.accelerating).toBe(0);
        expect(movement.turnTo).toBeUndefined();
        expect(trader.components.get(NpcTrafficComponent)?.phase)
            .toBe('travelling');
    });

    it('completes arrival, travel, landing, dwell, and launch', async () => {
        const world = await trafficWorld();
        world.entities.set('planet earth', planetAt(
            'planet earth', 'nova:128', 1_000));
        world.entities.set('planet zeta', planetAt(
            'planet zeta', 'nova:129', 3_000));
        const trader = makeTrader(createArrivingTrafficState());
        world.entities.set('trader', trader);

        world.step();

        const traffic = trader.components.get(NpcTrafficComponent)!;
        expect(traffic.phase).toBe('travelling');
        expect(traffic.destination).toBe('planet earth');

        const movement = trader.components.get(MovementStateComponent)!;
        movement.position = new Position(1_000, 0);
        time.time = 1_000;
        world.step();

        expect(world.entities.has('trader')).toBeFalse();
        const runtime = world.resources.get(NpcTrafficResource)!;
        expect(runtime.docked.size).toBe(1);
        const docked = [...runtime.docked.values()][0];
        expect(docked.stellarId).toBe('nova:128');
        expect(docked.launchAt).toBeGreaterThan(time.time);

        time.time = docked.launchAt;
        world.step();

        const launched = [...world.entities.values()].find(entity =>
            entity.components.has(NpcTrafficComponent));
        expect(launched).toBeDefined();
        expect(launched?.components.get(MultiplayerData))
            .toEqual({ owner: 'server' });
        expect(launched?.components.get(NpcTrafficComponent)?.phase)
            .toBe('travelling');
        expect(launched?.components.get(NpcTrafficComponent)?.destination)
            .toBe('planet zeta');
        expect(runtime.docked.size).toBe(0);
    });

    it('marks a traffic ship as arriving after a hyperspace transfer', async () => {
        const world = await trafficWorld();
        const trader = makeTrader({
            phase: 'departing',
            readyAt: 0,
        });
        world.entities.set('trader', trader);

        world.emitNow(FinishJumpEvent, {
            entity: trader,
            uuid: 'trader',
            from: 'nova:old',
            to: 'nova:test',
        });

        expect(trader.components.get(NpcTrafficComponent))
            .toEqual(createArrivingTrafficState());
    });

    it('starts a hyperspace departure when no usable stellar remains', async () => {
        const world = await trafficWorld();
        const trader = makeTrader(createArrivingTrafficState());
        world.entities.set('trader', trader);
        const departures: string[] = [];
        world.events.get(InitiateJumpEvent).subscribe(({ to }) =>
            departures.push(to));

        world.step();

        expect(trader.components.get(NpcTrafficComponent)?.phase)
            .toBe('departing');
        expect(departures).toEqual(['nova:next']);
    });
});
