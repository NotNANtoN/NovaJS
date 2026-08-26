import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import {
    DeltaPlugin,
} from 'nova_ecs/plugins/delta_plugin';
import {
    MovementPhysicsComponent,
    MovementStateComponent,
    MovementType,
} from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { World } from 'nova_ecs/world';
import { PlatformResource } from './platform_plugin';
import { DestructionStartedComponent } from './destruction_state';
import {
    FleetMemberComponent,
    FleetPlugin,
    FleetJumpRelaySystem,
} from './fleet_plugin';
import { InitiateJumpEvent } from './jump_plugin';
import { TargetComponent } from './target_component';

function movementAt(x: number, y: number) {
    return {
        accelerating: 0,
        position: new Position(x, y),
        rotation: new Angle(0),
        turnBack: false,
        turning: 0,
        velocity: new Vector(0, 0),
    };
}

const physics = {
    acceleration: 10,
    maxVelocity: 100,
    movementType: MovementType.INERTIAL,
    turnRate: 1,
};

function fleetMember(
    fleetId: string,
    role: 'leader' | 'escort',
    leaderUuid: string,
    slot: number,
) {
    return { fleetId, leaderUuid, role, slot };
}

async function fleetWorld(): Promise<World> {
    const world = new World('fleet-plugin-test');
    world.resources.set(PlatformResource, 'node');
    await world.addPlugin(DeltaPlugin);
    await world.addPlugin(FleetPlugin);
    return world;
}

describe('FleetPlugin', () => {
    it('copies a live leader target to an escort on the server', async () => {
        const world = await fleetWorld();
        const leader = new Entity()
            .addComponent(FleetMemberComponent,
                fleetMember('fleet-1', 'leader', 'leader', -1))
            .addComponent(TargetComponent, { target: 'enemy' })
            .addComponent(MultiplayerData, { owner: 'server' });
        const escort = new Entity()
            .addComponent(FleetMemberComponent,
                fleetMember('fleet-1', 'escort', 'leader', 0))
            .addComponent(TargetComponent, { target: undefined })
            .addComponent(MultiplayerData, { owner: 'server' });
        world.entities.set('leader', leader);
        world.entities.set('escort', escort);
        world.entities.set('enemy', new Entity());

        world.step();

        expect(escort.components.get(TargetComponent)).toEqual({
            target: 'enemy',
        });
    });

    it('releases an escort when its leader is destroyed', async () => {
        const world = await fleetWorld();
        const leader = new Entity()
            .addComponent(FleetMemberComponent,
                fleetMember('fleet-1', 'leader', 'leader', -1))
            .addComponent(TargetComponent, { target: 'enemy' })
            .addComponent(MultiplayerData, { owner: 'server' });
        const escort = new Entity()
            .addComponent(FleetMemberComponent,
                fleetMember('fleet-1', 'escort', 'leader', 0))
            .addComponent(TargetComponent, { target: undefined })
            .addComponent(MultiplayerData, { owner: 'server' });
        world.entities.set('leader', leader);
        world.entities.set('escort', escort);
        world.entities.set('enemy', new Entity());

        world.step();
        expect(escort.components.get(TargetComponent)?.target)
            .toBe('enemy');

        leader.components.set(DestructionStartedComponent, true);
        world.step();

        expect(escort.components.has(FleetMemberComponent)).toBeFalse();
        expect(escort.components.get(TargetComponent)?.target)
            .toBeUndefined();
    });

    it('commands an idle escort toward its deterministic formation slot', async () => {
        const world = await fleetWorld();
        const leader = new Entity()
            .addComponent(FleetMemberComponent,
                fleetMember('fleet-1', 'leader', 'leader', -1))
            .addComponent(TargetComponent, { target: undefined })
            .addComponent(MultiplayerData, { owner: 'server' })
            .addComponent(MovementStateComponent, movementAt(0, 0));
        const escort = new Entity()
            .addComponent(FleetMemberComponent,
                fleetMember('fleet-1', 'escort', 'leader', 0))
            .addComponent(TargetComponent, { target: undefined })
            .addComponent(MultiplayerData, { owner: 'server' })
            .addComponent(MovementStateComponent, movementAt(0, 0))
            .addComponent(MovementPhysicsComponent, physics);
        world.entities.set('leader', leader);
        world.entities.set('escort', escort);

        world.step();

        const movement = escort.components.get(MovementStateComponent)!;
        expect(movement.turnTo).toEqual(jasmine.any(Angle));
        // The leader faces +x, so slot 0 sits behind it and to one side: back
        // along -x and offset along -y, three quarters of a turn away.
        expect((movement.turnTo as Angle).angle)
            .toBeCloseTo(-3 * Math.PI / 4);
        // Its station is most of a turn away, so it turns before burning
        // rather than accelerating away from where it is meant to be.
        expect(movement.accelerating).toBe(0);
    });

    it('relays a leader jump to every escort in the same fleet', async () => {
        const world = await fleetWorld();
        const leader = new Entity()
            .addComponent(FleetMemberComponent,
                fleetMember('fleet-1', 'leader', 'leader', -1))
            .addComponent(MultiplayerData, { owner: 'server' });
        const escort = new Entity()
            .addComponent(FleetMemberComponent,
                fleetMember('fleet-1', 'escort', 'leader', 0))
            .addComponent(MultiplayerData, { owner: 'server' });
        const otherEscort = new Entity()
            .addComponent(FleetMemberComponent,
                fleetMember('fleet-2', 'escort', 'other-leader', 0))
            .addComponent(MultiplayerData, { owner: 'server' });
        world.entities.set('leader', leader);
        world.entities.set('escort', escort);
        world.entities.set('other-escort', otherEscort);

        const emissions: string[][] = [];
        FleetJumpRelaySystem.step(
            { to: 'nova:next' },
            leader.components.get(FleetMemberComponent)!,
            world.entities,
            'leader',
            (_event, _data, targets) => emissions.push(
                (targets ?? []).map(target =>
                    typeof target === 'string' ? target : target.uuid)),
            { owner: 'server' },
            'node',
        );

        expect(emissions).toEqual([['escort']]);
        expect(InitiateJumpEvent.name).toBe('InitiateJumpEvent');
    });
});
