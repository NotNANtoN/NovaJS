import { BayWeaponData, WeaponData } from 'novadatainterface/weapon_data';
import { Entities, GetEntity, RunQueryFunction, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { Plugin } from 'nova_ecs/plugin';
import { Optional } from 'nova_ecs/optional';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { CommunicatorResource, MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { markerType, SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { HitboxHullComponent, HurtboxHullComponent } from './collisions_plugin.js';
import { CollisionEvent, CollisionHitterComponent, CollisionVulnerabilityComponent } from './collision_interaction.js';
import { EscortCommandComponent } from './escort_command.js';
import { ExitPointData } from './exit_point.js';
import { OwnerComponent, SourceComponent, WeaponConstructors, WeaponEntry } from './fire_weapon_plugin.js';
import { DeathAIComponent } from './npc_plugin.js';
import { FormationComponent, nextFormationSlot } from './npc_ai_plugin.js';
import { EscortLandingComponent } from './player_escort.js';
import { ShipComponent } from './ship_plugin.js';
import { TargetComponent } from './target_component.js';
import { WeaponsStateComponent } from './weapons_state.js';

/** Exported so a landing order can cancel an in-progress return
 * (player_escort_plugin): a fighter whose carrier is leaving the system
 * lands on the planet instead of chasing a bay that is about to vanish. */
export const CollectableEscortComponent = new Component<undefined>('CollectableEscort');
export const ReturnComponent = new Component<undefined>('ReturnComponent');
/**
 * Marks a bay-launched fighter — the ships that CAN return to a bay.
 * (Historical name: it once triggered auto-return when the fighter's
 * target vanished; fighters now launch into formation and dock only on
 * the returnToBay escort command. The name is kept because the marker
 * is serializer-registered and renaming would churn wire compat for no
 * behavior change.)
 */
export const ReturnWhenTargetRemovedComponent = new Component<undefined>('ReturnWhenTargetRemoved');

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

        let velocity = new Vector(0, 0);
        if (sourceVelocity) {
            velocity.add(sourceVelocity);
        }
        // TODO: Add exit velocity to bay weapons.
        velocity.add(angle.getUnitVector().scale(10));

        const ship = this.makeShip();
        ship.components.set(OwnerComponent, {owner});
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
    args: [CollisionEvent, SourceComponent, Entities, UUID, CollectableEscortComponent] as const,
    step(collision, source, entities, uuid) {
        if (collision.other === source) {
            entities.delete(uuid);
        }
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
    args: [OwnerComponent, MovementStateComponent, ReturnComponent,
        Optional(EscortLandingComponent)] as const,
    step(owner, movementState, _return, landing) {
        if (landing) {
            // Landing with the player wins over flying home to the bay
            // (player_escort_plugin steers this ship).
            return;
        }
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
        world.addSystem(ReturnAI);
        world.addSystem(CollectableEscortAI);
    }
}
