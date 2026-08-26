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
    combatOddsAreFavorable,
    FollowAI,
    FollowComponent,
    getCombatStandoff,
    isInterceptorPiracyTarget,
    RETREAT_SHIELD_FRACTION,
    shieldScaledStrength,
    shouldFleeFromAttacker,
    shouldWarshipRetreat,
    ShootAllWeaponsAI,
    ShootAllWeaponsComponent,
} from './npc_plugin';
import { getShipAIProfile } from './ship_ai_profile';
import { TargetComponent } from './target_component';
import { WeaponsStateComponent } from './weapons_state';
import { DestructionStartedComponent } from './destruction_state';
import { GovernmentFlags } from './govt_relations';
import {
    createProvocationState,
    recordProvocation,
} from './npc_hostility';

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

const rangedWeaponGameData = {
    data: {
        Weapon: {
            getCached: (id: string) => ({
                short: {
                    type: 'ProjectileWeaponData',
                    fireGroup: 'primary',
                    guidance: 'unguided',
                    physics: { speed: 100 },
                    shotDuration: 1_000,
                },
                long: {
                    type: 'ProjectileWeaponData',
                    fireGroup: 'primary',
                    guidance: 'unguided',
                    physics: { speed: 100 },
                    shotDuration: 10_000,
                },
                pointDefense: {
                    type: 'ProjectileWeaponData',
                    fireGroup: 'primary',
                    guidance: 'pointDefense',
                    physics: { speed: 100 },
                    shotDuration: 100,
                },
            }[id]),
        },
    },
} as never;

describe('NPC combat decisions', () => {
    it('scales Strength linearly from 30% to 100% with present shields', () => {
        expect(shieldScaledStrength({
            strength: 1_000,
            shield: { current: 100, max: 100 },
        })).toBe(1_000);
        expect(shieldScaledStrength({
            strength: 1_000,
            shield: { current: 50, max: 100 },
        })).toBeCloseTo(650, 8);
        expect(shieldScaledStrength({
            strength: 1_000,
            shield: { current: 0, max: 100 },
        })).toBe(300);
    });

    it('interprets MaxOdds 100 as one-to-one and 200 as two-to-one', () => {
        const friend = [{ strength: 100 }];
        expect(combatOddsAreFavorable(
            friend, [{ strength: 100 }], 100)).toBeTrue();
        expect(combatOddsAreFavorable(
            friend, [{ strength: 101 }], 100)).toBeFalse();
        expect(combatOddsAreFavorable(
            friend, [{ strength: 200 }], 200)).toBeTrue();
        expect(combatOddsAreFavorable(
            friend, [{ strength: 201 }], 200)).toBeFalse();
    });

    it('retreats only flag-bearing warships strictly below 25% shields', () => {
        const warship = getShipAIProfile({ inherentAI: 3 });
        const interceptor = getShipAIProfile({ inherentAI: 4 });
        const retreating = { flags: GovernmentFlags.warshipsRetreat };
        const doomed = { flags: 0 };

        expect(RETREAT_SHIELD_FRACTION).toBe(0.25);
        expect(shouldWarshipRetreat(
            warship, retreating, { current: 24.9, max: 100 })).toBeTrue();
        expect(shouldWarshipRetreat(
            warship, retreating, { current: 25, max: 100 })).toBeFalse();
        expect(shouldWarshipRetreat(
            warship, doomed, { current: 0, max: 100 })).toBeFalse();
        expect(shouldWarshipRetreat(
            interceptor, retreating, { current: 0, max: 100 })).toBeFalse();
    });

    it('distinguishes wimpy and brave trader break-off rules', () => {
        const wimpy = getShipAIProfile({ inherentAI: 1 });
        const brave = getShipAIProfile({ inherentAI: 2 });
        expect(shouldFleeFromAttacker(wimpy, true, 10, 500)).toBeTrue();
        expect(shouldFleeFromAttacker(wimpy, false, 10, 500)).toBeFalse();
        expect(shouldFleeFromAttacker(brave, true, 500, 500)).toBeFalse();
        expect(shouldFleeFromAttacker(brave, true, 501, 500)).toBeTrue();
    });

    it('lets interceptors police attacks on neutral but not enemy ships',
        () => {
            const state = createProvocationState();
            recordProvocation(state, 129, 'pirate');

            expect(isInterceptorPiracyTarget(
                state, 128, 'pirate', () => 'neutral')).toBeTrue();
            expect(isInterceptorPiracyTarget(
                state, 128, 'pirate', () => 'enemy')).toBeFalse();
            expect(isInterceptorPiracyTarget(
                state, 128, 'bystander', () => 'neutral')).toBeFalse();
        });
});

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

function makeShootWorld(targetDistance: number, weaponIds: string[]) {
    const world = new World('npc-shoot-test');
    world.resources.set(PlatformResource, 'node');
    world.resources.set(GameDataResource, rangedWeaponGameData);
    world.addSystem(ShootAllWeaponsAI);

    const weapons = new Map<string, { count: number, firing: boolean }>();
    for (const id of weaponIds) {
        weapons.set(id, { count: 1, firing: false });
    }
    const target = new Entity('target')
        .addComponent(MovementStateComponent, movementAt(targetDistance, 0));
    const npc = new Entity('npc')
        .addComponent(MovementStateComponent, movementAt(0, 0))
        .addComponent(WeaponsStateComponent, weapons)
        .addComponent(TargetComponent, { target: 'target' })
        .addComponent(ShootAllWeaponsComponent, undefined)
        .addComponent(MultiplayerData, { owner: 'server' });
    world.entities.set('target', target);
    world.entities.set('npc', npc);
    return { world, weapons };
}

describe('NPC weapon firing ranges', () => {
    it('fires only weapons whose range reaches the target', () => {
        const { world, weapons } = makeShootWorld(500, ['short', 'long']);

        world.step();

        expect(weapons.get('short')!.firing).toBeFalse();
        expect(weapons.get('long')!.firing).toBeTrue();
    });

    it('fires all weapons when the target is inside both ranges', () => {
        const { world, weapons } = makeShootWorld(50, ['short', 'long']);

        world.step();

        expect(weapons.get('short')!.firing).toBeTrue();
        expect(weapons.get('long')!.firing).toBeTrue();
    });

    it('leaves point-defense firing independent of NPC weapon range', () => {
        const { world, weapons } = makeShootWorld(500, ['pointDefense']);

        world.step();

        expect(weapons.get('pointDefense')!.firing).toBeTrue();
    });
});

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

    it('lets an interceptor hull close further than a freighter', () => {
        const weapons = new Map([
            ['gun', { count: 1, firing: true }],
        ]);
        const interceptor = getShipAIProfile({ inherentAI: 4 });
        const freighter = getShipAIProfile({ inherentAI: 1 });
        const closer = getCombatStandoff(
            weapons, projectileGameData,
            interceptor.weaponStandoffMultiplier);
        const farther = getCombatStandoff(
            weapons, projectileGameData, freighter.weaponStandoffMultiplier);
        expect(closer).toBeLessThan(farther);
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
