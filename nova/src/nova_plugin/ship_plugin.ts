import * as t from 'io-ts';
import { ShipData, ShipPhysics } from "novadatainterface/ShipData";
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MovementPhysics, MovementPhysicsComponent, MovementStateComponent, MovementType } from 'nova_ecs/plugins/movement_plugin';
import { Provide } from 'nova_ecs/provide';
import { ProvideAsync } from "nova_ecs/provide_async";
import { AnimationComponent } from './animation_plugin';
import { CollisionVulnerabilityComponent } from './collision_interaction';
import { GameDataResource } from './game_data_resource';
import { ArmorComponent, IonizationColorComponent, IonizationComponent, ShieldComponent } from './health_plugin';
import { applyOutfitPhysics, OutfitsStateComponent } from './outfit_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { Stat } from './stat';
import { TargetComponent } from './target_component';

export const ShipType = t.type({
    id: t.string // Not a UUID. A nova id.
});
export type ShipType = t.TypeOf<typeof ShipType>;

export const ShipComponent = new Component<ShipType>('Ship');

export const ShipDataComponent = new Component<ShipData>('ShipData');

export const ShipDataProvider = ProvideAsync({
    name: "ShipDataProvider",
    provided: ShipDataComponent,
    args: [GameDataResource, ShipComponent] as const,
    update: [ShipComponent],
    factory: async (gameData, ship) => {
        const shipData = await gameData.data.Ship.get(ship.id);
        // Death systems are synchronous. Warm both explosion records while the
        // ship is loading so a first-ever destruction cannot silently skip its
        // initial or final visual.
        await Promise.all(
            [shipData.initialExplosion, shipData.finalExplosion]
                .filter((id): id is string => Boolean(id))
                .map(id => gameData.data.Explosion.get(id)),
        );
        return shipData;
    }
});

export const ShipOutfitsProvider = Provide({
    name: "ShipOutfitsProvider",
    provided: OutfitsStateComponent,
    args: [ShipDataComponent] as const,
    // Not ShipDataComponent because then this would always be provided
    // since ShipDataComponent is always provided since it's not multiplayer.
    update: [ShipComponent],
    factory(shipData) {
        return new Map(Object.entries(shipData.outfits)
            .map(([id, count]) => [id, { count }]));
    }
});

export const ShipPhysicsComponent = new Component<ShipPhysics>('ShipPhysicsComponent');

export const ShipPhysicsProvider = ProvideAsync({
    name: "ShipPhysicsProvider",
    provided: ShipPhysicsComponent,
    args: [ShipDataComponent, GameDataResource, OutfitsStateComponent] as const,
    update: [ShipDataComponent, OutfitsStateComponent],
    async factory(shipData, gameData, outfitsState) {
        const outfits = await Promise.all(
            [...outfitsState].map(async ([id, { count }]) =>
                [await gameData.data.Outfit.get(id), count] as const
            ));
        return applyOutfitPhysics(shipData.physics, outfits);
    }
});

/**
 * Nova gives the player ship a hidden 25% acceleration and turn-rate bonus
 * outside strict mode. NovaJS currently has no strict-mode setting, so the
 * documented default is applied whenever PlayerShipSelector is present.
 */
export const PLAYER_PHYSICS_MULTIPLIER = 1.25;

export function getShipMovementPhysics(physics: ShipPhysics,
    isPlayer = false): MovementPhysics {
    const playerMultiplier = isPlayer ? PLAYER_PHYSICS_MULTIPLIER : 1;
    return {
        acceleration: physics.acceleration * playerMultiplier,
        maxVelocity: physics.speed,
        movementType: physics.inertialess
            ? MovementType.INERTIALESS : MovementType.INERTIAL,
        turnRate: physics.turnRate * playerMultiplier,
    };
}

export const ShipMovementPhysicsProvider = Provide({
    name: "ShipMovementPhysicsProvider",
    provided: MovementPhysicsComponent,
    update: [ShipPhysicsComponent, PlayerShipSelector],
    args: [ShipPhysicsComponent, Optional(PlayerShipSelector)] as const,
    factory: (physics, player) =>
        getShipMovementPhysics(physics, player !== undefined),
});

const ShipAnimationProvider = Provide({
    name: "ShipAnimationProvider",
    provided: AnimationComponent,
    update: [ShipDataComponent],
    args: [ShipDataComponent],
    factory: shipData => shipData.animation,
});

const ShipCollisionInteractionProvider = Provide({
    name: "ShipCollisionInteractionProvider",
    provided: CollisionVulnerabilityComponent,
    args: [ShipComponent] as const,
    factory: () => ({
        vulnerableTo: new Set(['normal']),
    }),
});

const ShipShieldProvider = Provide({
    name: "ShipShieldProvider",
    provided: ShieldComponent,
    update: [ShipPhysicsComponent],
    args: [ShipPhysicsComponent, Optional(ShieldComponent)] as const,
    factory(physics, shield) {
        return new Stat({
            current: shield?.current ?? physics.shield,
            max: physics.shield,
            min: 0,
            recharge: physics.shieldRecharge,
        });
    }
});

const ShipArmorProvider = Provide({
    name: "ShipArmorProvider",
    provided: ArmorComponent,
    update: [ShipPhysicsComponent],
    args: [ShipPhysicsComponent, Optional(ArmorComponent)] as const,
    factory(physics, armor) {
        return new Stat({
            current: armor?.current ?? physics.armor,
            max: physics.armor,
            min: 0,
            recharge: physics.armorRecharge,
        });
    }
});

const ShipIonizationProvider = Provide({
    name: "ShipIonizationProvider",
    provided: IonizationComponent,
    update: [ShipPhysicsComponent],
    args: [ShipPhysicsComponent, Optional(IonizationComponent)] as const,
    factory(physics, ionization) {
        return new Stat({
            current: ionization?.current ?? 0,
            max: physics.ionization,
            min: 0,
            recharge: -physics.deionize,
        });
    }
});

const ShipIonizationColorProvider = Provide({
    name: "ShipIonizationColorProvider",
    provided: IonizationColorComponent,
    args: [] as const,
    factory() {
        return { color: 0x888888 };
    }
});

const ShipMovementStateProvider = Provide({
    name: "ShipMovementStateProvider",
    provided: MovementStateComponent,
    args: [ShipComponent],
    factory() {
        return {
            accelerating: 0,
            position: new Position(600 * (Math.random() - 0.5),
                (600 * (Math.random() - 0.5))),
            rotation: new Angle(Math.random() * 2 * Math.PI),
            turnBack: false,
            turning: 0,
            velocity: new Vector(0, 0),
        }
    }
});

const ShipTargetComponentProvider = Provide({
    name: "ShipTaretComponentProvider",
    provided: TargetComponent,
    args: [ShipComponent],
    factory() {
        return { target: undefined };
    }
});

export const ShipPlugin: Plugin = {
    name: "ShipPlugin",
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        world.addComponent(ShipComponent);
        world.addComponent(ShipDataComponent);

        world.addSystem(ShipCollisionInteractionProvider);
        world.addSystem(ShipDataProvider);
        world.addSystem(ShipAnimationProvider);
        world.addSystem(ShipOutfitsProvider);
        world.addSystem(ShipPhysicsProvider);
        world.addSystem(ShipMovementPhysicsProvider);
        world.addSystem(ShipShieldProvider);
        world.addSystem(ShipArmorProvider);
        world.addSystem(ShipIonizationProvider);
        world.addSystem(ShipIonizationColorProvider);
        world.addSystem(ShipMovementStateProvider);
        world.addSystem(ShipTargetComponentProvider);

        deltaMaker.addComponent(ShipComponent, {
            componentType: ShipType,
        });
    }
}
