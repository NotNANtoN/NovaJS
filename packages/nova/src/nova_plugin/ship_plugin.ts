import * as t from 'io-ts';
import { OutfitData } from "novadatainterface/outfit_data";
import { ShipData, ShipPhysics } from "novadatainterface/ship_data";
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Optional } from 'nova_ecs/optional';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MovementPhysics, MovementPhysicsComponent, MovementStateComponent, MovementType } from 'nova_ecs/plugins/movement_plugin';
import { passthroughType, SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { Provide } from 'nova_ecs/provide';
import { RandomResource } from 'nova_ecs/plugins/random_plugin';
import { ProvideFromCache } from './provide_from_cache.js';
import { AnimationComponent } from './animation_plugin.js';
import { CollisionVulnerabilityComponent } from './collision_interaction.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { ArmorComponent, AUTO_REFUEL_PER_SECOND, FuelComponent, IonizationColorComponent, IonizationComponent, ShieldComponent } from './health_plugin.js';
import { applyOutfitPhysics, OutfitsState, OutfitsStateComponent } from './outfit_plugin.js';
import { registerEntityDeriver } from './entity_factory.js';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { Stat } from './stat.js';
import { TargetComponent } from './target_component.js';

export const ShipType = t.type({
    id: t.string // Not a UUID. A nova id.
});
export type ShipType = t.TypeOf<typeof ShipType>;

export const ShipComponent = new Component<ShipType>('Ship');

export const ShipDataComponent = new Component<ShipData>('ShipData');

function deriveShipData(gameData: SimulationGameDataInterface, ship: { id: string }) {
    return gameData.data.Ship.getCached(ship.id);
}

export const ShipDataProvider = ProvideFromCache({
    name: "ShipDataProvider",
    provided: ShipDataComponent,
    args: [SimulationGameDataResource, ShipComponent] as const,
    update: [ShipComponent],
    factory: deriveShipData,
});

function deriveShipOutfits(shipData: ShipData): OutfitsState {
    return new Map(Object.entries(shipData.outfits)
        .map(([id, count]) => [id, { count }]));
}

export const ShipOutfitsProvider = Provide({
    name: "ShipOutfitsProvider",
    provided: OutfitsStateComponent,
    args: [ShipDataComponent] as const,
    // Not ShipDataComponent because then this would always be provided
    // since ShipDataComponent is always provided since it's not multiplayer.
    update: [ShipComponent],
    factory: deriveShipOutfits,
});

export const ShipPhysicsComponent = new Component<ShipPhysics>('ShipPhysicsComponent');

function deriveShipPhysics(shipData: ShipData,
    gameData: SimulationGameDataInterface, outfitsState: OutfitsState) {
    const outfits: (readonly [OutfitData, number])[] = [];
    for (const [id, { count }] of outfitsState) {
        const outfit = gameData.data.Outfit.getCached(id);
        if (!outfit) {
            // Not loaded yet; retry next step.
            return undefined;
        }
        outfits.push([outfit, count] as const);
    }
    return applyOutfitPhysics(shipData.physics, outfits);
}

export const ShipPhysicsProvider = ProvideFromCache({
    name: "ShipPhysicsProvider",
    provided: ShipPhysicsComponent,
    args: [ShipDataComponent, SimulationGameDataResource, OutfitsStateComponent] as const,
    update: [ShipDataComponent, OutfitsStateComponent],
    factory: deriveShipPhysics,
});

export function getShipMovementPhysics(physics: ShipPhysics): MovementPhysics {
    return {
        acceleration: physics.acceleration,
        maxVelocity: physics.speed,
        movementType: physics.inertialess
            ? MovementType.INERTIALESS : MovementType.INERTIAL,
        turnRate: physics.turnRate,
    };
}

export const ShipMovementPhysicsProvider = Provide({
    name: "ShipMovementPhysicsProvider",
    provided: MovementPhysicsComponent,
    update: [ShipPhysicsComponent],
    args: [ShipPhysicsComponent] as const,
    factory: getShipMovementPhysics,
});

const ShipAnimationProvider = Provide({
    name: "ShipAnimationProvider",
    provided: AnimationComponent,
    update: [ShipDataComponent],
    args: [ShipDataComponent],
    factory: shipData => shipData.animation,
});

function deriveShipVulnerability(shipData: ShipData | undefined) {
    return {
        // 'debris' lets asteroid resource-boxes (which hit nothing
        // else) collide with ships for scooping.
        //
        // 'pointDefense' rides in from the ship's own data (shïp Flags2
        // 0x0008, EVN Bible ~:2572: "Ship can be fired on by point
        // defense systems"), which ship_parse folds into the same
        // `vulnerableTo` list the weapon parser uses. Without the tag a
        // PD shot passes straight through, which is the Bible's rule:
        // point defense damages incoming guided weapons and the ship
        // classes that opt in, and nothing else. A fighter's PD marker
        // (VulnerableToPD, which is what a turret AIMS at) is derived
        // from the same field in fire_weapon_plugin, so a turret can
        // never target something its shots cannot hurt.
        //
        // `shipData` is optional because this provider can run on the
        // tick before ShipDataProvider has attached it; `update`
        // re-derives the moment it lands. Re-deriving is safe: the
        // 'return_escorts' tag a carrier needs is re-added every step by
        // bay_plugin's ReturnVulnerabilitySystem, which exists precisely
        // because this set is rebuilt whenever the ship is.
        vulnerableTo: new Set<unknown>(
            shipData?.vulnerableTo.includes('pointDefense')
                ? ['normal', 'debris', 'pointDefense']
                : ['normal', 'debris']),
    };
}

const ShipCollisionInteractionProvider = Provide({
    name: "ShipCollisionInteractionProvider",
    provided: CollisionVulnerabilityComponent,
    update: [ShipDataComponent],
    args: [ShipComponent, Optional(ShipDataComponent)] as const,
    factory: (_ship, shipData) => deriveShipVulnerability(shipData),
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
            min: -physics.shield * 0.05,
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

const ShipFuelProvider = Provide({
    name: "ShipFuelProvider",
    provided: FuelComponent,
    update: [ShipPhysicsComponent],
    args: [ShipPhysicsComponent, Optional(FuelComponent)] as const,
    factory(physics, fuel) {
        // Base recharge is the fuel scoop (ModType 18); an auto-refueller
        // (ModType 19) adds a slow constant trickle on top.
        const recharge = physics.energyRecharge
            + (physics.autoRefuel ? AUTO_REFUEL_PER_SECOND : 0);
        return new Stat({
            current: fuel?.current ?? physics.energy,
            max: physics.energy,
            min: 0,
            recharge,
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
    args: [ShipComponent, RandomResource] as const,
    factory(_ship, random) {
        return {
            accelerating: 0,
            position: new Position(600 * (random.next() - 0.5),
                (600 * (random.next() - 0.5))),
            rotation: new Angle(random.next() * 2 * Math.PI),
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
        world.resources.get(SerializerResource)?.addComponent(
            ShipDataComponent, passthroughType<ShipData>('ShipDataComponentType'));

        // Derivers attach these components synchronously when an
        // entity is completed (staged insertion, snapshot restore).
        // The provider systems below remain as the fallback for
        // entities that bypass staging.
        registerEntityDeriver(world, {
            name: 'ShipDataDeriver',
            provided: ShipDataComponent,
            requires: [ShipComponent],
            derive: (entity, gameData) =>
                deriveShipData(gameData, entity.components.get(ShipComponent)!),
        });
        registerEntityDeriver(world, {
            name: 'ShipOutfitsDeriver',
            provided: OutfitsStateComponent,
            requires: [ShipDataComponent],
            derive: (entity) =>
                deriveShipOutfits(entity.components.get(ShipDataComponent)!),
        });
        registerEntityDeriver(world, {
            name: 'ShipPhysicsDeriver',
            provided: ShipPhysicsComponent,
            requires: [ShipDataComponent, OutfitsStateComponent],
            derive: (entity, gameData) => deriveShipPhysics(
                entity.components.get(ShipDataComponent)!,
                gameData,
                entity.components.get(OutfitsStateComponent)!),
        });

        world.addSystem(ShipCollisionInteractionProvider);
        world.addSystem(ShipDataProvider);
        world.addSystem(ShipAnimationProvider);
        world.addSystem(ShipOutfitsProvider);
        world.addSystem(ShipPhysicsProvider);
        world.addSystem(ShipMovementPhysicsProvider);
        world.addSystem(ShipShieldProvider);
        world.addSystem(ShipArmorProvider);
        world.addSystem(ShipFuelProvider);
        world.addSystem(ShipIonizationProvider);
        world.addSystem(ShipIonizationColorProvider);
        world.addSystem(ShipMovementStateProvider);
        world.addSystem(ShipTargetComponentProvider);

        deltaMaker.addComponent(ShipComponent, {
            componentType: ShipType,
        });
    }
}
