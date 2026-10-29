import { BayWeaponData, WeaponData } from 'novadatainterface/WeaponData';
import { Entities, GetEntity, RunQueryFunction, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { Plugin } from 'nova_ecs/plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { CommunicatorResource, MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { v4 } from 'uuid';
import { HitboxHullComponent, HurtboxHullComponent } from './collisions_plugin';
import { CollisionEvent, CollisionHitterComponent, CollisionVulnerabilityComponent } from './collision_interaction';
import { ExitPointData } from './exit_point';
import { OwnerComponent, ShotCreation, ShotSeedComponent, SourceComponent, WeaponConstructors, WeaponEntry } from './fire_weapon_plugin';
import { DeathAIComponent, FollowComponent, GovtComponent, NpcAIComponent, NpcCombatRoleComponent, ShootAllWeaponsComponent } from './npc_plugin';
import { reserveEntity } from './entity_budget';
import { ShipComponent } from './ship_plugin';
import { TargetComponent } from './target_component';
import { TargetRemovedEvent } from './target_plugin';
import { WeaponsStateComponent } from './weapons_state';
import { DestructionStartedComponent } from './destruction_state';
import { DisabledComponent, LastAttackerComponent, PlayerDeathComponent } from './death_plugin';
import { ConquestBotComponent } from './conquest_config';
import { getNpcBayMaxCapacity, NpcWeaponAmmoComponent } from './weapon_plugin';
import { PlatformResource } from './platform_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Optional } from 'nova_ecs/optional';

const CollectableEscortComponent = new Component<undefined>('CollectableEscort');
const ReturnComponent = new Component<undefined>('ReturnComponent');
const ReturnWhenTargetRemovedComponent = new Component<undefined>('ReturnWhenTargetRemoved');
export const BayWeaponIdComponent = new Component<string>('BayWeaponId');

function refundBayFighterAmmo(carrier: Entity | undefined, weaponId: string | undefined): void {
    if (!carrier || !weaponId) {
        return;
    }
    const npcAmmo = carrier.components.get(NpcWeaponAmmoComponent);
    if (!npcAmmo) {
        return;
    }
    const maxCap = getNpcBayMaxCapacity(carrier, weaponId);
    const current = npcAmmo.get(weaponId) ?? 0;
    if (current < maxCap) {
        npcAmmo.set(weaponId, current + 1);
    }
}

class BayWeaponEntry extends WeaponEntry {
    declare data: BayWeaponData;
    protected pointDefenseRangeSquared;
    override readonly syncAsFireEvent = false;
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
            .set(NpcAIComponent, undefined)
            .set(NpcCombatRoleComponent, 'military')
            .set(ShootAllWeaponsComponent, undefined)
            .set(FollowComponent, undefined)
            .set(ReturnWhenTargetRemovedComponent, undefined)
            .set(BayWeaponIdComponent, this.data.id)
        return ship;
    }

    fire(position: Position, angle: Angle, owner: string, target = undefined,
        source: string, sourceVelocity?: Vector,
        _exitPointData?: ExitPointData, shot?: ShotCreation): Entity | undefined {
        if (!shot) {
            throw new Error('Bay launches require deterministic creation data');
        }
        const q = this.runQuery(new Query([MultiplayerData, CommunicatorResource] as const), source);

        // Do not fire if the owner is a multiplayer object not owned by us.
        if (q.length > 0 && q[0][0].owner !== q[0][1].uuid) {
            return;
        }

        const multiplayerOwner = q.length > 0 ? q[0][1].uuid : 'server';
        // Do not fire if we don't have a uuid yet.
        if (!multiplayerOwner) {
            return;
        }
        if (target === undefined) {
            return undefined;
        }

        let velocity = new Vector(0, 0);
        if (sourceVelocity) {
            velocity = velocity.add(sourceVelocity);
        }
        // TODO: Add exit velocity to bay weapons.
        velocity = velocity.add(angle.getUnitVector().scale(10));

        const ship = this.makeShip();
        if (!reserveEntity(this.budget, ship, 'ship')) {
            return undefined;
        }
        const parentGovt = this.entities.get(source)?.components.get(GovtComponent);
        if (parentGovt) {
            ship.components.set(GovtComponent, { id: parentGovt.id });
        }
        ship.components.set(OwnerComponent, {owner});
        ship.components.set(SourceComponent, source);
        ship.components.set(ShotSeedComponent, { seed: shot.seed });
        ship.components.set(TargetComponent, { target });
        ship.components.set(MovementStateComponent, {
            accelerating: 0,
            position: Position.fromVectorLike(position),
            velocity: Vector.fromVectorLike(velocity),
            rotation: Angle.fromAngleLike(angle),
            turnBack: false,
            turning: 0,
        });
        ship.components.set(MultiplayerData, {owner: multiplayerOwner});

        this.entities.set(v4(), ship);
        const ownerVuln = this.entities.get(source)?.components
            .get(CollisionVulnerabilityComponent);
        ownerVuln?.vulnerableTo.add(`return_escorts`);

        return ship;
    }
}

const CollectableEscortAI = new System({
    name: 'CollectableEscortAI',
    events: [CollisionEvent],
    args: [CollisionEvent, SourceComponent, Entities, UUID, CollectableEscortComponent,
        Optional(BayWeaponIdComponent)] as const,
    step(collision, source, entities, uuid, _collectable, bayWeaponId) {
        if (collision.other === source) {
            refundBayFighterAmmo(entities.get(source), bayWeaponId);
            entities.delete(uuid);
        }
    },
});

const ReturnWhenTargetRemovedAI = new System({
    name: 'ReturnWhenTargetRemovedAI',
    events: [TargetRemovedEvent],
    args: [GetEntity, WeaponsStateComponent,
        ReturnWhenTargetRemovedComponent] as const,
    step(entity, weapons) {
        entity.components.delete(ShootAllWeaponsComponent);
        entity.components.delete(FollowComponent);
        for (const [, weapon] of weapons) {
            weapon.firing = false;
        }
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
});

const ReturnAI = new System({
    name: 'ReturnToBase',
    args: [OwnerComponent, MovementStateComponent, ReturnComponent,
        Optional(SourceComponent), Entities] as const,
    step(owner, movementState, _return, source, entities) {
        movementState.turnTo = (source && entities.has(source)) ? source : owner.owner;
        movementState.accelerating = 1;
    }
});

function isLiveCombatTarget(entities: Map<string, Entity>, targetUuid: string | undefined, selfUuid: string, carrierUuid: string): boolean {
    if (!targetUuid || targetUuid === selfUuid || targetUuid === carrierUuid) {
        return false;
    }
    const ent = entities.get(targetUuid);
    if (!ent) {
        return false;
    }
    if (
        ent.components.has(DestructionStartedComponent)
        || ent.components.has(PlayerDeathComponent)
        || ent.components.get(DisabledComponent) === true
    ) {
        return false;
    }
    return true;
}

const BayFighterSupervisorSystem = new System({
    name: 'BayFighterSupervisor',
    args: [
        SourceComponent,
        TargetComponent,
        MovementStateComponent,
        GetEntity,
        UUID,
        Entities,
        ReturnWhenTargetRemovedComponent,
        Optional(WeaponsStateComponent),
        Optional(BayWeaponIdComponent),
        Optional(PlatformResource),
    ] as const,
    step(source, target, movement, entity, uuid, entities, _marker, weapons, bayWeaponId, platform) {
        if (platform && platform !== 'node') {
            return;
        }
        const ownTargetValid = isLiveCombatTarget(entities, target.target, uuid, source);
        const carrier = entities.get(source);
        if (!carrier || carrier.components.has(DestructionStartedComponent)) {
            if (!ownTargetValid) {
                entities.delete(uuid);
            }
            return;
        }

        const isNpcCarrier = carrier.components.has(NpcAIComponent)
            || carrier.components.has(ConquestBotComponent);
        const carrierTarget = isNpcCarrier
            ? carrier.components.get(TargetComponent)?.target
            : (carrier.components.get(TargetComponent)?.target
                ?? carrier.components.get(LastAttackerComponent));
        const carrierTargetValid = isLiveCombatTarget(entities, carrierTarget, uuid, source);

        if (!ownTargetValid && carrierTargetValid) {
            // Re-engage the parent Carrier's active target!
            target.target = carrierTarget;
            if (entity.components.has(ReturnComponent)) {
                entity.components.delete(ReturnComponent);
                entity.components.delete(CollectableEscortComponent);
                entity.components.set(FollowComponent, undefined);
                entity.components.set(ShootAllWeaponsComponent, undefined);
            }
            return;
        }

        if (!ownTargetValid && !carrierTargetValid) {
            target.target = undefined;
            if (!entity.components.has(ReturnComponent)) {
                entity.components.delete(ShootAllWeaponsComponent);
                entity.components.delete(FollowComponent);
                if (weapons) {
                    for (const [, weapon] of weapons) {
                        weapon.firing = false;
                    }
                }
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
        }

        if (entity.components.has(ReturnComponent)) {
            const carrierMov = carrier.components.get(MovementStateComponent);
            if (carrierMov) {
                const distSq = carrierMov.position.subtract(movement.position).lengthSquared;
                if (distSq <= 60 * 60) {
                    refundBayFighterAmmo(carrier, bayWeaponId);
                    entities.delete(uuid);
                }
            }
        }
    },
});

const lastBayReplenishByCarrier = new Map<string, number>();
const BAY_REPLENISH_INTERVAL_MS = 12_000;

const ActiveBayFightersQuery = new Query([
    SourceComponent,
    BayWeaponIdComponent,
] as const, 'ActiveBayFighters');

const BayCarrierReplenishSystem = new System({
    name: 'BayCarrierReplenish',
    args: [
        NpcWeaponAmmoComponent,
        WeaponsStateComponent,
        UUID,
        GetEntity,
        ActiveBayFightersQuery,
        Optional(TimeResource),
        Optional(PlatformResource),
    ] as const,
    step(npcAmmo, weapons, carrierUuid, carrier, activeFighters, time, platform) {
        if (platform && platform !== 'node') {
            return;
        }
        const now = time?.time ?? 0;
        const lastAt = lastBayReplenishByCarrier.get(carrierUuid) ?? now;
        if (!lastBayReplenishByCarrier.has(carrierUuid)) {
            lastBayReplenishByCarrier.set(carrierUuid, now);
            return;
        }
        if (now - lastAt < BAY_REPLENISH_INTERVAL_MS) {
            return;
        }
        lastBayReplenishByCarrier.set(carrierUuid, now);

        for (const [weaponId, remaining] of npcAmmo) {
            if (!weapons.has(weaponId)) {
                continue;
            }
            const maxCap = getNpcBayMaxCapacity(carrier, weaponId);
            let activeCount = 0;
            for (const [fSource, fWeaponId] of activeFighters) {
                if (fSource === carrierUuid && fWeaponId === weaponId) {
                    activeCount++;
                }
            }
            if (remaining + activeCount < maxCap) {
                npcAmmo.set(weaponId, remaining + 1);
            }
        }
    },
});

export const BayPlugin: Plugin = {
    name: 'BayPlugin',
    build(world) {
        const weaponConstructors = world.resources.get(WeaponConstructors);
        if (!weaponConstructors) {
            throw new Error('Expected WeaponConstructors to exist');
        }
        weaponConstructors.set('BayWeaponData', BayWeaponEntry);
        world.addSystem(ReturnAI);
        world.addSystem(ReturnWhenTargetRemovedAI);
        world.addSystem(CollectableEscortAI);
        world.addSystem(BayFighterSupervisorSystem);
        world.addSystem(BayCarrierReplenishSystem);
    }
}
