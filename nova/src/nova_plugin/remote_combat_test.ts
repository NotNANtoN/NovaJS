import 'jasmine';
import { isRight } from 'nova_ecs/either';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import { RemoteMovementPresentationComponent, RemoteMovementPresentationSystem, queueRemoteMovementSnapshot, MovementStateComponent, MovementSystem, MovementPhysicsComponent, MovementType } from 'nova_ecs/plugins/movement_plugin';
import { ServerClockOffsetResource } from 'nova_ecs/plugins/multiplayer_plugin';
import { NetworkTiming, NetworkTimingResource } from 'nova_ecs/plugins/network_timing';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { Gettable } from 'novadatainterface/Gettable';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { getDefaultAnimation } from 'novadatainterface/Animation';
import { getDefaultSpriteSheetData } from 'novadatainterface/SpriteSheetData';
import { getDefaultBeamWeaponData, getDefaultProjectileWeaponData } from 'novadatainterface/WeaponData';
import { AnimationComponent } from './animation_plugin';
import { BeamPlugin, BeamStateComponent } from './beam_plugin';
import { CreateTime } from './create_time';
import { EntityBudgetPlugin, EntityBudgetResource } from './entity_budget';
import { FireWeaponPlugin, WeaponEntries } from './fire_weapon_plugin';
import { FireLog, FireLogComponent, getFireSyncLocalState, loggedShotEntityId, makeFireLogShot, rememberSpawnedShot } from './fire_sync';
import { GameDataResource } from './game_data_resource';
import { PlatformResource } from './platform_plugin';
import { ProjectilePlugin } from './projectile_plugin';
import { FireLogSpawnSystem } from './weapon_plugin';
import { TargetComponent } from './target_component';
import { DestructionStartedComponent } from './destruction_state';
import { SoundEvent } from './sound_event';

async function combatWorld(name: string, clockOffset = 0, beam = false) {
    const data = beam ? getDefaultBeamWeaponData() : getDefaultProjectileWeaponData();
    data.id = 'test:weapon';
    data.shotDuration = 2000;
    data.accuracy = 12;
    data.sound = 'test:sound';
    data.exitType = 'center';
    if (data.type === 'ProjectileWeaponData') {
        data.guidance = 'unguided';
        data.physics.speed = 600;
        data.physics.turnRate = 2;
    }
    const world = new World(name);
    world.resources.set(PlatformResource, name === 'server' ? 'node' : 'browser');
    world.resources.set(TimeResource, { time: 1000 + clockOffset, delta_ms: 0, delta_s: 0, frame: 0 });
    world.resources.set(ServerClockOffsetResource, { offset: clockOffset });
    world.resources.set(GameDataResource, { data: {
        Weapon: new Gettable(async () => data),
        SpriteSheet: new Gettable(async () => getDefaultSpriteSheetData()),
    } } as unknown as GameDataInterface);
    await world.addPlugin(DeltaPlugin);
    await world.addPlugin(EntityBudgetPlugin);
    await world.addPlugin(FireWeaponPlugin);
    await world.addPlugin(ProjectilePlugin);
    await world.addPlugin(BeamPlugin);
    world.addSystem(MovementSystem);
    world.addSystem(FireLogSpawnSystem);
    const weapon = (await world.resources.get(WeaponEntries)!.get(data.id))!;
    const ship = new Entity('ship').addComponent(AnimationComponent, getDefaultAnimation())
        .addComponent(MovementStateComponent, {
            position: new Position(10, 20), rotation: new Angle(0.2),
            velocity: new Vector(30, 0), accelerating: 0, turning: 0, turnBack: false,
        });
    world.entities.set('ship', ship);
    return { world, ship, weapon, data, time: world.resources.get(TimeResource)! };
}

function wireLog(log: FireLog): FireLog {
    const decoded = FireLog.decode(JSON.parse(JSON.stringify(FireLog.encode(log))));
    if (!isRight(decoded)) throw new Error('FireLog wire round-trip failed');
    return decoded.right;
}

describe('real remote combat replay and reconciliation', () => {
    it('converges shooter and two delayed observers on the server projectile without duplicate spawns', async () => {
        const server = await combatWorld('server');
        const shooter = await combatWorld('shooter', 3000);
        const observers = [await combatWorld('observer-a', -2000), await combatWorld('observer-b', 7000)];
        const id = loggedShotEntityId('ship', 1);
        const sounds: unknown[] = [];
        shooter.world.events.get(SoundEvent).subscribe(sound => sounds.push(sound));
        shooter.time.time -= 150;
        shooter.ship.components.get(MovementStateComponent)!.position = new Position(-100, -50);
        const predicted = shooter.weapon.fireFromEntityDetailed('ship', 42, true, 0, { entityId: id })!.entity;
        rememberSpawnedShot(getFireSyncLocalState(shooter.ship), 1, true);
        shooter.world.step();
        const soundCount = sounds.length;
        const fired = server.weapon.fireFromEntityDetailed('ship', 42, true, 0, { entityId: id })!;
        const log = { shots: [makeFireLogShot({ seq: 1, seed: 42, weaponId: server.data.id, exitIndex: 0 },
            1000, fired.position, fired.rotation, { sourceVelocity: fired.sourceVelocity, inaccuracy: fired.inaccuracy })] };
        server.time.time = 1100;
        server.time.delta_ms = 100;
        server.time.delta_s = 0.1;
        server.world.step();
        const authoritative = server.world.entities.get(id)!.components.get(MovementStateComponent)!;
        for (const client of [shooter, ...observers]) {
            const offset = client.world.resources.get(ServerClockOffsetResource)!.offset;
            client.time.time = 1100 + offset;
            client.ship.components.set(FireLogComponent, wireLog(log));
            client.world.step();
            const shot = client.world.entities.get(id)!;
            const movement = shot.components.get(MovementStateComponent)!;
            expect(movement.position.x).toBeCloseTo(authoritative.position.x, 8);
            expect(movement.position.y).toBeCloseTo(authoritative.position.y, 8);
            expect(movement.rotation.angle).toBeCloseTo(authoritative.rotation.angle, 8);
            expect(shot.components.get(CreateTime)! - offset).toBe(1000);
            expect(client.world.resources.get(EntityBudgetResource)!.active('projectile')).toBe(1);
            client.world.step();
            expect(client.world.entities.get(id)).toBe(shot);
        }
        expect(shooter.world.entities.get(id)).toBe(predicted);
        expect(sounds.length).toBe(soundCount);
    });

    it('presents ships and accepted shots at the same clock-corrected time', async () => {
        const client = await combatWorld('observer', 2000);
        const network = new NetworkTiming();
        const clock = network.clock('server');
        clock.offset = 2000;
        client.world.resources.set(NetworkTimingResource, network);
        const state = client.ship.components.get(MovementStateComponent)!;
        state.position = new Position(0, 0);
        state.velocity = new Vector(600, 0);
        const presentation = { snapshots: [], clock };
        queueRemoteMovementSnapshot(presentation, state, 1000);
        queueRemoteMovementSnapshot(presentation, { ...state, position: new Position(60, 0) }, 1100);
        client.ship.components.set(RemoteMovementPresentationComponent, presentation);
        client.ship.components.set(MovementPhysicsComponent, {
            maxVelocity: 600, acceleration: 0, turnRate: 0, movementType: MovementType.INERTIAL,
        });
        client.world.addSystem(RemoteMovementPresentationSystem);
        client.ship.components.set(FireLogComponent, { shots: [makeFireLogShot({
            seq: 1, seed: 1, weaponId: client.data.id, exitIndex: 0,
        }, 1000, new Position(0, 0), new Angle(Math.PI / 2), { sourceVelocity: new Vector(0, 0) })] });
        network.advance(3000);
        client.world.step();
        const id = loggedShotEntityId('ship', 1);
        expect(client.world.entities.has(id)).toBeFalse();
        expect(getFireSyncLocalState(client.ship).highestLogSeq).toBe(0);
        client.time.time = 3060;
        client.time.delta_ms = 16;
        client.time.delta_s = 0.016;
        network.advance(3060);
        client.world.step();
        const projectile = client.world.entities.get(id)!;
        expect(projectile.components.get(MovementStateComponent)!.position.x).toBeCloseTo(6, 6);
        expect(client.ship.components.get(MovementStateComponent)!.position.x).toBeCloseTo(6, 6);
        expect(projectile.components.get(CreateTime)).toBe(3050);
    });

    it('flies and expires replayed shots on simulation time when the server slows', async () => {
        const client = await combatWorld('observer');
        client.data.shotDuration = 200;
        const network = new NetworkTiming();
        const clock = network.clock('server');
        clock.rate = 0.6;
        client.world.resources.set(NetworkTimingResource, network);
        client.ship.components.set(FireLogComponent, { shots: [makeFireLogShot({
            seq: 1, seed: 1, weaponId: client.data.id, exitIndex: 0,
        }, 900, new Position(0, 0), new Angle(Math.PI / 2), { sourceVelocity: new Vector(0, 0) })] });
        network.advance(1000);
        client.world.step();
        const id = loggedShotEntityId('ship', 1);
        expect(client.world.entities.get(id)!.components.get(MovementStateComponent)!.position.x).toBeCloseTo(30, 6);
        for (let now = 1050; now <= 1200; now += 50) {
            client.time.time = now;
            client.time.delta_ms = 50;
            client.time.delta_s = 0.05;
            network.advance(now);
            client.world.step();
            const age = 50 + (now - 1000) * 0.6;
            expect(client.world.entities.get(id)!.components.get(MovementStateComponent)!.position.x).toBeCloseTo(age * 0.6, 6);
        }
        client.time.time = 1300;
        network.advance(1300);
        client.world.step();
        expect(client.world.entities.has(id)).toBeFalse();
    });

    it('does not resurrect a prediction already removed before confirmation', async () => {
        const client = await combatWorld('shooter');
        const id = loggedShotEntityId('ship', 1);
        const fired = client.weapon.fireFromEntityDetailed('ship', 1, true, 0, { entityId: id })!;
        client.world.entities.delete(id);
        const shot = makeFireLogShot({ seq: 1, seed: 1, weaponId: client.data.id, exitIndex: 0 },
            1000, fired.position, fired.rotation);
        client.weapon.reconcileFromLog('ship', shot, 1100);
        expect(client.world.entities.has(id)).toBeFalse();
    });

    it('replays an already-fired shot after source destruction without adopting a new target', async () => {
        const client = await combatWorld('observer');
        client.ship.components.set(DestructionStartedComponent, true);
        client.ship.components.set(TargetComponent, { target: 'new-target' });
        const shot = makeFireLogShot({ seq: 1, seed: 1, weaponId: client.data.id, exitIndex: 0 },
            1000, new Position(0, 0), new Angle(0));
        const projectile = client.weapon.fireFromLog('ship', shot, 1100)!;
        expect(projectile).toBeDefined();
        expect(projectile.components.has(TargetComponent)).toBeFalse();
    });

    it('does not guide ordinary bullets just because their source selected a target', async () => {
        const client = await combatWorld('observer');
        client.world.entities.set('target', new Entity().addComponent(MovementStateComponent, {
            position: new Position(500, 100), rotation: new Angle(0), velocity: new Vector(0, 0),
            accelerating: 0, turning: 0, turnBack: false,
        }).addComponent(MovementPhysicsComponent, {
            acceleration: 0, turnRate: 0, maxVelocity: 0, movementType: MovementType.STATIONARY,
        }));
        const shot = makeFireLogShot({ seq: 1, seed: 1, weaponId: client.data.id, exitIndex: 0, target: 'target' },
            1000, new Position(0, 0), new Angle(0));
        const projectile = client.weapon.fireFromLog('ship', shot, 1000)!;
        client.time.delta_s = 0.1;
        client.time.delta_ms = 100;
        client.world.step();
        expect(projectile.components.get(MovementStateComponent)!.rotation.angle).toBe(0);
    });

    it('corrects a live beam in place without reserving another beam or replaying audio', async () => {
        const client = await combatWorld('shooter', 0, true);
        const id = loggedShotEntityId('ship', 1);
        const fired = client.weapon.fireFromEntityDetailed('ship', 1, true, 0, { entityId: id })!;
        const shot = makeFireLogShot({ seq: 1, seed: 1, weaponId: client.data.id, exitIndex: 0 },
            1100, fired.position, fired.rotation, { inaccuracy: 0.03 });
        client.weapon.reconcileFromLog('ship', shot, 1200);
        expect(client.world.entities.get(id)).toBe(fired.entity);
        expect(fired.entity.components.get(CreateTime)).toBe(1100);
        expect(fired.entity.components.get(BeamStateComponent)!.inaccuracy).toBe(0.03);
        expect(client.world.resources.get(EntityBudgetResource)!.active('beam')).toBe(1);
        client.weapon.reconcileFromLog('ship', shot, 4000);
        expect(client.world.entities.has(id)).toBeFalse();
    });
});
