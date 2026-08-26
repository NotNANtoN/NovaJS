import 'jasmine';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import {
    MovementPhysicsComponent,
    MovementPlugin,
    MovementStateComponent,
    MovementType,
} from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import {
    DamagedEvent,
    DeathPlugin,
    DisabledComponent,
} from './death_plugin';
import { DestructionStartedComponent } from './destruction_state';
import {
    disableArmorFraction,
    DISABLE_ARMOR_FRACTION,
    TOUGH_DISABLE_ARMOR_FRACTION,
    DisabledLifecycleComponent,
    DisabledPlugin,
} from './disabled_plugin';
import { ArmorComponent } from './health_plugin';
import { JumpState, JumpStateComponent } from './jump_plugin';
import { PlatformResource } from './platform_plugin';
import {
    ShipComponent,
    ShipDataComponent,
} from './ship_plugin';
import { Stat } from './stat';
import { WeaponsStateComponent } from './weapons_state';

const weaponDamage = (armor: number) => ({
    shield: 0,
    armor,
    ionization: 0,
    ionizationColor: 0,
    passThroughShield: 1,
    knockback: 0,
});

async function makeWorld() {
    const world = new World('disabled-test');
    world.resources.set(TimeResource, {
        time: 0,
        delta_ms: 1_000,
        delta_s: 1,
        frame: 0,
    });
    world.resources.set(PlatformResource, 'node');
    await world.addPlugin(DeltaPlugin);
    await world.addPlugin(MovementPlugin);
    await world.addPlugin(DeathPlugin);
    await world.addPlugin(DisabledPlugin);
    return world;
}

function combatShip(armor = 40) {
    const movement = {
        accelerating: 1,
        position: new Position(100, 200),
        rotation: new Angle(Math.PI / 3),
        turnBack: true,
        turning: 1,
        velocity: new Vector(12, -4),
        turnTo: new Angle(Math.PI),
    };
    return new Entity('ship')
        .addComponent(ShipComponent, { id: 'nova:128' })
        .addComponent(ShipDataComponent, {
            ...getDefaultShipData(),
            deathDelay: 1,
        })
        .addComponent(MultiplayerData, { owner: 'server' })
        .addComponent(ArmorComponent, new Stat({
            current: armor,
            max: 100,
            recharge: 0,
        }))
        .addComponent(MovementStateComponent, movement)
        .addComponent(MovementPhysicsComponent, {
            acceleration: 100,
            maxVelocity: 200,
            movementType: MovementType.INERTIALESS,
            turnRate: 2,
        })
        .addComponent(WeaponsStateComponent, new Map([
            ['laser', { count: 1, firing: true, target: 'attacker' }],
        ]))
        .addComponent(JumpStateComponent, {
            from: 'nova:1',
            to: 'nova:2',
            phase: 'spooling',
            phaseStartedAt: 0,
            transitionAt: 1_000,
            requiresAdjacency: false,
            arrivalSoundPending: false,
        } as JumpState);
}

describe('disabled ship lifecycle', () => {
    it('disables on the threshold-crossing blow and drifts without controls',
        async () => {
            const world = await makeWorld();
            const ship = combatShip();
            world.entities.set('ship', ship);

            world.emitNow(DamagedEvent, {
                damage: weaponDamage(10),
                damager: 'attacker',
            }, ['ship']);

            expect(DISABLE_ARMOR_FRACTION).toBe(0.33);
            expect(ship.components.get(ArmorComponent)!.current).toBe(30);
            expect(ship.components.get(DisabledComponent)).toBeTrue();
            expect(ship.components.get(DisabledLifecycleComponent))
                .toEqual({ armorFraction: 0.3 });
            expect(ship.components.has(JumpStateComponent)).toBeFalse();
            const movement = ship.components.get(MovementStateComponent)!;
            expect(movement.accelerating).toBe(0);
            expect(movement.turning).toBe(0);
            expect(movement.turnTo).toBeNull();
            expect(movement.velocity).toEqual(new Vector(12, -4));
            expect(ship.components.get(WeaponsStateComponent)!.get('laser'))
                .toEqual({ count: 1, firing: false, target: undefined });

            world.step();

            expect(movement.position).toEqual(new Position(112, 196));
            expect(movement.velocity).toEqual(new Vector(12, -4));
            expect(movement.rotation).toEqual(new Angle(Math.PI / 3));
        });

    it('can still be hit and destroyed after being disabled', async () => {
        const world = await makeWorld();
        const ship = combatShip();
        world.entities.set('ship', ship);
        world.emitNow(DamagedEvent, {
            damage: weaponDamage(10),
            damager: 'attacker',
        }, ['ship']);

        world.emitNow(DamagedEvent, {
            damage: weaponDamage(30),
            damager: 'attacker',
        }, ['ship']);
        world.step();

        expect(ship.components.get(ArmorComponent)!.current).toBe(0);
        expect(ship.components.get(DestructionStartedComponent)).toBeTrue();
    });

    it('suppresses a locally owned player before the first movement frame',
        async () => {
            const world = await makeWorld();
            world.resources.set(PlatformResource, 'browser');
            const ship = combatShip();
            ship.components.set(MultiplayerData, { owner: 'player' });
            ship.components.set(DisabledComponent, true);
            world.entities.set('player', ship);

            world.step();

            const movement = ship.components.get(MovementStateComponent)!;
            expect(movement.position).toEqual(new Position(112, 196));
            expect(movement.velocity).toEqual(new Vector(12, -4));
            expect(movement.rotation).toEqual(new Angle(Math.PI / 3));
            expect(movement.accelerating).toBe(0);
            expect(ship.components.has(JumpStateComponent)).toBeFalse();
            expect(ship.components.get(WeaponsStateComponent)!.get('laser')!
                .firing).toBeFalse();
        });

    it('lets a warship hull fight down to a tenth of its armour', () => {
        // Retail sets shïp flag 0x0010 on its warships, and the Bible reads
        // "Ship is disabled at 10% armour instead of 33%".
        expect(disableArmorFraction({ flags: 0x0010 }))
            .toBe(TOUGH_DISABLE_ARMOR_FRACTION);
        expect(disableArmorFraction({ flags: 0x4130 }))
            .toBe(TOUGH_DISABLE_ARMOR_FRACTION);
        expect(disableArmorFraction({ flags: 0 })).toBe(DISABLE_ARMOR_FRACTION);
        expect(disableArmorFraction(undefined)).toBe(DISABLE_ARMOR_FRACTION);
    });

    it('recovers once its armour is patched above the threshold', async () => {
        const world = await makeWorld();
        const ship = combatShip();
        world.entities.set('ship', ship);
        world.emitNow(DamagedEvent, {
            damage: weaponDamage(10),
            damager: 'attacker',
        }, ['ship']);
        expect(ship.components.get(DisabledComponent)).toBeTrue();

        // Self-repair is slow, so one frame must not hand control back.
        world.step();
        expect(ship.components.get(DisabledComponent)).toBeTrue();

        for (let frame = 0; frame < 600; frame++) {
            world.step();
        }

        expect(ship.components.has(DisabledComponent)).toBeFalse();
        expect(ship.components.has(DisabledLifecycleComponent)).toBeFalse();
        expect(ship.components.get(ArmorComponent)!.current)
            .toBeGreaterThan(33);
    });

    it('does not disable before crossing the threshold', async () => {
        const world = await makeWorld();
        const ship = combatShip(60);
        world.entities.set('ship', ship);

        world.emitNow(DamagedEvent, {
            damage: weaponDamage(10),
            damager: 'attacker',
        }, ['ship']);

        expect(ship.components.has(DisabledComponent)).toBeFalse();
        expect(ship.components.has(DisabledLifecycleComponent)).toBeFalse();
    });
});
