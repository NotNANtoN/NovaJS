import { BayWeaponData, WeaponData } from 'novadatainterface/weapon_data';
import { Entities, GetEntity, RunQueryFunction, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { Plugin } from 'nova_ecs/plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { CommunicatorResource, MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { markerType, SerializerResource } from 'nova_ecs/plugins/serializer_plugin';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { HitboxHullComponent, HurtboxHullComponent } from './collisions_plugin.js';
import { CollisionEvent, CollisionHitterComponent, CollisionVulnerabilityComponent } from './collision_interaction.js';
import { ExitPointData } from './exit_point.js';
import { OwnerComponent, SourceComponent, WeaponConstructors, WeaponEntry } from './fire_weapon_plugin.js';
import { DeathAIComponent, FollowComponent, ShootAllWeaponsComponent } from './npc_plugin.js';
import { FormationComponent } from './npc_ai_plugin.js';
import { ShipComponent } from './ship_plugin.js';
import { TargetComponent } from './target_component.js';
import { TargetRemovedEvent } from './target_plugin.js';
import { WeaponsStateComponent } from './weapons_state.js';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';

/**
 * How long a fighter that lost its target holds formation on its
 * carrier before turning home to dock. EV Nova's fighters circle their
 * carrier until recalled; NovaJS has no recall control yet, so the
 * hold is a timed phase between "target gone" and the existing
 * return-and-collect flow. Matthew wants the holding pattern itself to
 * feel right — tune the formation geometry in npc_ai_plugin.ts.
 */
export const FIGHTER_HOLD_MS = 5000;

const CollectableEscortComponent = new Component<undefined>('CollectableEscort');
const ReturnComponent = new Component<undefined>('ReturnComponent');
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
            .set(ShootAllWeaponsComponent, undefined)
            .set(FollowComponent, undefined)
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
        ship.components.set(TargetComponent, { target });
        ship.components.set(MovementStateComponent, {
            accelerating: 0,
            position: Position.fromVectorLike(position),
            velocity: Vector.fromVectorLike(velocity),
            rotation: Angle.fromAngleLike(angle),
            turnBack: false,
            turning: 0,
        });
        ship.components.set(TargetComponent, { target: target });
        ship.components.set(MultiplayerData, {owner: multiplayerOwner});
        if (target === undefined) {
            return undefined;
        }

        this.entities.set(this.ids.next(`bay:${multiplayerOwner}`), ship);
        const ownerVuln = this.entities.get(source)?.components
            .get(CollisionVulnerabilityComponent);
        ownerVuln?.vulnerableTo.add(`return_escorts`);

        return ship;
    }
}

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

/** Flips a no-longer-holding fighter into the return-and-collect
 * flow: fly home and be scooped up on contact with the carrier. */
function startReturnHome(entity: Entity) {
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

const FormationQuery = new Query([FormationComponent] as const);

/**
 * A fighter whose target vanished stops fighting and falls into a
 * formation slot on its carrier (the holding pattern; steering in
 * npc_ai_plugin's FormationSystem), then turns home to dock after
 * FIGHTER_HOLD_MS. Slots count existing followers of the same leader
 * so simultaneous events assign distinct slots deterministically.
 */
const ReturnWhenTargetRemovedAI = new System({
    name: 'ReturnWhenTargetRemovedAI',
    events: [TargetRemovedEvent],
    args: [GetEntity, WeaponsStateComponent, OwnerComponent, FormationQuery,
        TimeResource, ReturnWhenTargetRemovedComponent] as const,
    step(entity, weapons, owner, formations, time) {
        entity.components.delete(ShootAllWeaponsComponent);
        entity.components.delete(FollowComponent);
        for (const [, weapon] of weapons) {
            weapon.firing = false;
        }
        const slot = formations
            .filter(([formation]) => formation.leader === owner.owner)
            .length;
        entity.components.set(FormationComponent, {
            leader: owner.owner,
            slot,
            dockAt: time.time + FIGHTER_HOLD_MS,
        });
    }
});

/**
 * Ends a bay fighter's formation hold: at dockAt (or if the carrier
 * vanished, leaving FormationSystem to delete the component — the
 * ReturnComponent then has no live owner and the fighter drifts, the
 * pre-formation behavior) the fighter turns home to be collected.
 */
const BayFighterDockSystem = new System({
    name: 'BayFighterDockSystem',
    args: [GetEntity, FormationComponent, TimeResource,
        ReturnWhenTargetRemovedComponent] as const,
    step(entity, formation, time) {
        if (formation.dockAt === undefined
            || time.time < formation.dockAt) {
            return;
        }
        entity.components.delete(FormationComponent);
        startReturnHome(entity);
    }
});

const ReturnAI = new System({
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
        world.addSystem(ReturnAI);
        world.addSystem(ReturnWhenTargetRemovedAI);
        world.addSystem(BayFighterDockSystem);
        world.addSystem(CollectableEscortAI);
    }
}
