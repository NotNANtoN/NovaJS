import * as t from 'io-ts';
import { BayWeaponData, WeaponData } from 'novadatainterface/weapon_data';
import { Entities, GetEntity, RunQueryFunction, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { Plugin } from 'nova_ecs/plugin';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { CommunicatorResource, MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { markerType, SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { Optional } from 'nova_ecs/optional';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { SimulationGameDataResource } from './game_data_resource.js';
import { OutfitsStateComponent } from './outfit_plugin.js';
import { HitboxHullComponent, HurtboxHullComponent } from './collisions_plugin.js';
import { CollisionEvent, CollisionHitterComponent, CollisionVulnerabilityComponent } from './collision_interaction.js';
import { EscortCommandComponent } from './escort_command.js';
import { ExitPointData } from './exit_point.js';
import { OwnerComponent, SourceComponent, WeaponConstructors, WeaponEntry } from './fire_weapon_plugin.js';
import { DeathAIComponent } from './npc_plugin.js';
import { FormationComponent, nextFormationSlot } from './npc_ai_plugin.js';
import { ShipComponent } from './ship_plugin.js';
import { TargetComponent } from './target_component.js';
import { WeaponsStateComponent } from './weapons_state.js';

const CollectableEscortComponent = new Component<undefined>('CollectableEscort');
const ReturnComponent = new Component<undefined>('ReturnComponent');
/**
 * Marks a bay-launched fighter — the ships that CAN return to a bay.
 * (Historical name: it once triggered auto-return when the fighter's
 * target vanished; fighters now launch into formation and dock only on
 * the returnToBay escort command. The name is kept because the marker
 * is serializer-registered and renaming would churn wire compat for no
 * behavior change.)
 */
export const ReturnWhenTargetRemovedComponent = new Component<undefined>('ReturnWhenTargetRemoved');

/**
 * Links a launched fighter back to the bay weapon that launched it, so
 * docking can refund a round of ammo to the carrier's magazine and so
 * the outfitter can count still-deployed fighters against buy caps.
 *
 * A separate component rather than data folded into
 * ReturnWhenTargetRemovedComponent: that one is a registered marker
 * (markerType / `encode: () => null`) on the wire, and giving it a
 * payload would change its codec, so old and new peers would disagree
 * about the shape of an existing component. A NEW component is additive
 * — peers that don't know it ignore the extra key.
 */
const BayFighter = t.type({
    /** Global id of the bay wëap this fighter launched from. */
    bayWeaponId: t.string,
});
export type BayFighter = t.TypeOf<typeof BayFighter>;
export const BayFighterComponent =
    new Component<BayFighter>('BayFighterComponent');

/**
 * Credits one round of `bayWeaponId` ammo back to `carrier`'s magazine,
 * for a fighter that just docked. Returns whether a round was actually
 * refunded.
 *
 * Policy (deliberately the mirror image of weapon_plugin's
 * consumeAmmo): the round goes to the LOWEST-sorted outfit id that
 * supplies this weapon, so every peer picks the same outfit. Two
 * further rules:
 *
 *  - The count is bumped IN PLACE on an existing OutfitsState entry
 *    rather than reassigning OutfitsStateComponent. Provide's change
 *    detection only fires on component reassignment (see
 *    nova_ecs/provide.ts), so an in-place bump — exactly what
 *    consumeAmmo does — leaves WeaponsStateComponent and the
 *    WeaponsComponent local state (reload timers, burst counters)
 *    alone. Reassigning would re-derive both and reset every weapon's
 *    reload clock mid-flight, which is the live TODO at
 *    fire_weapon_plugin.ts WeaponsComponentProvider.
 *  - It never pushes the magazine past capacity (the bay's MaxAmmo
 *    times the number of bays the carrier mounts), so a carrier that
 *    somehow restocked while its fighters were out cannot end up
 *    over-full. In normal play the deployed-fighter accounting in the
 *    outfitter (outfitter_rules deployedCounts) keeps this from ever
 *    biting.
 *
 * A carrier with no entry at all for any supplying outfit gets no
 * refund: consumeAmmo decrements existing entries and leaves them at
 * zero rather than deleting them, so the entry is there in every path
 * that launched the fighter in the first place. Nothing here can
 * invent an outfit id, since finding one would need an async scan of
 * every outfit in the game data.
 */
export function refundFighterToBay(carrier: Entity, bayWeaponId: string,
    gameData: SimulationGameDataInterface): boolean {
    const outfits = carrier.components.get(OutfitsStateComponent);
    if (!outfits) {
        return false;
    }
    const supplying = [...outfits.keys()]
        .filter(id => gameData.data.Outfit.getCached(id)?.ammoFor
            === bayWeaponId)
        .sort();
    if (supplying.length === 0) {
        return false;
    }

    // Capacity: MaxAmmo per bay times the bays mounted. MaxAmmo <= 0
    // means the bay defers to the outfit's Max field (matching
    // outfitter_rules ammoCapacity), which is not simulation state, so
    // treat it as uncapped here.
    const bay = gameData.data.Weapon.getCached(bayWeaponId);
    const bays = carrier.components.get(WeaponsStateComponent)
        ?.get(bayWeaponId)?.count ?? 0;
    if (bay && bay.maxAmmo > 0) {
        const capacity = bay.maxAmmo * bays;
        let held = 0;
        for (const id of supplying) {
            held += outfits.get(id)!.count;
        }
        if (held >= capacity) {
            return false;
        }
    }

    outfits.get(supplying[0])!.count++;
    return true;
}

/** Speed, in px/s, a fighter is pushed out of the bay at, on top of
 * the carrier's own velocity. */
export const EXIT_KICK = 10;

class BayWeaponEntry extends WeaponEntry {
    declare data: BayWeaponData;
    protected pointDefenseRangeSquared;
    //    private factoryQueue: FactoryQueue<Entity>;

    constructor(data: WeaponData, runQuery: RunQueryFunction) {
        if (data.type !== 'BayWeaponData') {
            throw new Error('Data type must be BayWeaponData');
        }

        super(data, runQuery);
        
        this.pointDefenseRangeSquared = 0;

        // const queueHolder = {} as { queue: FactoryQueue<Entity> };
        // this.factoryQueue = new FactoryQueue(() => {
        //     const ship = new Entity();
        //     ship.components.set(ShipComponent, {
        //         id: data.shipID,
        //     }).set(MovementStateComponent, {
        //         accelerating: 0,
        //         position: new Position(0, 0),
        //         rotation: new Angle(0),
        //         turnBack: false,
        //         turning: 0,
        //         velocity: new Vector(0, 0),
        //     }).set(ReturnToQueueComponent, queueHolder)
        //         .set(DeathAIComponent, undefined);
        //     return ship;
        // });
        // queueHolder.queue = this.factoryQueue;
    }

    private makeShip() {
        const ship = new Entity();
        ship.components.set(ShipComponent, {
            id: this.data.shipID,
        }).set(MovementStateComponent, {
            accelerating: 0,
            position: new Position(0, 0),
            rotation: new Angle(0),
            turnBack: false,
            turning: 0,
            velocity: new Vector(0, 0),
        }).set(DeathAIComponent, undefined)
            .set(ReturnWhenTargetRemovedComponent, undefined)
        return ship;
    }

    fire(position: Position, angle: Angle, owner: string, target = undefined, source: string, sourceVelocity?: Vector, exitPointData?: ExitPointData): Entity | undefined {
        // In input-driven multiplayer every peer simulates every bay
        // deterministically; ownership tags along for identity only.
        const q = this.runQuery(new Query([MultiplayerData] as const), source);
        const multiplayerOwner = q[0]?.[0]?.owner ?? 'sim';

        // Vector is immutable: add() RETURNS the sum, so these must be
        // chained. They used to be called for effect, which threw both
        // terms away and launched every fighter at a dead stop next to
        // a carrier at full speed.
        let velocity = new Vector(0, 0);
        if (sourceVelocity) {
            velocity = velocity.add(sourceVelocity);
        }
        // TODO: Add exit velocity to bay weapons.
        velocity = velocity.add(angle.getUnitVector().scale(EXIT_KICK));

        const ship = this.makeShip();
        ship.components.set(OwnerComponent, {owner});
        ship.components.set(BayFighterComponent,
            { bayWeaponId: this.data.id });
        ship.components.set(SourceComponent, source);
        ship.components.set(TargetComponent, { target: undefined });
        ship.components.set(MovementStateComponent, {
            accelerating: 0,
            position: Position.fromVectorLike(position),
            velocity: Vector.fromVectorLike(velocity),
            rotation: Angle.fromAngleLike(angle),
            turnBack: false,
            turning: 0,
        });
        ship.components.set(MultiplayerData, {owner: multiplayerOwner});

        // Fighters launch as ESCORTS: into a formation slot on their
        // carrier, under the default escort command. They no longer
        // launch straight at the carrier's target — attacking is the
        // 'attack' escort command's job (escort_command_plugin), so a
        // launch needs no target at all.
        const slot = nextFormationSlot(
            this.runQuery(BayFormationQuery).map(([formation]) => formation),
            source);
        ship.components.set(FormationComponent, { leader: source, slot });
        ship.components.set(EscortCommandComponent,
            { command: 'formation' });

        this.entities.set(this.ids.next(`bay:${multiplayerOwner}`), ship);
        const ownerVuln = this.entities.get(source)?.components
            .get(CollisionVulnerabilityComponent);
        ownerVuln?.vulnerableTo.add(`return_escorts`);

        return ship;
    }
}

const BayFormationQuery = new Query([FormationComponent] as const);

const CollectableEscortAI = new System({
    name: 'CollectableEscortAI',
    events: [CollisionEvent],
    args: [CollisionEvent, SourceComponent, Entities, UUID,
        Optional(BayFighterComponent), SimulationGameDataResource,
        CollectableEscortComponent] as const,
    step(collision, source, entities, uuid, bayFighter, gameData) {
        if (collision.other !== source) {
            return;
        }
        // Docking restocks the bay: credit the round back BEFORE the
        // fighter is deleted, while its link to the launching bay is
        // still readable. A fighter with no BayFighterComponent (state
        // from a peer that predates it, or a collectable escort that a
        // bay never launched) just docks and vanishes, exactly as
        // before.
        const carrier = entities.get(source);
        if (bayFighter && carrier) {
            refundFighterToBay(carrier, bayFighter.bayWeaponId, gameData);
        }
        entities.delete(uuid);
    },
});

/** Flips a fighter into the return-and-collect flow: fly home and be
 * scooped up on contact with the carrier. Triggered by the returnToBay
 * escort command (escort_command_plugin). */
export function startReturnHome(entity: Entity) {
    entity.components.set(ReturnComponent, undefined);
    entity.components.set(CollectableEscortComponent, undefined);
    entity.components.set(CollisionHitterComponent, {
        hitTypes: new Set([`return_escorts`]),
    });
    const hitbox = entity.components.get(HitboxHullComponent);
    if (hitbox) {
        entity.components.set(HurtboxHullComponent, hitbox);
    }
}

export const ReturnAI = new System({
    name: 'ReturnToBase',
    args: [OwnerComponent, MovementStateComponent, ReturnComponent] as const,
    step(owner, movementState) {
        movementState.turnTo = owner.owner;
        movementState.accelerating = 1;
    }
});

export const BayPlugin: Plugin = {
    name: 'BayPlugin',
    build(world) {
        const weaponConstructors = world.resources.get(WeaponConstructors);
        if (!weaponConstructors) {
            throw new Error('Expected WeaponConstructors to exist');
        }
        weaponConstructors.set('BayWeaponData', BayWeaponEntry);
        // Escort state is simulation state: unregistered, it is
        // invisible to desync hashes, silently dropped by rollback
        // snapshots (each peer's rollbacks then disagree about which
        // escorts can return), and lost from resync baselines
        // (escorts that can never return home).
        const serializer = world.resources.get(SerializerResource);
        serializer?.addComponent(ReturnComponent, markerType);
        serializer?.addComponent(CollectableEscortComponent, markerType);
        serializer?.addComponent(ReturnWhenTargetRemovedComponent, markerType);

        // Which bay a fighter came from is simulation state (docking
        // refunds ammo to that bay) AND display-world state (the
        // outfitter counts deployed fighters against buy caps). Going
        // through the delta maker registers it with the serializer too,
        // so it survives rollback snapshots, desync hashes, resync
        // baselines, and the display bridge — which drops components
        // the serializer doesn't know (SimulationBridgeHost.snapshot).
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }
        world.addComponent(BayFighterComponent);
        deltaMaker.addComponent(BayFighterComponent, {
            componentType: BayFighter,
        });

        world.addSystem(ReturnAI);
        world.addSystem(CollectableEscortAI);
    }
}
