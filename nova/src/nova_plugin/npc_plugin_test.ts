import 'jasmine';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import {
    advanceMovementState,
    MovementPhysics,
    MovementPhysicsComponent,
    MovementStateComponent,
    MovementType,
} from 'nova_ecs/plugins/movement_plugin';
import { GameDataResource } from './game_data_resource';
import { PlatformResource } from './platform_plugin';
import {
    DEFAULT_COMBAT_STANDOFF,
    FollowAI,
    FollowComponent,
    getCombatStandoff,
    ShootAllWeaponsAI,
    ShootAllWeaponsComponent,
} from './npc_plugin';
import { TargetComponent } from './target_component';
import { WeaponsStateComponent } from './weapons_state';
import { DestructionStartedComponent } from './destruction_state';

const COMBAT_PHYSICS: MovementPhysics = {
    acceleration: 200,
    maxVelocity: 400,
    movementType: MovementType.INERTIAL,
    turnRate: 3,
};

function movementAt(x: number, y: number, rotation = 0) {
    return {
        accelerating: 0,
        position: new Position(x, y),
        rotation: new Angle(rotation),
        turnBack: false,
        turning: 0,
        velocity: new Vector(0, 0),
    };
}

const projectileGameData = {
    data: {
        Weapon: {
            getCached: (id: string) => id === 'gun' ? {
                type: 'ProjectileWeaponData',
                fireGroup: 'primary',
                physics: { speed: 500 },
                shotDuration: 2_000,
            } : undefined,
        },
    },
} as never;

function makeFollowWorld(withWeapon = true) {
    const world = new World('npc-follow-test');
    world.resources.set(PlatformResource, 'node');
    world.resources.set(GameDataResource, projectileGameData);
    world.addSystem(FollowAI);

    const target = new Entity('target')
        .addComponent(MovementStateComponent, movementAt(0, 0));
    const npc = new Entity('npc')
        .addComponent(MovementStateComponent, movementAt(-2_000, 0))
        .addComponent(MovementPhysicsComponent, COMBAT_PHYSICS)
        .addComponent(TargetComponent, { target: 'target' })
        .addComponent(FollowComponent, undefined)
        .addComponent(MultiplayerData, { owner: 'server' });
    if (withWeapon) {
        npc.addComponent(WeaponsStateComponent, new Map([
            ['gun', { count: 1, firing: true }],
        ]));
    }
    world.entities.set('target', target);
    world.entities.set('npc', npc);
    return { world, npc, target };
}

function fly(world: World, npc: Entity, steps: number) {
    let closest = Infinity;
    for (let step = 0; step < steps; step++) {
        world.step();
        const movement = npc.components.get(MovementStateComponent)!;
        Object.assign(movement, advanceMovementState(
            movement,
            COMBAT_PHYSICS,
            1 / 60,
            world.entities,
        ));
        const target = world.entities.get('target')!
            .components.get(MovementStateComponent)!;
        closest = Math.min(
            closest,
            target.position.subtract(movement.position).length,
        );
    }
    return closest;
}

describe('NPC combat flying', () => {
    it('uses a conservative fraction of cached weapon range', () => {
        const weapons = new Map([
            ['gun', { count: 1, firing: true }],
        ]);
        expect(getCombatStandoff(weapons, projectileGameData)).toBe(600);
        expect(getCombatStandoff(undefined, projectileGameData))
            .toBe(DEFAULT_COMBAT_STANDOFF);
    });

    it('closes into weapon range without ramming and settles there', () => {
        const { world, npc, target } = makeFollowWorld();
        const closest = fly(world, npc, 3_000);
        const movement = npc.components.get(MovementStateComponent)!;
        const targetMovement = target.components.get(MovementStateComponent)!;

        expect(targetMovement.position.subtract(movement.position).length)
            .toBeGreaterThan(500);
        expect(targetMovement.position.subtract(movement.position).length)
            .toBeLessThan(700);
        expect(movement.velocity.length).toBeLessThan(20);
        expect(closest).toBeGreaterThan(450);
    });

    it('falls back to a close combat distance without weapon data', () => {
        const { world, npc, target } = makeFollowWorld(false);
        fly(world, npc, 3_000);
        const movement = npc.components.get(MovementStateComponent)!;
        const targetMovement = target.components.get(MovementStateComponent)!;

        expect(targetMovement.position.subtract(movement.position).length)
            .toBeGreaterThan(DEFAULT_COMBAT_STANDOFF - 100);
        expect(targetMovement.position.subtract(movement.position).length)
            .toBeLessThan(DEFAULT_COMBAT_STANDOFF + 100);
        expect(movement.velocity.length).toBeLessThan(30);
    });

    it('does not thrust while its nose is pointed away from the target', () => {
        const { world, npc } = makeFollowWorld();
        world.step();

        const movement = npc.components.get(MovementStateComponent)!;
        expect(movement.accelerating).toBe(0);
        expect(movement.turnTo).toEqual(new Angle(Math.PI / 2));
    });
});

describe('NPC destruction lockout', () => {
    it('clears NPC firing instead of restarting it after death begins', () => {
        const world = new World('npc-destruction-lock-test');
        world.resources.set(PlatformResource, 'node');
        world.resources.set(GameDataResource, {
            data: {
                Weapon: {
                    getCached: () => ({ type: 'ProjectileWeaponData' }),
                },
            },
        } as never);
        world.addSystem(ShootAllWeaponsAI);

        const weapon = { count: 1, firing: true, target: 'player' };
        world.entities.set('player', new Entity('player'));
        world.entities.set('npc', new Entity('npc')
            .addComponent(WeaponsStateComponent, new Map([
                ['weapon', weapon],
            ]))
            .addComponent(TargetComponent, { target: 'player' })
            .addComponent(ShootAllWeaponsComponent, undefined)
            .addComponent(MultiplayerData, { owner: 'server' })
            .addComponent(DestructionStartedComponent, true));

        world.step();

        expect(weapon.firing).toBeFalse();
        expect(weapon.target).toBeUndefined();
    });
});
