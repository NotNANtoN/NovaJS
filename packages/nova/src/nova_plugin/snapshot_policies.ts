import { Comms } from "nova_ecs/plugins/multiplayer_plugin";
import { RandomResource } from "nova_ecs/plugins/random_plugin";
import { SnapshotPolicies, SnapshotPoliciesResource } from "nova_ecs/plugins/snapshot_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { DefaultMap } from "nova_ecs/utils";
import { World } from "nova_ecs/world";
import { AnimationComponent, ExplosionDataComponent } from "./animation_plugin.js";
import { BlastDamageComponent, BlastIgnoreComponent } from "./blast_data.js";
import { BlastDoneComponent } from "./blast_plugin.js";
import { CollisionHitterComponent, CollisionVulnerabilityComponent } from "./collision_interaction.js";
import { HitboxHullComponent, HurtboxHullComponent } from "./collisions_plugin.js";
import { CreateTime } from "./create_time.js";
import { ShipControlStateComponent } from "./ship_control.js";
import { SourceComponent, SubCounts, WeaponsComponent } from "./fire_weapon_plugin.js";
import { IdFactoryResource } from "./id_factory.js";
import { PlanetDataComponent } from "./planet_plugin.js";
import { ProjectileBlastHull, ProjectileDataComponent } from "./projectile_data.js";
import { ShipDataComponent } from "./ship_plugin.js";
import { ReturnWhenTargetRemovedComponent } from "./bay_plugin.js";
import { ExplodingComponent } from "./death_plugin.js";
import { ChooseRandomTargetComponent, DeathAIComponent, FollowComponent, ShootAllWeaponsComponent } from "./npc_plugin.js";
import { ReturnToQueueComponent } from "./return_to_queue_plugin.js";
import { GuidanceComponent } from "./guidance.js";
import { TargetIndexComponent } from "./target_plugin.js";
import { ShipPhysicsComponent } from "./ship_plugin.js";
import { SingletonComponent } from "nova_ecs/world";

/**
 * Clones a DefaultMap, preserving its default factory.
 */
function cloneDefaultMap<K, V>(map: DefaultMap<K, V>, cloneValue: (v: V) => V) {
    const factory = (map as unknown as { factory: (key: K) => V }).factory;
    const copy = new DefaultMap<K, V>(factory);
    for (const [key, value] of map) {
        copy.set(key, cloneValue(value));
    }
    return copy;
}

/**
 * Registers how each kind of simulation state is captured in rollback
 * snapshots. Serializer-registered components default to a codec
 * roundtrip and are not listed here; this configures the exceptions:
 * - share: immutable static game data and derived structures that are
 *   recomputed every step before use (hulls).
 * - clone: mutable simulation state that is not serializer-registered.
 * - skip: multiplayer machinery, which is not simulation state.
 */
export function configureSnapshotPolicies(world: World) {
    const policies = new SnapshotPolicies();
    world.resources.set(SnapshotPoliciesResource, policies);

    // Immutable static game data: share the reference. (These are
    // serializer-registered, but a codec roundtrip of e.g. full
    // ShipData per snapshot would dominate the cost.)
    policies.set(ShipDataComponent, { policy: 'share' });
    policies.set(PlanetDataComponent, { policy: 'share' });
    policies.set(ProjectileDataComponent, { policy: 'share' });
    policies.set(AnimationComponent, { policy: 'share' });
    policies.set(ExplosionDataComponent, { policy: 'share' });
    policies.set(BlastDamageComponent, { policy: 'share' });
    policies.set(SourceComponent, { policy: 'share' });
    policies.set(CreateTime, { policy: 'share' });

    // Hulls carry per-step scratch state (position, frame), but it is
    // recomputed from movement every step before collisions use it.
    policies.set(HitboxHullComponent, { policy: 'share' });
    policies.set(HurtboxHullComponent, { policy: 'share' });
    policies.set(ProjectileBlastHull, { policy: 'share' });

    // Re-derived from ship data and outfits at restore.
    policies.set(ShipPhysicsComponent, { policy: 'skip' });

    // Enum-valued; effectively immutable.
    policies.set(GuidanceComponent, { policy: 'share' });
    policies.set(SingletonComponent, { policy: 'share' });

    policies.set(TargetIndexComponent, {
        policy: 'clone',
        clone: data => ({ ...data }),
    });

    // Mutable unregistered simulation state: explicit clones.
    policies.set(WeaponsComponent, {
        policy: 'clone',
        clone: map => cloneDefaultMap(map, state => ({ ...state })),
    });
    policies.set(SubCounts, {
        policy: 'clone',
        clone: map => cloneDefaultMap(map, count => count),
    });
    policies.set(CollisionHitterComponent, {
        policy: 'clone',
        clone: hitter => ({ hitTypes: new Set(hitter.hitTypes) }),
    });
    policies.set(CollisionVulnerabilityComponent, {
        policy: 'clone',
        clone: vulnerability => ({ vulnerableTo: new Set(vulnerability.vulnerableTo) }),
    });
    policies.set(BlastIgnoreComponent, {
        policy: 'clone',
        clone: ignore => new Set(ignore),
    });

    // Value-typed and marker components: sharing is copying.
    policies.set(ExplodingComponent, { policy: 'share' });
    policies.set(FollowComponent, { policy: 'share' });
    policies.set(ShootAllWeaponsComponent, { policy: 'share' });
    policies.set(DeathAIComponent, { policy: 'share' });
    policies.set(ReturnWhenTargetRemovedComponent, { policy: 'share' });
    // The queue reference is shared machinery, not per-entity state.
    policies.set(ReturnToQueueComponent, { policy: 'share' });

    policies.set(ChooseRandomTargetComponent, {
        policy: 'clone',
        clone: data => ({ ...data }),
    });
    policies.set(BlastDoneComponent, {
        policy: 'clone',
        clone: data => ({ ...data }),
    });
    policies.set(ShipControlStateComponent, {
        policy: 'clone',
        clone: state => new Map(state),
    });

    // Multiplayer machinery is not simulation state.
    policies.set(Comms, { policy: 'skip' });

    // Simulation-state resources.
    const time = world.resources.get(TimeResource);
    if (time) {
        policies.addResource({
            name: 'time',
            save: () => ({ ...time }),
            restore: saved => Object.assign(time, saved),
        });
    }
    const random = world.resources.get(RandomResource);
    if (random) {
        policies.addResource({
            name: 'random',
            save: () => random.getState(),
            restore: saved => random.setState(saved as ReturnType<typeof random.getState>),
        });
    }
    const idFactory = world.resources.get(IdFactoryResource);
    if (idFactory) {
        policies.addResource({
            name: 'idFactory',
            save: () => idFactory.getState(),
            restore: saved => idFactory.setState(saved as number),
        });
    }
}
