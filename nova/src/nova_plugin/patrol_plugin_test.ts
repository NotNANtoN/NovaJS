import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import {
    MovementPhysicsComponent,
    MovementState,
    MovementStateComponent,
    MovementType,
} from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { World } from 'nova_ecs/world';
import {
    NpcFleeComponent,
} from './npc_plugin';
import {
    NpcCombatRoleComponent,
} from './npc_components';
import { ArmorComponent } from './health_plugin';
import { DisabledComponent } from './death_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { JumpStateComponent } from './jump_plugin';
import { PlatformResource } from './platform_plugin';
import { Stat } from './stat';
import { TargetComponent } from './target_component';
import {
    PatrolComponent,
    PatrolPlugin,
} from './patrol_plugin';

const physics = {
    acceleration: 100,
    maxVelocity: 300,
    movementType: MovementType.INERTIAL,
    turnRate: 2,
};

function movementAt(
    x: number,
    y: number,
    heading = Math.PI / 2,
): MovementState {
    return {
        accelerating: 0,
        position: new Position(x, y),
        rotation: new Angle(heading),
        turnBack: false,
        turning: 0,
        velocity: new Vector(0, 0),
    };
}

function makePatroller(
    name: string,
    role: 'military' | 'civilian' = 'military',
): Entity {
    return new Entity(name)
        .addComponent(PatrolComponent, {
            guardPost: [0, 0],
            radius: 900,
        })
        .addComponent(NpcCombatRoleComponent, role)
        .addComponent(MovementStateComponent, movementAt(0, -900))
        .addComponent(MovementPhysicsComponent, physics)
        .addComponent(MultiplayerData, { owner: 'server' });
}

async function patrolWorld(platform: 'node' | 'browser' = 'node') {
    const world = new World('patrol-plugin-test');
    world.resources.set(PlatformResource, platform);
    await world.addPlugin(PatrolPlugin);
    return world;
}

describe('PatrolPlugin', () => {
    it('drives a military ship toward its next guard-ring waypoint', async () => {
        const world = await patrolWorld();
        const patroller = makePatroller('patroller');
        world.entities.set('patroller', patroller);

        world.step();

        const patrol = patroller.components.get(PatrolComponent)!;
        const movement = patroller.components.get(MovementStateComponent)!;
        expect(patrol.waypoint).toBeDefined();
        expect(movement.turnTo).toEqual(jasmine.any(Angle));
        expect(movement.accelerating).toBe(1);
    });

    it('advances the circuit after reaching a waypoint at low speed', async () => {
        const world = await patrolWorld();
        const patroller = makePatroller('patroller');
        patroller.components.set(PatrolComponent, {
            guardPost: [0, 0],
            radius: 900,
            waypoint: [0, -900],
            direction: 1,
        });
        world.entities.set('patroller', patroller);

        world.step();

        expect(patroller.components.get(PatrolComponent)?.waypoint)
            .toEqual([
                jasmine.any(Number),
                jasmine.any(Number),
            ]);
        expect(patroller.components.get(PatrolComponent)?.waypoint?.[0])
            .toBeCloseTo(Math.sin(Math.PI / 3) * 900, 6);
    });

    it('does not let a civilian use the military patrol marker', async () => {
        const world = await patrolWorld();
        const civilian = makePatroller('civilian', 'civilian');
        world.entities.set('civilian', civilian);

        world.step();

        expect(civilian.components.get(PatrolComponent)?.waypoint)
            .toBeUndefined();
    });

    it('suspends patrol during combat, retreat, jumping, and disablement',
        async () => {
            const world = await patrolWorld();
            const fighting = makePatroller('fighting');
            fighting.components.set(
                // A live target is the same combat boundary used by NPC
                // traffic and must remain authoritative here.
                TargetComponent,
                { target: 'enemy' },
            );
            const fleeing = makePatroller('fleeing');
            fleeing.components.set(NpcFleeComponent, {
                threat: 'enemy',
                distance: 300,
                reason: 'attacked',
            } as const);
            const jumping = makePatroller('jumping');
            jumping.components.set(JumpStateComponent, {
                from: 'nova:test',
                to: 'nova:next',
                phase: 'departing',
                phaseStartedAt: 0,
                transitionAt: 1,
                requiresAdjacency: true,
                arrivalSoundPending: false,
            } as const);
            const disabled = makePatroller('disabled');
            disabled.components.set(DisabledComponent, true);
            const destroyed = makePatroller('destroyed');
            destroyed.components.set(DestructionStartedComponent, true);
            const armorless = makePatroller('armorless');
            armorless.components.set(ArmorComponent, new Stat({
                current: 0,
                max: 100,
                min: 0,
                recharge: 0,
            }));

            for (const entity of [
                fighting, fleeing, jumping, disabled, destroyed, armorless,
            ]) {
                world.entities.set(entity.uuid, entity);
            }
            world.entities.set('enemy', new Entity('enemy'));

            world.step();

            for (const entity of [
                fighting, fleeing, jumping, disabled, destroyed, armorless,
            ]) {
                expect(entity.components.get(PatrolComponent)?.waypoint)
                    .withContext(entity.name ?? entity.uuid)
                    .toBeUndefined();
            }
        });

    it('does not author movement for a non-server owner or browser world',
        async () => {
            const serverWorld = await patrolWorld();
            const clientOwned = makePatroller('client-owned');
            clientOwned.components.set(
                MultiplayerData, { owner: 'client' });
            serverWorld.entities.set('client-owned', clientOwned);
            serverWorld.step();
            expect(clientOwned.components.get(PatrolComponent)?.waypoint)
                .toBeUndefined();

            const browserWorld = await patrolWorld('browser');
            const browserPatroller = makePatroller('browser-patroller');
            browserWorld.entities.set('browser-patroller', browserPatroller);
            browserWorld.step();
            expect(browserPatroller.components.get(PatrolComponent)?.waypoint)
                .toBeUndefined();
        });
});
