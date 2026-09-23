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
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { CommunicatorResource, MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { MockCommunicator } from 'nova_ecs/plugins/mock_communicator';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { DeltaPlugin } from 'nova_ecs/plugins/delta_plugin';
import { getDefaultBeamWeaponData, getDefaultProjectileWeaponData } from 'novadatainterface/WeaponData';
import { CollisionHitterComponent, CollisionVulnerabilityComponent } from './collision_interaction';
import {
    CollisionSystem, CompositeHull, HitboxHullComponent, HurtboxHullComponent,
    RBushResource, UpdateHitboxHullSystem, UpdateHurtboxHullSystem,
} from './collisions_plugin';
import { CreateTime } from './create_time';
import { DamagedEvent, HitFeedbackEvent } from './damage_events';
import { BeamDataComponent, BeamPlugin, BeamStateComponent } from './beam_plugin';
import { BeamContactComponent } from './beam_contact';
import { BlastDamageComponent, BlastPlugin, BlastShotComponent } from './blast_plugin';
import { FireSubs, WeaponConstructors } from './fire_weapon_plugin';
import { FireSyncPlugin, loggedShotEntityId, ShotImpactLogComponent } from './fire_sync';
import { PlatformResource } from './platform_plugin';
import { ProjectileCollisionSystem, ShotImpactApplySystem } from './projectile_plugin';

const SHOOTER = 'shooter-ship';
const TARGET = 'target-ship';
const BEAM = loggedShotEntityId(SHOOTER, 3);

function movement(x: number, y: number) {
    return {
        position: new Position(x, y), rotation: new Angle(0),
        velocity: new Vector(0, 0), accelerating: 0, turning: 0, turnBack: false,
    };
}

async function world(platform: 'node' | 'browser', localUuid = 'client-b') {
    const w = new World(`beam-blast-${platform}`);
    w.resources.set(PlatformResource, platform);
    w.resources.set(RBushResource, new RBush());
    w.resources.set(TimeResource, { time: 1000, frame: 1, delta_s: 1 / 60, delta_ms: 1000 / 60 });
    w.resources.set(WeaponConstructors, new Map());
    w.resources.set(FireSubs, () => []);
    w.resources.set(CommunicatorResource, new MockCommunicator(localUuid));
    await w.addPlugin(DeltaPlugin);
    await w.addPlugin(FireSyncPlugin);
    w.addSystem(UpdateHitboxHullSystem);
    w.addSystem(UpdateHurtboxHullSystem);
    w.addSystem(CollisionSystem);
    w.addSystem(ProjectileCollisionSystem);
    w.addSystem(ShotImpactApplySystem);
    await w.addPlugin(BeamPlugin);
    await w.addPlugin(BlastPlugin);

    w.entities.set(SHOOTER, new Entity()
        .addComponent(MultiplayerData, { owner: 'client-a' })
        .addComponent(MovementStateComponent, movement(0, 0)));
    const targetHull = new CompositeHull([new SAT.Box(new SAT.Vector(-2, -2), 4, 4).toPolygon()]);
    w.entities.set(TARGET, new Entity()
        .addComponent(MultiplayerData, { owner: 'client-b' })
        .addComponent(MovementStateComponent, movement(0, -10))
        .addComponent(HitboxHullComponent, targetHull)
        .addComponent(CollisionVulnerabilityComponent, { vulnerableTo: new Set(['normal']) }));

    const damaged: string[] = [];
    const feedback: Array<{ target: string, kind: string }> = [];
    w.addSystem(new System({
        name: 'record-damage', events: [DamagedEvent],
        args: [UUID] as const, step(id) { damaged.push(id); },
    }));
    w.addSystem(new System({
        name: 'record-feedback', events: [HitFeedbackEvent],
        args: [HitFeedbackEvent, UUID] as const,
        step(hit, id) { feedback.push({ target: id, kind: hit.kind }); },
    }));
    return { world: w, damaged, feedback };
}

function addBeam(w: World) {
    const data = getDefaultBeamWeaponData();
    data.shotDuration = 10_000;
    data.beamAnimation.length = 20;
    data.beamAnimation.width = 2;
    const beam = new Entity()
        .addComponent(HurtboxHullComponent, new CompositeHull([
            new SAT.Polygon(new SAT.Vector(), [new SAT.Vector(-1, 0),
                new SAT.Vector(-1, -20), new SAT.Vector(1, -20), new SAT.Vector(1, 0)]),
        ]))
        .addComponent(BeamDataComponent, data)
        .addComponent(BeamStateComponent, { inaccuracy: 0 })
        .addComponent(CreateTime, 900)
        .addComponent(CollisionHitterComponent, { hitTypes: new Set(['normal']) })
        .addComponent(MovementStateComponent, movement(0, 0));
    w.entities.set(BEAM, beam);
    return beam;
}

function advance(w: World, ms = 1000 / 60) {
    const time = w.resources.get(TimeResource)!;
    time.time += ms;
    w.step();
}

describe('beam hit authority', () => {
    it('server damages and reports a beam contact once, then its end', async () => {
        const { world: w, damaged } = await world('node');
        addBeam(w);
        advance(w);
        advance(w);
        expect(damaged.length).toBeGreaterThan(0);
        const impacts = () => w.entities.get(SHOOTER)!
            .components.get(ShotImpactLogComponent)?.impacts ?? [];
        expect(impacts().length).toBe(1);
        expect(impacts()[0]).toEqual(jasmine.objectContaining({
            kind: 'beam', seq: 3, target: TARGET,
        }));
        // Continuous contact does not spam impacts.
        advance(w);
        advance(w);
        expect(impacts().length).toBe(1);
        // Target leaves the beam: one more impact with no target.
        w.entities.get(TARGET)!.components.get(MovementStateComponent)!.position
            = new Position(500, 500);
        advance(w);
        advance(w);
        expect(impacts().length).toBe(2);
        expect(impacts()[1].target).toBeUndefined();
    });

    it("an observer leaves another player's beam contact to the server", async () => {
        const { world: w, damaged, feedback } = await world('browser', 'client-b');
        const beam = addBeam(w);
        advance(w);
        expect(damaged).toEqual([]);
        expect(feedback).toEqual([]);
        expect(beam.components.get(BeamStateComponent)!.length).toBe(20);

        // Server says the beam hits the target at y = -8.
        w.entities.get(SHOOTER)!.components.set(ShotImpactLogComponent, { impacts: [{
            impactSeq: 1, seq: 3, at: 900, kind: 'beam', target: TARGET,
            position: new Position(0, -8),
        }] });
        advance(w);
        advance(w);
        expect(beam.components.get(BeamContactComponent)?.target).toBe(TARGET);
        expect(beam.components.get(BeamStateComponent)!.length).toBeCloseTo(8);
        expect(feedback).toContain({ target: TARGET, kind: 'beam' });
        expect(damaged).toEqual([]);

        // Server says the beam no longer hits anything.
        w.entities.get(SHOOTER)!.components.set(ShotImpactLogComponent, { impacts: [{
            impactSeq: 2, seq: 3, at: 950, kind: 'beam',
            position: new Position(0, -20),
        }] });
        advance(w);
        advance(w);
        expect(beam.components.get(BeamContactComponent)?.target).toBeUndefined();
        expect(beam.components.get(BeamStateComponent)!.length).toBe(20);
    });

    it('the shooter predicts its own beam contact and shows feedback without damage', async () => {
        const { world: w, feedback } = await world('browser', 'client-a');
        w.entities.get(TARGET)!.components.set(MultiplayerData, { owner: 'client-b' });
        const beam = addBeam(w);
        advance(w);
        advance(w);
        expect(beam.components.get(BeamStateComponent)!.length).toBeLessThan(20);
        expect(beam.components.get(BeamContactComponent)?.target).toBe(TARGET);
        expect(feedback).toContain({ target: TARGET, kind: 'beam' });
    });
});

describe('blast hit authority', () => {
    function addBlast(w: World) {
        const damage = getDefaultProjectileWeaponData().damage;
        w.entities.set('blast', new Entity()
            .addComponent(BlastDamageComponent, damage)
            .addComponent(BlastShotComponent, { source: SHOOTER, seq: 5 })
            .addComponent(HurtboxHullComponent, new CompositeHull([
                new SAT.Circle(new SAT.Vector(), 30)]))
            .addComponent(CollisionHitterComponent, { hitTypes: new Set(['normal']) })
            .addComponent(MovementStateComponent, movement(0, 0)));
    }

    it('server damages ships in a synchronized blast and reports each as a ShotImpact', async () => {
        const { world: w, damaged } = await world('node');
        addBlast(w);
        advance(w);
        expect(damaged).toEqual([TARGET]);
        const impacts = w.entities.get(SHOOTER)!.components.get(ShotImpactLogComponent)!.impacts;
        expect(impacts).toEqual([jasmine.objectContaining({
            kind: 'blast', seq: 5, target: TARGET,
        })]);
    });

    it('clients do not resolve synchronized blasts on replicated ships', async () => {
        const { world: w, damaged } = await world('browser');
        addBlast(w);
        advance(w);
        expect(damaged).toEqual([]);
    });

    it('clients show hit feedback for server-reported blast hits', async () => {
        const { world: w, feedback } = await world('browser');
        w.entities.get(SHOOTER)!.components.set(ShotImpactLogComponent, { impacts: [{
            impactSeq: 1, seq: 5, at: 1000, kind: 'blast', target: TARGET,
            position: new Position(0, 0),
        }] });
        advance(w);
        expect(feedback).toEqual([{ target: TARGET, kind: 'blast' }]);
    });
});
