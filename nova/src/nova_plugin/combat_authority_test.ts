import 'jasmine';
import * as SAT from 'sat';
import RBush from 'rbush';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { Position } from 'nova_ecs/datatypes/position';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Vector } from 'nova_ecs/datatypes/vector';
import { UUID } from 'nova_ecs/arg_types';
import { System } from 'nova_ecs/system';
import {
    GuidanceTargetTrackComponent,
    MovementPhysicsComponent,
    MovementStateComponent,
    MovementSystem,
    MovementType,
    queueGuidanceTargetSnapshot,
} from 'nova_ecs/plugins/movement_plugin';
import { CommunicatorResource, MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { MockCommunicator } from 'nova_ecs/plugins/mock_communicator';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { getDefaultProjectileWeaponData } from 'novadatainterface/WeaponData';
import {
    CollisionHitterComponent,
    CollisionVulnerabilityComponent,
} from './collision_interaction';
import {
    CaptureCollisionMovementSystem,
    CollisionSystem,
    CompositeHull,
    HitboxHullComponent,
    HurtboxHullComponent,
    RBushResource,
    UpdateHitboxHullSystem,
    UpdateHurtboxHullSystem,
} from './collisions_plugin';
import { CreateTime } from './create_time';
import { DamagedEvent } from './death_plugin';
import { FireSubs, OwnerComponent, SourceComponent } from './fire_weapon_plugin';
import {
    FireSyncPlugin,
    loggedShotEntityId,
    parseLoggedShotEntityId,
    ShotImpactLogComponent,
} from './fire_sync';
import { LagCompensationComponent, rewindOffset } from './lag_compensation';
import { PlatformResource } from './platform_plugin';
import { ProjectileComponent, ProjectileDataComponent } from './projectile_data';
import { ProjectileCollisionSystem, ShotImpactApplySystem } from './projectile_plugin';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';

const SHOOTER = 'shooter-ship';
const TARGET = 'target-ship';
const SHOT = loggedShotEntityId(SHOOTER, 7);

function movement(x: number, y: number, vx = 0, vy = 0) {
    return {
        position: new Position(x, y), rotation: new Angle(0),
        velocity: new Vector(vx, vy), accelerating: 0, turning: 0, turnBack: false,
    };
}

const inertial = {
    acceleration: 0, maxVelocity: Infinity, turnRate: 0,
    movementType: MovementType.INERTIAL,
};

/**
 * One 100 ms tick in which a projectile flies along y = 0 from x = -10 to
 * x = 10. The target sits at (0, targetY) now; where it was 100 ms ago is
 * given by its guidance history.
 */
async function combatWorld(platform: 'node' | 'browser', targetY: number,
    options: { viewDelayMs?: number, historyY?: number } = {}) {
    const world = new World(`combat-${platform}`);
    world.resources.set(PlatformResource, platform);
    world.resources.set(RBushResource, new RBush());
    world.resources.set(TimeResource, { time: 1000, frame: 1, delta_s: 0.1, delta_ms: 100 });
    await world.addPlugin(DeltaPlugin);
    await world.addPlugin(FireSyncPlugin);
    const subs = jasmine.createSpy('fireSubs').and.returnValue([]);
    world.resources.set(FireSubs, subs);
    world.addSystem(CaptureCollisionMovementSystem);
    world.addSystem(MovementSystem);
    world.addSystem(UpdateHitboxHullSystem);
    world.addSystem(UpdateHurtboxHullSystem);
    world.addSystem(CollisionSystem);
    world.addSystem(ProjectileCollisionSystem);
    world.addSystem(ShotImpactApplySystem);

    world.entities.set(SHOOTER, new Entity()
        .addComponent(MultiplayerData, { owner: 'client-a' })
        .addComponent(MovementStateComponent, movement(-500, 0)));

    const targetHull = new CompositeHull([new SAT.Box(new SAT.Vector(-2, -2), 4, 4).toPolygon()]);
    const target = new Entity()
        .addComponent(MultiplayerData, { owner: 'client-b' })
        .addComponent(MovementStateComponent, movement(0, targetY))
        .addComponent(HitboxHullComponent, targetHull)
        .addComponent(CollisionVulnerabilityComponent, { vulnerableTo: new Set(['laser']) });
    if (options.historyY !== undefined) {
        const track = { snapshots: [] };
        queueGuidanceTargetSnapshot(track, movement(0, options.historyY), 850);
        queueGuidanceTargetSnapshot(track, movement(0, options.historyY), 950);
        queueGuidanceTargetSnapshot(track, movement(0, targetY), 1000);
        target.addComponent(GuidanceTargetTrackComponent, track);
    }
    world.entities.set(TARGET, target);

    const shot = new Entity()
        .addComponent(HurtboxHullComponent, new CompositeHull([new SAT.Circle(new SAT.Vector(), 1)]))
        .addComponent(CollisionHitterComponent, { hitTypes: new Set(['laser']) })
        .addComponent(ProjectileComponent, { id: 'test' })
        .addComponent(ProjectileDataComponent, getDefaultProjectileWeaponData())
        .addComponent(CreateTime, 0)
        .addComponent(OwnerComponent, { owner: 'client-a' })
        .addComponent(SourceComponent, SHOOTER)
        .addComponent(MovementStateComponent, movement(-10, 0, 200, 0))
        .addComponent(MovementPhysicsComponent, inertial);
    if (options.viewDelayMs !== undefined) {
        shot.addComponent(LagCompensationComponent, { viewDelayMs: options.viewDelayMs });
    }
    world.entities.set(SHOT, shot);

    const damaged: string[] = [];
    world.addSystem(new System({
        name: 'record-damage', events: [DamagedEvent],
        args: [UUID] as const, step(id) { damaged.push(id); },
    }));
    return { world, damaged, subs };
}

describe('server hit authority with lag compensation', () => {
    it('parses synchronized shot ids back into source and sequence', () => {
        expect(parseLoggedShotEntityId(SHOT)).toEqual({ source: SHOOTER, seq: 7 });
        expect(parseLoggedShotEntityId('shot:a:b:3')).toEqual({ source: 'a:b', seq: 3 });
        expect(parseLoggedShotEntityId('not-a-shot')).toBeUndefined();
    });

    it('misses a target that has moved away since the shooter saw it, without compensation', async () => {
        const { world, damaged } = await combatWorld('node', 50, { historyY: 0 });
        world.step();
        expect(damaged).toEqual([]);
        expect(world.entities.has(SHOT)).toBeTrue();
    });

    it('hits where the shooter saw the target and records a ShotImpact', async () => {
        const { world, damaged, subs } = await combatWorld('node', 50,
            { historyY: 0, viewDelayMs: 100 });
        world.step();
        expect(damaged).toEqual([TARGET]);
        expect(subs).toHaveBeenCalledTimes(1);
        expect(world.entities.has(SHOT)).toBeFalse();
        const impacts = world.entities.get(SHOOTER)!
            .components.get(ShotImpactLogComponent)!.impacts;
        expect(impacts.length).toBe(1);
        expect(impacts[0]).toEqual(jasmine.objectContaining({
            impactSeq: 1, seq: 7, target: TARGET, at: 1000,
        }));
        expect(impacts[0].position.y).toBeCloseTo(0);
    });

    it('does not rewind across a teleport-sized jump in history', async () => {
        const { world, damaged } = await combatWorld('node', 5_000,
            { historyY: 0, viewDelayMs: 100 });
        world.step();
        expect(damaged).toEqual([]);
    });

    it('computes rewind offsets from guidance history', () => {
        const target = new Entity()
            .addComponent(MovementStateComponent, movement(0, 50));
        const track = { snapshots: [] };
        queueGuidanceTargetSnapshot(track, movement(0, 0), 900);
        queueGuidanceTargetSnapshot(track, movement(0, 50), 1000);
        target.addComponent(GuidanceTargetTrackComponent, track);
        const offset = rewindOffset(target, { x: 0, y: 50 }, 950, new Map());
        expect(offset!.x).toBeCloseTo(0);
        expect(offset!.y).toBeCloseTo(-25);
    });
});

describe('client application of server hit outcomes', () => {
    it('leaves synchronized hits on replicated ships to the server', async () => {
        const { world, damaged } = await combatWorld('browser', 0);
        world.step();
        expect(damaged).toEqual([]);
        expect(world.entities.has(SHOT)).toBeTrue();
    });

    it('shows the shooter its own predicted impact immediately', async () => {
        const { world, subs } = await combatWorld('browser', 0);
        world.resources.set(CommunicatorResource, new MockCommunicator('client-a'));
        world.step();
        expect(world.entities.has(SHOT)).toBeFalse();
        expect(subs).toHaveBeenCalledTimes(1);
    });

    it('resolves locally when the firing ship is no longer known', async () => {
        const { world } = await combatWorld('browser', 0);
        world.entities.delete(SHOOTER);
        world.step();
        expect(world.entities.has(SHOT)).toBeFalse();
    });

    it('removes the local copy of a shot where the server says it hit', async () => {
        const { world, subs } = await combatWorld('browser', 500);
        world.step();
        expect(world.entities.has(SHOT)).toBeTrue();
        world.entities.get(SHOOTER)!.components.set(ShotImpactLogComponent, {
            impacts: [{
                impactSeq: 1, seq: 7, at: 1100, target: TARGET,
                position: new Position(3, 4),
            }],
        });
        const shot = world.entities.get(SHOT)!;
        world.step();
        expect(world.entities.has(SHOT)).toBeFalse();
        expect(subs).toHaveBeenCalledTimes(1);
        const position = shot.components.get(MovementStateComponent)!.position;
        expect(position.x).toBeCloseTo(3);
        expect(position.y).toBeCloseTo(4);
        // Applied exactly once.
        world.step();
        expect(subs).toHaveBeenCalledTimes(1);
    });
});
