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
    MovementPhysicsComponent,
    MovementPlugin,
    MovementStateComponent,
    MovementType,
} from 'nova_ecs/plugins/movement_plugin';
import { Comms, multiplayer, MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { TimePlugin, TimeResource } from 'nova_ecs/plugins/time_plugin';
import { DeterministicDelayedNetwork, DelayedNetworkOptions } from 'nova_ecs/plugins/delayed_network';
import { NetworkTimingResource } from 'nova_ecs/plugins/network_timing';
import { getDefaultProjectileWeaponData } from 'novadatainterface/WeaponData';
import { CollisionHitterComponent, CollisionVulnerabilityComponent } from './collision_interaction';
import {
    CaptureCollisionMovementSystem, CollisionSystem, CompositeHull, HitboxHullComponent,
    HurtboxHullComponent, RBushResource, UpdateHitboxHullSystem, UpdateHurtboxHullSystem,
} from './collisions_plugin';
import { CreateTime } from './create_time';
import { DamagedEvent, HitFeedbackEvent } from './damage_events';
import { FireSubs, OwnerComponent, SourceComponent } from './fire_weapon_plugin';
import { FireSyncPlugin, loggedShotEntityId, ShotImpactLogComponent } from './fire_sync';
import { LagCompensationComponent } from './lag_compensation';
import { PlatformResource } from './platform_plugin';
import { ProjectileComponent, ProjectileDataComponent } from './projectile_data';
import { ProjectileCollisionSystem, RecordGuidanceTrackSystem, ShotImpactApplySystem } from './projectile_plugin';


/**
 * Fight agreement: a shooter client, a target client and the server run over
 * a delayed, jittery network. The target strafes; the shooter fires at where
 * it sees the target. Every world must agree on which shots hit, and no
 * observer may resolve hits on its own.
 */

const FRAME_MS = 1000 / 60;
const SHOOTER = 'shooter-ship';
const TARGET = 'target-ship';

const inertial = {
    acceleration: 0, maxVelocity: 1000, turnRate: 0, movementType: MovementType.INERTIAL,
};

function movement(x: number, y: number, vx = 0, vy = 0) {
    return {
        position: new Position(x, y), rotation: new Angle(0),
        velocity: new Vector(vx, vy), accelerating: 0, turning: 0, turnBack: false,
    };
}

function combatWorld(uuid: string, communicator: ReturnType<DeterministicDelayedNetwork['connect']>) {
    const world = new World(uuid);
    world.addPlugin(multiplayer(communicator));
    world.addPlugin(TimePlugin);
    world.addPlugin(MovementPlugin);
    world.addPlugin(FireSyncPlugin);
    const time = world.resources.get(TimeResource)!;
    time.time = 0;
    time.fixedDelta_ms = FRAME_MS;
    world.resources.set(PlatformResource, uuid === 'server' ? 'node' : 'browser');
    world.resources.set(RBushResource, new RBush());
    world.resources.set(FireSubs, () => []);
    world.addSystem(CaptureCollisionMovementSystem);
    world.addSystem(UpdateHitboxHullSystem);
    world.addSystem(UpdateHurtboxHullSystem);
    world.addSystem(CollisionSystem);
    world.addSystem(ProjectileCollisionSystem);
    world.addSystem(ShotImpactApplySystem);
    world.addSystem(RecordGuidanceTrackSystem);
    world.singletonEntity.components.get(Comms)!.admins = new Set(['server']);

    const damaged: Array<{ target: string, damager: string }> = [];
    const feedback: Array<{ target: string, damager: string }> = [];
    world.addSystem(new System({
        name: 'record-damage', events: [DamagedEvent],
        args: [DamagedEvent, UUID] as const,
        step(event, id) { damaged.push({ target: id, damager: event.damager }); },
    }));
    world.addSystem(new System({
        name: 'record-feedback', events: [HitFeedbackEvent],
        args: [HitFeedbackEvent, UUID] as const,
        step(event, id) { feedback.push({ target: id, damager: event.damager }); },
    }));
    return { world, damaged, feedback };
}

function hittable(entity: Entity): Entity {
    return entity
        .addComponent(HitboxHullComponent, new CompositeHull([
            new SAT.Box(new SAT.Vector(-12, -12), 24, 24).toPolygon()]))
        .addComponent(CollisionVulnerabilityComponent, { vulnerableTo: new Set(['normal']) });
}

/**
 * Fire one synchronized shot in `world` from `from` toward `aim`, already
 * `ageMs` along its path (as the server does for a late-arriving intent).
 */
function spawnShot(world: World, seq: number, from: { x: number, y: number },
    aim: { x: number, y: number }, speed: number, viewDelayMs?: number, ageMs = 0) {
    const direction = new Vector(aim.x - from.x, aim.y - from.y).normalize();
    from = {
        x: from.x + direction.x * speed * ageMs / 1000,
        y: from.y + direction.y * speed * ageMs / 1000,
    };
    const data = getDefaultProjectileWeaponData();
    data.proxSafety = 0;
    const shot = new Entity()
        .addComponent(HurtboxHullComponent, new CompositeHull([new SAT.Circle(new SAT.Vector(), 2)]))
        .addComponent(CollisionHitterComponent, { hitTypes: new Set(['normal']) })
        .addComponent(ProjectileComponent, { id: 'test' })
        .addComponent(ProjectileDataComponent, data)
        .addComponent(CreateTime, world.resources.get(TimeResource)!.time)
        .addComponent(OwnerComponent, { owner: 'shooter' })
        .addComponent(SourceComponent, SHOOTER)
        .addComponent(MovementStateComponent, movement(from.x, from.y,
            direction.x * speed, direction.y * speed))
        .addComponent(MovementPhysicsComponent, inertial);
    if (viewDelayMs !== undefined) {
        shot.addComponent(LagCompensationComponent, { viewDelayMs });
    }
    world.entities.set(loggedShotEntityId(SHOOTER, seq), shot);
}

function runFight(options: DelayedNetworkOptions, compensate = true, targetSpeed = 120) {
    const network = new DeterministicDelayedNetwork(options);
    const server = combatWorld('server', network.connect('server'));
    const shooter = combatWorld('shooter', network.connect('shooter'));
    const target = combatWorld('target', network.connect('target'));

    shooter.world.entities.set(SHOOTER, new Entity()
        .addComponent(MultiplayerData, { owner: 'shooter' })
        .addComponent(MovementStateComponent, movement(0, 300))
        .addComponent(MovementPhysicsComponent, inertial));
    target.world.entities.set(TARGET, hittable(new Entity()
        .addComponent(MultiplayerData, { owner: 'target' })
        .addComponent(MovementStateComponent, movement(0, 0, targetSpeed, 0))
        .addComponent(MovementPhysicsComponent, inertial)));

    const worlds = [server, shooter, target];
    const step = () => {
        for (const { world } of worlds) world.step();
        network.advance();
    };
    for (let i = 0; i < 90; i++) step();
    // Remote copies need hitboxes too (hulls are local presentation).
    for (const { world } of [server, shooter]) {
        const remote = world.entities.get(TARGET);
        if (remote && !remote.components.has(HitboxHullComponent)) hittable(remote);
    }
    expect(shooter.world.entities.has(TARGET)).withContext('target replicated').toBeTrue();

    let seq = 0;
    const firedSeqs: number[] = [];
    // Fire intents in transit to the server, like network messages.
    const intents: Array<{ at: number, spawn: () => void }> = [];
    const delays = options.delays ?? [50];
    for (let frame = 0; frame < 480; frame++) {
        for (const intent of intents.filter(i => i.at <= frame)) {
            intent.spawn();
            intents.splice(intents.indexOf(intent), 1);
        }
        // Target strafes back and forth so a stale view misses badly.
        if (frame % 60 === 0) {
            const own = target.world.entities.get(TARGET)!.components.get(MovementStateComponent)!;
            own.velocity = new Vector(frame % 120 === 0 ? -targetSpeed : targetSpeed, 0);
        }
        if (frame % 20 === 0 && frame < 400) {
            // The shooter leads the target as presented to it. Jitter makes
            // that presentation diverge from the owner's true position.
            const seenState = shooter.world.entities.get(TARGET)!
                .components.get(MovementStateComponent)!;
            const from = shooter.world.entities.get(SHOOTER)!
                .components.get(MovementStateComponent)!.position;
            const flight = Math.hypot(seenState.position.x - from.x,
                seenState.position.y - from.y) / 1500;
            const seen = {
                x: seenState.position.x + seenState.velocity.x * flight,
                y: seenState.position.y + seenState.velocity.y * flight,
            };
            seq++;
            firedSeqs.push(seq);
            spawnShot(shooter.world, seq, from, seen, 1500);
            // What the server receives one-way latency later: the same
            // muzzle pose, fast-forwarded by its age, and the view delay the
            // shooter's WeaponsSystem stamps on its intent.
            const timing = shooter.world.resources.get(NetworkTimingResource)!;
            const viewDelay = timing.presentationDelay(
                shooter.world.resources.get(TimeResource)!.time);
            const transitMs = delays[seq % delays.length];
            const transitFrames = Math.ceil(transitMs / FRAME_MS);
            const shotSeq = seq;
            const muzzle = { x: from.x, y: from.y };
            intents.push({
                at: frame + transitFrames,
                spawn: () => spawnShot(server.world, shotSeq, muzzle, seen, 1500,
                    // Fast-forwarding already aligns the shot with server
                    // time; only the shooter's presentation delay is rewound.
                    compensate ? viewDelay : undefined,
                    transitFrames * FRAME_MS),
            });
        }
        step();
    }
    for (let i = 0; i < 60; i++) step();
    return { server, shooter, target, firedSeqs };
}

describe('fight agreement over a delayed network', () => {
    for (const profile of [
        { name: 'stable 40ms', delays: [40] },
        { name: 'jittery 30-90ms', delays: [30, 90, 55, 75, 40, 85, 60] },
    ]) {
        it(`agrees on hits: ${profile.name}`, () => {
            const { server, shooter, target, firedSeqs } = runFight({ delays: profile.delays });

            const serverHits = new Set(server.damaged
                .filter(hit => hit.target === TARGET).map(hit => hit.damager));
            const impacts = server.world.entities.get(SHOOTER)
                ?.components.get(ShotImpactLogComponent)?.impacts ?? [];

            expect(serverHits.size).withContext('server hits').toBeGreaterThan(0);
            // Every damaging hit was reported to clients.
            expect(new Set(impacts.map(impact => loggedShotEntityId(SHOOTER, impact.seq))))
                .toEqual(serverHits);

            // Clients never apply damage on replicated ships themselves.
            expect(shooter.damaged.filter(hit => hit.target === TARGET)).toEqual([]);
            expect(target.damaged).toEqual([]);

            // The shooter's visual hits (predicted) match the server.
            const shooterVisualHits = new Set(shooter.feedback
                .filter(hit => hit.target === TARGET).map(hit => hit.damager));
            const disagreement = [...serverHits].filter(hit => !shooterVisualHits.has(hit)).length
                + [...shooterVisualHits].filter(hit => !serverHits.has(hit)).length;
            expect(disagreement).withContext('shooter/server hit disagreement')
                .toBeLessThanOrEqual(Math.ceil(firedSeqs.length * 0.1));

            console.info(`[fight] ${profile.name}: fired=${firedSeqs.length} server-hits=${serverHits.size} shooter-visual=${shooterVisualHits.size} disagreement=${disagreement}`);
        });
    }

    it('stays in agreement at high latency against a fast, strafing target', () => {
        const delays = [60, 120, 90, 110, 70, 100, 80];
        const { server, shooter, target, firedSeqs } = runFight({ delays }, true, 400);
        const serverHits = new Set(server.damaged
            .filter(hit => hit.target === TARGET).map(hit => hit.damager));
        const visual = new Set(shooter.feedback
            .filter(hit => hit.target === TARGET).map(hit => hit.damager));
        const disagreement = [...serverHits].filter(hit => !visual.has(hit)).length
            + [...visual].filter(hit => !serverHits.has(hit)).length;
        // The target also sees every server hit (via ShotImpact), never its own.
        const targetSeen = new Set(target.feedback
            .filter(hit => hit.target === TARGET).map(hit => hit.damager));
        console.info(`[fight] 60-120ms fast target: fired=${firedSeqs.length} server=${serverHits.size} shooter-visual=${visual.size} target-visual=${targetSeen.size} disagreement=${disagreement}`);
        expect(serverHits.size).toBeGreaterThan(0);
        expect(disagreement).toBeLessThanOrEqual(Math.ceil(firedSeqs.length * 0.1));
        expect(target.damaged).toEqual([]);
        expect(targetSeen).withContext('the victim sees exactly the server hits')
            .toEqual(serverHits);
    });
});
