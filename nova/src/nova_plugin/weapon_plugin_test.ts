import 'jasmine';
import { createDraft, finishDraft } from 'immer';
import { Gettable } from 'novadatainterface/Gettable';
import { getDefaultProjectileWeaponData } from 'novadatainterface/WeaponData';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Entity } from 'nova_ecs/entity';
import { MockCommunicator } from 'nova_ecs/plugins/mock_communicator';
import {
    CommunicatorResource,
    MultiplayerData,
} from 'nova_ecs/plugins/multiplayer_plugin';
import { DefaultMap } from 'nova_ecs/utils';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import {
    getDefaultWeaponLocalState,
    WeaponEntries,
    WeaponEntry,
    WeaponLocalState,
    WeaponsComponent,
    WeaponsComponentProvider,
} from './fire_weapon_plugin';
import { WeaponsStateComponent } from './weapons_state';
import {
    applyWeaponTrigger,
    clearWeaponFiringState,
    FireLogSpawnSystem,
    ReleaseWeaponTriggerSystem,
    ServerFireIntentSystem,
    ServerFireCadenceComponent,
    weaponShotRateCeiling,
    worldOwnsWeaponCadence,
    WeaponsSystem,
    WeaponBurstPaymentsComponent,
} from './weapon_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { DisabledComponent } from './death_plugin';
import { JumpStateComponent } from './jump_plugin';
import { ShipComponent, ShipDataComponent } from './ship_plugin';
import {
    CombatAuthority, CombatAuthorityComponent, CombatLedger,
    copyCombatResources, registerCombatAmmoIds,
} from './combat_resources';
import {
    CombatResources, createInitialPlayerState, PlayerStateComponent,
    toPersistentPlayerState,
} from './player_state';
import { SystemIdResource } from './system_id_resource';
import { ArmorComponent } from './health_plugin';
import { Stat } from './stat';
import { PlatformResource } from './platform_plugin';
import {
    FireIntent,
    FireIntentComponent,
    FireIntentDelta,
    FireLogComponent,
    getFireSyncLocalState,
} from './fire_sync';

import { OutfitsStateComponent } from './outfit_plugin';

const STEP_MS = 1000 / 60;

function configureWeaponWorld(world: World): void {
    world.resources.set(PlatformResource, 'node');
    world.resources.set(CommunicatorResource, new MockCommunicator('server'));
}

/** Real cost authority; only persistence is faked, never canPay/withCost. */
function attachCombatAuthority(ship: Entity, ammo = 10, fuel = 100) {
    const state = createInitialPlayerState();
    state.shipId = ship.components.get(ShipComponent)?.id ?? state.shipId;
    state.fuel = fuel;
    ship.components.set(PlayerStateComponent, state);
    if (!ship.components.has(OutfitsStateComponent)) {
        ship.components.set(OutfitsStateComponent, new Map());
    }
    registerCombatAmmoIds(['ammo']);
    const persisted: CombatResources[] = [];
    const persist = jasmine.createSpy('ledger.persist').and.callFake((authority: CombatAuthority) => {
        persisted.push(copyCombatResources(authority.balance));
    });
    const authority = new CombatAuthority({ persist } as unknown as CombatLedger,
        'test-pilot', { shipId: state.shipId, fuel, ammo: { ammo }, revision: 0 },
        toPersistentPlayerState(state) as typeof state);
    ship.components.set(CombatAuthorityComponent, authority);
    authority.commit();
    authority.project(ship);
    persist.calls.reset();
    persisted.length = 0;
    return { authority, persist, persisted };
}

describe('weapon simulation ownership', () => {
    it('runs server-owned cadence only on the server', () => {
        expect(worldOwnsWeaponCadence('node', 'server', 'server')).toBeTrue();
        expect(worldOwnsWeaponCadence('browser', 'server', 'client'))
            .toBeFalse();
    });

    it('runs client cadence only in the owning browser', () => {
        expect(worldOwnsWeaponCadence('browser', 'client-a', 'client-a'))
            .toBeTrue();
        expect(worldOwnsWeaponCadence('browser', 'client-a', 'client-b'))
            .toBeFalse();
        expect(worldOwnsWeaponCadence('node', 'client-a', 'server')).toBeFalse();
    });

    it('does not mutate cadence state for a remotely owned ship', () => {
        const shots: number[] = [];
        const time = {
            time: 0,
            delta_ms: STEP_MS,
            delta_s: STEP_MS / 1000,
            frame: 0,
        };
        const entries = makeWeapon(() => false, shots, time);
        const local = new DefaultMap<string, WeaponLocalState>(
            getDefaultWeaponLocalState);
        local.get('test-weapon').shotsOwed = 0.5;
        const world = new World('remote-weapon-owner-test');
        configureWeaponWorld(world);
        world.resources.set(TimeResource, time);
        world.resources.set(WeaponEntries, entries);
        world.addSystem(WeaponsSystem);
        world.entities.set('remote-player', new Entity()
            .addComponent(WeaponsStateComponent, new Map([
                ['test-weapon', { count: 1, firing: true }],
            ]))
            .addComponent(WeaponsComponent, local)
            .addComponent(MultiplayerData, { owner: 'client' }));

        world.step();

        expect(shots).toEqual([]);
        expect(local.get('test-weapon').shotsOwed).toBe(0.5);
        expect(local.get('test-weapon').pressObserved).toBeFalse();
    });
});

describe('server fire intent watermark', () => {
    const invalidShots = [
        { name: 'unsafe sequence', seq: Number.MAX_SAFE_INTEGER + 1, seed: 1, exitIndex: 0 },
        { name: 'fractional sequence', seq: 100.5, seed: 1, exitIndex: 0 },
        { name: 'invalid seed', seq: 100, seed: -1, exitIndex: 0 },
        { name: 'invalid exit index', seq: 100, seed: 1, exitIndex: 0.5 },
    ];

    for (const invalid of invalidShots) {
        it(`does not let ${invalid.name} poison the watermark`, () => {
            const shots: number[] = [];
            const time = {
                time: 0,
                delta_ms: STEP_MS,
                delta_s: STEP_MS / 1000,
                frame: 0,
            };
            const entries = makeWeapon(() => false, shots, time);
            Object.assign(entries.getCached('test-weapon')!, {
                syncAsFireEvent: true,
            });
            const world = new World('fire-intent-watermark-test');
            configureWeaponWorld(world);
            world.resources.set(TimeResource, time);
            world.resources.set(WeaponEntries, entries);
            world.addSystem(ServerFireIntentSystem);
            const first = { seq: 1, weaponId: 'test-weapon', seed: 1, exitIndex: 0 };
            const ship = new Entity('remote-player')
                .addComponent(WeaponsStateComponent, new Map([
                    ['test-weapon', { count: 1, firing: true }],
                ]))
                .addComponent(MultiplayerData, { owner: 'client' })
                .addComponent(FireIntentComponent, { shots: [first] });
            attachCombatAuthority(ship);
            world.entities.set('remote-player', ship);
            world.step();
            expect(shots.length).toBe(1);
            const sync = getFireSyncLocalState(ship);
            expect(sync.highestIntentSeq).toBe(1);

            // These malformed numbers survive JSON and both wire codecs.
            const payload = JSON.parse(JSON.stringify({ shots: [{
                weaponId: 'test-weapon',
                seq: invalid.seq,
                seed: invalid.seed,
                exitIndex: invalid.exitIndex,
            }] }));
            const decoded = FireIntent.decode(payload);
            expect(decoded._tag).toBe('Right');
            expect(FireIntentDelta.decode(payload)._tag).toBe('Right');
            if (decoded._tag !== 'Right') {
                return;
            }
            ship.components.set(FireIntentComponent, decoded.right);
            world.step();
            expect(sync.highestIntentSeq).toBe(1);
            expect(shots.length).toBe(1);
            expect(ship.components.get(FireLogComponent)!.shots.map(s => s.seq))
                .toEqual([1]);

            ship.components.set(FireIntentComponent, {
                shots: [first, { ...first, seq: 2 }],
            });
            world.step();
            expect(sync.highestIntentSeq).toBe(2);
            expect(shots.length).toBe(1); // Accepted into the queue, not fired early.
            time.time = 500;
            world.step();
            expect(shots.length).toBe(2);
            expect(ship.components.get(FireLogComponent)!.shots.map(s => s.seq))
                .toEqual([1, 2]);
            expect([...sync.spawnedSeqs]).toEqual([1, 2]);

            world.step();
            expect(shots.length).toBe(2);
            expect(ship.components.get(FireLogComponent)!.shots.map(s => s.seq))
                .toEqual([1, 2]);
        });
    }
});

describe('authoritative server intent scheduling', () => {
    function setup(configure: Parameters<typeof makeWeapon>[3] = () => undefined, count = 1) {
        const time = { time: 0, delta_ms: 0, delta_s: 0, frame: 0 };
        const shots: number[] = [];
        let blocked = false;
        const entries = makeWeapon(() => blocked, shots, time, configure);
        const entry = entries.getCached('test-weapon')!;
        Object.assign(entry, { syncAsFireEvent: true, fireFromLog: jasmine.createSpy('replay') });
        const world = new World('server-cadence-test');
        configureWeaponWorld(world);
        world.resources.set(TimeResource, time);
        world.resources.set(WeaponEntries, entries);
        world.resources.set(SystemIdResource, 'system-a');
        world.addSystem(ServerFireIntentSystem);
        const ship = new Entity('ship')
            .addComponent(MultiplayerData, { owner: 'client' })
            .addComponent(ShipComponent, { id: 'hull-a' })
            .addComponent(WeaponsStateComponent, new Map([
                ['test-weapon', { count, firing: false }],
            ]));
        attachCombatAuthority(ship);
        world.entities.set('ship', ship);
        const send = (...seqs: number[]) => ship.components.set(FireIntentComponent, {
            shots: seqs.map(seq => ({ seq, weaponId: 'test-weapon', seed: seq, exitIndex: 0 })),
        });
        const tick = (at: number) => { time.time = at; world.step(); };
        return { world, ship, entry, entries, time, shots, send, tick,
            block: (value: boolean) => { blocked = value; },
            log: () => ship.components.get(FireLogComponent)?.shots ?? [],
            local: () => ship.components.get(ServerFireCadenceComponent)!,
        };
    }

    it('drains a batch on later ticks without more arrivals or a held trigger', () => {
        const f = setup();
        f.send(1, 2, 3);
        f.tick(100);
        expect(f.shots).toEqual([100]);
        f.tick(599);
        expect(f.shots).toEqual([100]);
        f.tick(600);
        f.tick(1100);
        expect(f.shots).toEqual([100, 600, 1100]);
        expect(f.log().map(s => [s.seq, s.at, s.logSeq])).toEqual([
            [1, 100, 1], [2, 600, 2], [3, 1100, 3],
        ]);
    });

    it('a flood cannot produce extra sustained shots at 500ms reload', () => {
        const f = setup();
        let seq = 0;
        for (let at = 0; at <= 3000; at += 100) {
            f.send(...Array.from({ length: 16 }, () => ++seq));
            f.tick(at);
            f.world.step();
            expect(f.local().cadence.pendingCount('test-weapon')).toBeLessThanOrEqual(16);
        }
        expect(f.shots).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000]);
        expect(getFireSyncLocalState(f.ship).spawnedSeqs.size).toBeLessThanOrEqual(16);
    });

    it('enforces burstReload for queued bursts', () => {
        const f = setup(data => { data.reload = 100; data.burstCount = 3; data.burstReload = 1000; });
        f.send(1, 2, 3, 4);
        for (const at of [0, 100, 200, 300, 1199, 1200]) f.tick(at);
        expect(f.shots).toEqual([0, 100, 200, 1200]);
    });

    for (const simultaneous of [false, true]) {
        it(`honors installed copies (simultaneous=${simultaneous})`, () => {
            const f = setup(data => { data.fireSimultaneously = simultaneous; }, 2);
            f.send(1, 2, 3, 4);
            for (const at of [0, 250, 500, 750]) f.tick(at);
            expect(f.shots).toEqual(simultaneous ? [0, 0, 500, 500] : [0, 250, 500, 750]);
        });
    }

    it('expires pending shots without replaying the retained intent buffer', () => {
        const f = setup();
        f.send(1, 2, 3);
        f.tick(0);
        f.tick(2000);
        f.tick(3000);
        expect(f.shots).toEqual([0]);
        expect(f.local().cadence.pendingCount('test-weapon')).toBe(0);
        expect(getFireSyncLocalState(f.ship).highestIntentSeq).toBe(3);
    });

    it('bounds backlog, advances dropped sequences and does not refill on FireIntent removal', () => {
        const f = setup();
        f.send(...Array.from({ length: 100 }, (_, i) => i + 1));
        f.tick(0);
        const state = f.local();
        expect(state.cadence.pendingCount('test-weapon')).toBe(15);
        expect(getFireSyncLocalState(f.ship).highestIntentSeq).toBe(100);
        f.ship.components.delete(FireIntentComponent);
        f.tick(10);
        expect(state.cadence.pendingCount('test-weapon')).toBe(0);
        f.send(1, 100);
        f.tick(20);
        f.send(101);
        f.tick(30);
        expect(f.local()).toBe(state);
        expect(f.shots).toEqual([0]);
        f.tick(500);
        expect(f.log().map(s => s.seq)).toEqual([1, 101]);
    });

    it('detaches intent and clock drafts before deferred emission', () => {
        const f = setup();
        f.send(1, 2);
        const intent = createDraft(f.ship.components.get(FireIntentComponent)!);
        intent.shots[1].target = 'original-target';
        const time = createDraft(f.time);
        f.ship.components.set(FireIntentComponent, intent);
        f.world.resources.set(TimeResource, time);
        const fire = spyOn(f.entry, 'fireFromEntityDetailed').and.callThrough();
        f.world.step();
        // Changing the source draft after enqueue cannot change the snapshot.
        intent.shots[1].target = 'changed-target';
        intent.shots[1].seed = 999;
        const completed = finishDraft(intent);
        finishDraft(time);
        f.ship.components.set(FireIntentComponent, completed);
        f.world.resources.set(TimeResource, f.time);
        expect(() => f.tick(500)).not.toThrow();
        const args = fire.calls.mostRecent().args;
        expect(args[1]).toBe(2);
        expect(args[4]?.target).toBe('original-target');
        expect(f.log().map(s => s.at)).toEqual([0, 500]);
    });

    const jump = {
        from: 'system-a', to: 'system-b', phase: 'braking' as const,
        phaseStartedAt: 1, transitionAt: 1000, requiresAdjacency: true,
        arrivalSoundPending: false,
    };
    for (const reason of ['death', 'jump', 'disabled', 'zero armor'] as const) {
        it(`cancels pending and blocked intents on ${reason}, including recovery`, () => {
            const f = setup();
            f.send(1, 2);
            f.tick(0);
            if (reason === 'death') f.ship.components.set(DestructionStartedComponent, true);
            if (reason === 'jump') f.ship.components.set(JumpStateComponent, jump);
            if (reason === 'disabled') f.ship.components.set(DisabledComponent, true);
            if (reason === 'zero armor') f.ship.components.set(ArmorComponent, new Stat({ current: 0, max: 100, recharge: 0 }));
            f.send(2, 3);
            f.tick(500);
            f.ship.components.delete(DestructionStartedComponent);
            f.ship.components.delete(JumpStateComponent);
            f.ship.components.delete(DisabledComponent);
            f.ship.components.delete(ArmorComponent);
            f.send(2, 3, 4);
            f.tick(1000); // Discard the recovery buffer too.
            f.tick(2000);
            expect(f.shots).toEqual([0]);
            f.send(5);
            f.tick(2100);
            expect(f.log().map(s => s.seq)).toEqual([1, 5]);
        });
    }

    it('catches death and revival between ticks', () => {
        const f = setup();
        f.send(1, 2);
        f.tick(0);
        f.ship.components.set(DestructionStartedComponent, true);
        f.ship.components.delete(DestructionStartedComponent);
        f.tick(500);
        f.tick(1000);
        expect(f.shots).toEqual([0]);
    });

    for (const reason of ['owner', 'hull', 'system'] as const) {
        it(`discards the transition buffer on a ${reason} change, retaining debt`, () => {
            const f = setup();
            f.send(1, 2);
            f.tick(0);
            if (reason === 'owner') f.ship.components.set(MultiplayerData, { owner: 'other' });
            if (reason === 'hull') f.ship.components.set(ShipComponent, { id: 'hull-b' });
            if (reason === 'system') f.world.resources.set(SystemIdResource, 'system-b');
            f.send(2, 3);
            f.tick(10);
            f.send(2, 3, 4);
            f.tick(20);
            expect(f.shots).toEqual([0]);
            f.tick(500);
            expect(f.log().map(s => s.seq)).toEqual([1, 4]);
        });
    }

    it('clears pending when weapons disappear and rejects malformed counts', () => {
        const f = setup();
        f.send(1, 2);
        f.tick(0);
        f.ship.components.delete(WeaponsStateComponent);
        f.tick(10);
        f.ship.components.set(WeaponsStateComponent, new Map([
            ['test-weapon', { count: NaN, firing: true }],
        ]));
        f.send(3);
        f.tick(20);
        f.tick(30);
        expect(f.local().cadence.pendingCount('test-weapon')).toBe(0);
        expect(f.shots).toEqual([0]);
        f.ship.components.get(WeaponsStateComponent)!.get('test-weapon')!.count = 1;
        f.send(4);
        f.tick(40);
        f.tick(500);
        expect(f.log().map(s => s.seq)).toEqual([1, 4]);
    });

    it('failed creation retries without charging cadence, and eventually expires', () => {
        const f = setup();
        f.send(1, 2);
        f.block(true);
        f.tick(0);
        expect(f.log()).toEqual([]);
        f.block(false);
        f.tick(100);
        expect(f.shots).toEqual([100]);
        f.block(true);
        f.tick(600);
        f.tick(2000);
        f.block(false);
        f.tick(2100);
        expect(f.shots).toEqual([100]);
    });

    it('preserves emission order across weapons without replaying server spawns', () => {
        const f = setup();
        const other = { ...f.entry, data: { ...f.entry.data, id: 'other' } } as WeaponEntry;
        f.entries.gotten.other = other;
        f.ship.components.get(WeaponsStateComponent)!.set('other', { count: 1, firing: false });
        f.send(1, 2);
        f.ship.components.get(FireIntentComponent)!.shots.push({
            seq: 3, weaponId: 'other', seed: 3, exitIndex: 0,
        });
        f.world.addSystem(FireLogSpawnSystem);
        f.tick(0);
        f.tick(500);
        expect(f.log().map(s => [s.seq, s.logSeq])).toEqual([[1, 1], [3, 2], [2, 3]]);
        expect(f.entry.fireFromLog).not.toHaveBeenCalled();
        expect(getFireSyncLocalState(f.ship).highestLogSeq).toBe(3);
    });
});

describe('weapon cost authority', () => {
    function setup(options: {
        owner?: string, simultaneous?: boolean, count?: number,
        burst?: boolean, ammo?: number, energy?: boolean, fuel?: number,
    } = {}) {
        const shots: number[] = [];
        let blocked = false;
        const time = { time: 0, delta_ms: 0, delta_s: 0, frame: 0 };
        const entries = makeWeapon(() => blocked, shots, time, data => {
            data.ammoType = options.energy ? ['energy', 5] : ['outfit', 'ammo'];
            data.fireSimultaneously = options.simultaneous ?? false;
            data.burstCount = options.burst ? 2 : 0;
            data.oneAmmoPerBurst = options.burst ?? false;
            data.burstReload = 1000;
        });
        const entry = entries.getCached('test-weapon')!;
        Object.assign(entry, { syncAsFireEvent: true });
        const local = new DefaultMap<string, WeaponLocalState>(getDefaultWeaponLocalState);
        const ship = new Entity('ship')
            .addComponent(WeaponsStateComponent, new Map([
                ['test-weapon', { count: options.count ?? 1, firing: true }],
            ]))
            .addComponent(WeaponsComponent, local)
            .addComponent(MultiplayerData, { owner: options.owner ?? 'server' })
            .addComponent(OutfitsStateComponent, new Map([
                ['ammo', { count: options.ammo ?? 1 }],
            ]))
            .addComponent(ShipDataComponent, {
                ...getDefaultShipData(), fuelCapacity: options.fuel ?? 10,
            });
        const combat = options.owner && options.owner !== 'server'
            ? attachCombatAuthority(ship, options.ammo ?? 1, options.fuel ?? 10)
            : undefined;
        const world = new World('weapon-cost-test');
        configureWeaponWorld(world);
        world.resources.set(TimeResource, time);
        world.resources.set(WeaponEntries, entries);
        world.addSystem(WeaponsSystem);
        world.addSystem(ServerFireIntentSystem);
        world.entities.set('ship', ship);
        return { world, ship, shots, time, local, entry, entries, combat,
            send: (...seqs: number[]) => ship.components.set(FireIntentComponent, {
                shots: seqs.map(seq => ({ seq, weaponId: 'test-weapon', seed: seq, exitIndex: 0 })),
            }),
            block: (value: boolean) => { blocked = value; },
            ammo: () => ship.components.get(OutfitsStateComponent)?.get('ammo')?.count ?? 0,
            fuel: () => ship.components.get(PlayerStateComponent)?.fuel,
            log: () => ship.components.get(FireLogComponent)?.shots ?? [],
            advance: (ms: number) => {
                time.time += ms;
                time.delta_ms = ms;
                world.step();
            },
        };
    }

    it('charges only successful server-owned shots and rejects exhausted ammo', () => {
        const test = setup();
        test.block(true);
        test.world.step();
        expect(test.ammo()).toBe(1);
        test.block(false);
        test.world.step();
        expect(test.ammo()).toBe(0);
        test.advance(500);
        expect(test.shots.length).toBe(1);
        expect(test.ship.components.get(FireLogComponent)!.shots.length).toBe(1);
    });

    it('rejects NPC outfit shots with no inventory component', () => {
        const test = setup();
        test.ship.components.delete(OutfitsStateComponent);
        test.world.step();
        expect(test.shots).toEqual([]);
    });

    it('charges each non-burst salvo projectile without overdrawing', () => {
        const test = setup({ simultaneous: true, count: 3, ammo: 2 });
        test.world.step();
        expect(test.shots.length).toBe(2);
        expect(test.ammo()).toBe(0);
        test.advance(500);
        expect(test.shots.length).toBe(2);
    });

    for (const simultaneous of [false, true]) {
        it(`funds each installed copy once per burst (simultaneous=${simultaneous})`, () => {
            const test = setup({ simultaneous, count: 2, burst: true, ammo: 2 });
            test.world.step();
            for (let i = 0; i < 3; i++) test.advance(250);
            expect(test.shots.length).toBe(4);
            expect(test.ammo()).toBe(0);
            test.advance(1000);
            expect(test.shots.length).toBe(4);
        });
    }

    for (const simultaneous of [false, true]) {
        it(`retains burst payments across draft replacement (simultaneous=${simultaneous})`, () => {
            const test = setup({ simultaneous, count: 2, burst: true, ammo: 2 });
            const tick = (ms: number) => {
                const previous = test.ship.components.get(WeaponsComponent)!;
                const cadence = new DefaultMap<string, WeaponLocalState>(getDefaultWeaponLocalState);
                const weaponState = createDraft(previous.get('test-weapon'));
                cadence.set('test-weapon', weaponState);
                const outfits = createDraft(test.ship.components.get(OutfitsStateComponent)!);
                const payments = createDraft(
                    test.ship.components.get(WeaponBurstPaymentsComponent) ?? new Map<string, Set<number>>());
                test.ship.components.set(WeaponsComponent, cadence);
                test.ship.components.set(OutfitsStateComponent, outfits);
                test.ship.components.set(WeaponBurstPaymentsComponent, payments);
                expect(cadence.get('test-weapon'))
                    .not.toBe(previous.get('test-weapon'));
                try {
                    test.advance(ms);
                } finally {
                    cadence.set('test-weapon', finishDraft(weaponState));
                    test.ship.components.set(WeaponsComponent, cadence);
                    test.ship.components.set(OutfitsStateComponent, finishDraft(outfits));
                    test.ship.components.set(WeaponBurstPaymentsComponent, finishDraft(payments));
                }
            };
            tick(0);
            for (let i = 0; i < 3; i++) tick(250);
            expect(test.shots.length).toBe(4);
            expect(test.ammo()).toBe(0);
            tick(1000);
            expect(test.shots.length).toBe(4);

            test.ship.components.get(OutfitsStateComponent)!.set('ammo', { count: 2 });
            tick(0);
            for (let i = 0; i < 3; i++) tick(250);
            expect(test.shots.length).toBe(8);
            expect(test.ammo()).toBe(0);
        });
    }

    it('does not grant unpaid copies free shots after a partial salvo', () => {
        const test = setup({ simultaneous: true, count: 2, burst: true });
        test.world.step();
        test.advance(500);
        expect(test.shots.length).toBe(2);
        expect(test.ammo()).toBe(0);
    });

    it('charges every shot when oneAmmoPerBurst has no finite burst', () => {
        const test = setup();
        Object.assign(test.entry.data, { oneAmmoPerBurst: true });
        test.world.step();
        test.advance(500);
        expect(test.shots.length).toBe(1);
    });

    for (const ammo of [0, -1, 0.5, NaN, Infinity]) {
        it(`rejects unusable outfit balance ${ammo}`, () => {
            const test = setup({ ammo });
            test.world.step();
            expect(test.shots).toEqual([]);
        });
    }

    it('uses finite NPC hull fuel and does not spend it on failed creation', () => {
        const test = setup({ energy: true, fuel: 5 });
        test.block(true);
        test.world.step();
        expect(test.shots).toEqual([]);
        test.block(false);
        test.world.step();
        expect(test.shots.length).toBe(1);
        test.advance(500);
        expect(test.shots.length).toBe(1);
        expect(test.log().length).toBe(1);
        expect(test.ammo()).toBe(1);
    });

    it('uses existing NPC PlayerState fuel rather than refilling from hull capacity', () => {
        const test = setup({ energy: true, fuel: 100 });
        const state = createInitialPlayerState();
        state.fuel = 5;
        test.ship.components.set(PlayerStateComponent, state);
        test.world.step();
        expect(test.shots.length).toBe(1);
        expect(test.fuel()).toBe(0);
        test.advance(500);
        expect(test.shots.length).toBe(1);
        expect(test.fuel()).toBe(0);
    });

    for (const energy of [false, true]) {
        it(`rejects insufficient player resources without shots, logs or persistence (energy=${energy})`, () => {
            const test = setup({ owner: 'client', ammo: 0, fuel: 4, energy });
            const fire = spyOn(test.entry, 'fireFromEntityDetailed').and.callThrough();
            test.send(1);
            test.world.step();
            test.advance(500);
            expect(fire).not.toHaveBeenCalled();
            expect(test.shots).toEqual([]);
            expect(test.log()).toEqual([]);
            expect(test.combat!.persist).not.toHaveBeenCalled();
            expect(test.combat!.authority.balance.fuel).toBe(4);
            expect(test.combat!.authority.balance.ammo.ammo).toBe(0);
            expect(getFireSyncLocalState(test.ship).highestIntentSeq).toBe(1);
        });

        it(`debits player resources once, projects depletion and stops the next shot (energy=${energy})`, () => {
            const test = setup({ owner: 'client', ammo: 1, fuel: 5, energy });
            test.send(1, 2);
            test.world.step();
            expect(test.log().map(s => s.seq)).toEqual([1]);
            expect(test.combat!.persisted.length).toBe(1);
            expect(test.fuel()).toBe(energy ? 0 : 5);
            expect(test.ammo()).toBe(energy ? 1 : 0);
            expect(test.combat!.persisted[0].fuel).toBe(energy ? 0 : 5);
            expect(test.combat!.persisted[0].ammo.ammo).toBe(energy ? 1 : 0);
            expect(test.ship.components.get(PlayerStateComponent)!.combatResources)
                .toEqual(test.combat!.authority.balance);
            test.advance(500);
            expect(test.shots.length).toBe(1);
            expect(test.log().map(s => s.seq)).toEqual([1]);
            expect(test.combat!.persist).toHaveBeenCalledTimes(1);
        });

        for (const burst of [false, true]) {
            it(`failed player spawn spends neither cost nor cadence (energy=${energy}, burst=${burst})`, () => {
                const test = setup({ owner: 'client', ammo: 1, fuel: 5, energy, burst });
                test.send(1, 2);
                test.block(true);
                test.world.step();
                expect(test.log()).toEqual([]);
                expect(test.combat!.persist).not.toHaveBeenCalled();
                expect(test.ammo()).toBe(1);
                expect(test.fuel()).toBe(5);
                test.block(false);
                test.world.step(); // Same server time: failure did not spend cadence.
                expect(test.shots.length).toBe(1);
                expect(test.combat!.persist).toHaveBeenCalledTimes(1);
                test.advance(500);
                expect(test.shots.length).toBe(burst ? 2 : 1);
                expect(test.combat!.persist).toHaveBeenCalledTimes(1);
            });
        }

        for (const simultaneous of [false, true]) {
            it(`reserves one cost per copy up front, not per projectile (energy=${energy}, simultaneous=${simultaneous})`, () => {
                const test = setup({ owner: 'client', ammo: 2, fuel: 10,
                    energy, simultaneous, burst: true, count: 2 });
                test.send(1, 2, 3, 4, 5, 6);
                test.world.step();
                // Intentional timing deviation: reserve at each copy's first
                // successful shot, not burst completion. Cancellation/reconnect
                // cannot refund the already delivered portion of a burst.
                expect(test.combat!.persist).toHaveBeenCalledTimes(simultaneous ? 2 : 1);
                expect(energy ? test.fuel() : test.ammo()).toBe(simultaneous ? 0 : energy ? 5 : 1);
                for (let i = 0; i < 3; i++) test.advance(250);
                expect(test.shots.length).toBe(4);
                expect(test.log().map(s => s.seq)).toEqual([1, 2, 3, 4]);
                expect(energy ? test.fuel() : test.ammo()).toBe(0);
                expect(test.combat!.persist).toHaveBeenCalledTimes(2);
                test.advance(1000); // New token must not reuse the funded burst.
                expect(test.shots.length).toBe(4);
                expect(test.combat!.persist).toHaveBeenCalledTimes(2);
            });
        }

        it(`observer replay and local echoes never debit player resources (energy=${energy})`, () => {
            const test = setup({ owner: 'client', ammo: 1, fuel: 5, energy });
            test.send(1);
            test.world.step();
            const replay = jasmine.createSpy('fireFromLog');
            Object.assign(test.entry, { fireFromLog: replay });
            test.world.addSystem(FireLogSpawnSystem);
            test.world.step();
            expect(replay).not.toHaveBeenCalled();
            const logged = test.log()[0];
            test.ship.components.set(FireLogComponent, {
                shots: [logged, { ...logged, seq: 2, logSeq: 2 }],
            });
            test.world.step();
            test.world.step();
            expect(replay).toHaveBeenCalledTimes(1);
            expect(test.combat!.persist).toHaveBeenCalledTimes(1);
            expect(energy ? test.fuel() : test.ammo()).toBe(0);
        });

        it(`preserves owning-browser prediction without charging (energy=${energy})`, () => {
            const test = setup({ owner: 'client', ammo: 1, fuel: 5, energy });
            test.world.resources.set(PlatformResource, 'browser');
            test.world.resources.set(CommunicatorResource, new MockCommunicator('client'));
            test.world.step();
            expect(test.ammo()).toBe(1);
            expect(test.fuel()).toBe(5);
            expect(test.combat!.persist).not.toHaveBeenCalled();
            expect(test.shots.length).toBe(1);
            expect(test.ship.components.get(FireIntentComponent)!.shots.length).toBe(1);
        });
    }

    for (const ammoType of ['unlimited', ['energy', 5], ['outfit', 'ammo']] as const) {
        it(`requires initialized authority on actual player entities (${JSON.stringify(ammoType)})`, () => {
            const test = setup({ owner: 'client' });
            Object.assign(test.entry.data, { ammoType });
            test.ship.components.delete(CombatAuthorityComponent);
            const fire = spyOn(test.entry, 'fireFromEntityDetailed').and.callThrough();
            test.send(1);
            test.world.step();
            expect(test.ship.components.has(PlayerStateComponent)).toBeTrue();
            expect(fire).not.toHaveBeenCalled();
            expect(test.log()).toEqual([]);
            expect(test.combat!.persist).not.toHaveBeenCalled();
        });
    }

    it('permits an initialized unlimited player weapon without charging a balance', () => {
        const test = setup({ owner: 'client', ammo: 0, fuel: 0 });
        Object.assign(test.entry.data, { ammoType: 'unlimited' });
        test.send(1);
        test.world.step();
        expect(test.log().map(s => s.seq)).toEqual([1]);
        expect(test.combat!.persist).not.toHaveBeenCalled();
        expect(test.ammo()).toBe(0);
        expect(test.fuel()).toBe(0);
    });

    it('keys burst reservations by weapon as well as token and copy', () => {
        const test = setup({ owner: 'client', ammo: 2, burst: true });
        const other = { ...test.entry, data: { ...test.entry.data, id: 'other' } } as WeaponEntry;
        test.entries.gotten.other = other;
        test.ship.components.get(WeaponsStateComponent)!.set('other', { count: 1, firing: false });
        const send = (first: number) => test.ship.components.set(FireIntentComponent, {
            shots: [
                { seq: first, weaponId: 'test-weapon', seed: first, exitIndex: 0 },
                { seq: first + 1, weaponId: 'other', seed: first + 1, exitIndex: 0 },
            ],
        });
        send(1);
        test.world.step();
        expect(test.shots.length).toBe(2);
        expect(test.ammo()).toBe(0);
        expect(test.combat!.persist).toHaveBeenCalledTimes(2);
        send(3);
        test.advance(500);
        expect(test.shots.length).toBe(4);
        expect(test.combat!.persist).toHaveBeenCalledTimes(2);
    });

    it('reserves a fresh burst after a server refill without rewriting old persisted snapshots', () => {
        const test = setup({ owner: 'client', ammo: 1, burst: true });
        test.send(1, 2);
        test.world.step();
        test.advance(500);
        expect(test.shots.length).toBe(2);
        expect(test.combat!.persisted.map(balance => balance.ammo.ammo)).toEqual([0]);
        const authority = test.combat!.authority;
        authority.balance.ammo.ammo = 1;
        authority.commit();
        authority.project(test.ship);
        test.send(3, 4);
        test.advance(1000);
        expect(test.ammo()).toBe(0);
        test.advance(500);
        expect(test.shots.length).toBe(4);
        expect(test.combat!.persisted.map(balance => balance.ammo.ammo)).toEqual([0, 1, 0]);
    });

    it('does not refund an interrupted burst or give a reconnected shooter a free partial burst', () => {
        const test = setup({ owner: 'client', ammo: 1, burst: true });
        test.send(1, 2);
        test.world.step();
        expect(test.ammo()).toBe(0);
        expect(test.combat!.persisted.length).toBe(1);
        test.ship.components.set(DestructionStartedComponent, true);
        test.advance(500);
        expect(test.log().map(s => s.seq)).toEqual([1]);
        expect(test.combat!.persisted.length).toBe(1);
        // Reconstruct the new session from the actual fake-ledger snapshot,
        // not the pre-shot owner inventory. The reservation survives reconnect.
        const saved = test.combat!.persisted[0];
        const reconnected = setup({ owner: 'client', ammo: saved.ammo.ammo,
            fuel: saved.fuel, burst: true });
        reconnected.send(1, 2);
        reconnected.world.step();
        expect(reconnected.shots).toEqual([]);
        expect(reconnected.log()).toEqual([]);
        expect(reconnected.combat!.persist).not.toHaveBeenCalled();
    });

    it('retains cadence debt and rejects old buffers when a pilot reconnects with a new entity', () => {
        const first = setup({ owner: 'client', ammo: 10 });
        first.send(1);
        first.world.step();
        expect(first.shots.length).toBe(1);
        const second = setup({ owner: 'client', ammo: 10 });
        second.ship.components.set(CombatAuthorityComponent, first.combat!.authority);
        first.combat!.authority.project(second.ship);
        second.send(1);
        second.world.step();
        expect(second.shots.length).toBe(0);
        second.send(2);
        second.advance(100);
        expect(second.shots.length).toBe(0);
        second.advance(400);
        expect(second.log().map(shot => shot.seq)).toEqual([2]);
        expect(first.combat!.authority.balance.ammo.ammo).toBe(8);
    });

    it('cannot spend a forged player ammo projection instead of the authority balance', () => {
        const test = setup({ owner: 'client', ammo: 0 });
        test.ship.components.get(OutfitsStateComponent)!.set('ammo', { count: 1000 });
        test.send(1);
        test.world.step();
        expect(test.shots).toEqual([]);
        expect(test.log()).toEqual([]);
        expect(test.combat!.authority.balance.ammo.ammo).toBe(0);
        expect(test.ammo()).toBe(0);
    });

    it('never charges or rejects authoritative observer replay', () => {
        const test = setup();
        test.world.step();
        expect(test.ammo()).toBe(0);
        const replay = jasmine.createSpy('fireFromLog');
        Object.assign(test.entry, { fireFromLog: replay });
        test.world.addSystem(FireLogSpawnSystem);
        test.world.step();
        expect(replay).not.toHaveBeenCalled();
        const logged = test.ship.components.get(FireLogComponent)!.shots[0];
        test.ship.components.set(FireLogComponent, {
            shots: [logged, { ...logged, seq: 2, logSeq: 2 }],
        });
        test.world.step();
        expect(replay).toHaveBeenCalledTimes(1);
        expect(test.ammo()).toBe(0);
    });
});

describe('fire intent rate ceiling', () => {
    it('derives a bounded ceiling from reload and installed count', () => {
        const weapon = getDefaultProjectileWeaponData();
        weapon.reload = 500;
        expect(weaponShotRateCeiling(weapon, 2)).toBe(6);
        weapon.reload = 0;
        expect(weaponShotRateCeiling(weapon, 1000)).toBe(240);
    });
});

function makeWeapon(
    blocked: () => boolean,
    shots: number[],
    time: { time: number },
    configure: (data: ReturnType<typeof getDefaultProjectileWeaponData>) => void =
        () => undefined,
) {
    const data = getDefaultProjectileWeaponData();
    data.id = 'test-weapon';
    data.reload = 500;
    configure(data);
    const entry = {
        data,
        syncAsFireEvent: false,
        fireFromEntityDetailed: () => {
            if (blocked()) {
                return undefined;
            }
            shots.push(time.time);
            return {
                entity: new Entity(),
                position: new Position(0, 0),
                rotation: new Angle(0),
            };
        },
    } as unknown as WeaponEntry;
    const entries = new Gettable<WeaponEntry | undefined>(
        async () => entry,
    );
    entries.gotten[data.id] = entry;
    return entries;
}

describe('weapon firing', () => {
    it('clears held, burst, and quick-tap firing at destruction start', () => {
        const shots: number[] = [];
        const time = {
            time: 0,
            delta_ms: STEP_MS,
            delta_s: STEP_MS / 1000,
            frame: 0,
        };
        const entries = makeWeapon(() => false, shots, time);
        const local = new DefaultMap<string, WeaponLocalState>(
            getDefaultWeaponLocalState);
        const localState = local.get('test-weapon');
        localState.shotsOwed = 5;
        localState.burstCount = 2;
        localState.reloadingBurst = true;
        localState.pressObserved = true;
        localState.releaseAfterStep = true;
        const state = new Map([
            ['test-weapon', { count: 1, firing: true }],
        ]);
        const world = new World('weapon-destruction-lock-test');
        configureWeaponWorld(world);
        world.resources.set(TimeResource, time);
        world.resources.set(WeaponEntries, entries);
        world.addSystem(WeaponsSystem);
        world.entities.set('dying-ship', new Entity()
            .addComponent(WeaponsStateComponent, state)
            .addComponent(WeaponsComponent, local)
            .addComponent(MultiplayerData, { owner: 'server' })
            .addComponent(DestructionStartedComponent, true));

        world.step();

        expect(shots).toEqual([]);
        expect(state.get('test-weapon')!.firing).toBeFalse();
        expect(localState.shotsOwed).toBe(0);
        expect(localState.burstCount).toBe(0);
        expect(localState.reloadingBurst).toBeFalse();
        expect(localState.pressObserved).toBeFalse();
        expect(localState.releaseAfterStep).toBeFalse();
    });

    it('fires held weapons at the reload cadence', () => {
        const shots: number[] = [];
        const time = {
            time: 0,
            delta_ms: STEP_MS,
            delta_s: STEP_MS / 1000,
            frame: 0,
        };
        const entries = makeWeapon(() => false, shots, time);
        const local = new DefaultMap<string, ReturnType<typeof getDefaultWeaponLocalState>>(
            getDefaultWeaponLocalState);
        const world = new World('weapon-cadence-test');
        configureWeaponWorld(world);
        world.resources.set(TimeResource, time);
        world.resources.set(WeaponEntries, entries);
        world.addSystem(WeaponsSystem);
        world.entities.set('player', new Entity()
            .addComponent(WeaponsStateComponent, new Map([
                ['test-weapon', { count: 1, firing: true }],
            ]))
            .addComponent(WeaponsComponent, local)
            .addComponent(MultiplayerData, { owner: 'server' }));

        for (let i = 0; i < 600; i++) {
            time.time += STEP_MS;
            world.step();
        }

        expect(shots.length).toBeGreaterThan(1);
        for (let i = 1; i < shots.length; i++) {
            expect(shots[i] - shots[i - 1]).toBeCloseTo(500, 6);
        }
    });

    it('fires immediately after a temporary blockage clears', () => {
        const shots: number[] = [];
        let blocked = true;
        const time = {
            time: 0,
            delta_ms: STEP_MS,
            delta_s: STEP_MS / 1000,
            frame: 0,
        };
        const entries = makeWeapon(() => blocked, shots, time);
        const local = new DefaultMap<string, ReturnType<typeof getDefaultWeaponLocalState>>(
            getDefaultWeaponLocalState);
        const world = new World('weapon-recovery-test');
        configureWeaponWorld(world);
        world.resources.set(TimeResource, time);
        world.resources.set(WeaponEntries, entries);
        world.addSystem(WeaponsSystem);
        world.entities.set('player', new Entity()
            .addComponent(WeaponsStateComponent, new Map([
                ['test-weapon', { count: 1, firing: true }],
            ]))
            .addComponent(WeaponsComponent, local)
            .addComponent(MultiplayerData, { owner: 'server' }));

        time.time += STEP_MS;
        world.step();
        expect(shots).toEqual([]);

        // The weapon is ready, but no positive time step occurs between the
        // blockage clearing and the retry.
        blocked = false;
        time.delta_ms = 0;
        world.step();

        expect(shots.length).toBe(1);
    });

    it('waits for burst reload before starting the next burst', () => {
        const shots: number[] = [];
        const time = {
            time: 0,
            delta_ms: STEP_MS,
            delta_s: STEP_MS / 1000,
            frame: 0,
        };
        const entries = makeWeapon(() => false, shots, time, data => {
            data.reload = 100;
            data.burstCount = 2;
            data.burstReload = 1000;
        });
        const local = new DefaultMap<string, ReturnType<typeof getDefaultWeaponLocalState>>(
            getDefaultWeaponLocalState);
        const world = new World('weapon-burst-test');
        configureWeaponWorld(world);
        world.resources.set(TimeResource, time);
        world.resources.set(WeaponEntries, entries);
        world.addSystem(WeaponsSystem);
        world.entities.set('player', new Entity()
            .addComponent(WeaponsStateComponent, new Map([
                ['test-weapon', { count: 1, firing: true }],
            ]))
            .addComponent(WeaponsComponent, local)
            .addComponent(MultiplayerData, { owner: 'server' }));

        for (let i = 0; i < 20; i++) {
            time.time += STEP_MS;
            world.step();
        }
        expect(shots.length).toBe(2);

        // The normal reload credit must not leak through the burst pause.
        for (let i = 0; i < 35; i++) {
            time.time += STEP_MS;
            world.step();
        }
        expect(shots.length).toBe(2);

        for (let i = 0; i < 100; i++) {
            time.time += STEP_MS;
            world.step();
        }
        expect(shots.length).toBeGreaterThan(2);
        expect(shots[2]).toBeGreaterThan(1099);
    });

    it('fires a tap once the cooldown has elapsed', () => {
        const shots: number[] = [];
        const time = {
            time: 0,
            delta_ms: STEP_MS,
            delta_s: STEP_MS / 1000,
            frame: 0,
        };
        const entries = makeWeapon(() => false, shots, time);
        const local = new DefaultMap<string, ReturnType<typeof getDefaultWeaponLocalState>>(
            getDefaultWeaponLocalState);
        const state = new Map([
            ['test-weapon', { count: 1, firing: true }],
        ]);
        const world = new World('weapon-tap-test');
        configureWeaponWorld(world);
        world.resources.set(TimeResource, time);
        world.resources.set(WeaponEntries, entries);
        world.addSystem(WeaponsSystem);
        world.entities.set('player', new Entity()
            .addComponent(WeaponsStateComponent, state)
            .addComponent(WeaponsComponent, local)
            .addComponent(MultiplayerData, { owner: 'server' }));

        time.time += STEP_MS;
        world.step();
        state.get('test-weapon')!.firing = false;
        for (let i = 0; i < 40; i++) {
            time.time += STEP_MS;
            world.step();
        }
        state.get('test-weapon')!.firing = true;
        time.delta_ms = 0;
        world.step();

        expect(shots.length).toBe(2);
    });
});

describe('weapon trigger latch', () => {
    function setup(name: string) {
        const shots: number[] = [];
        const time = {
            time: 0,
            delta_ms: STEP_MS,
            delta_s: STEP_MS / 1000,
            frame: 0,
        };
        const entries = makeWeapon(() => false, shots, time);
        const local = new DefaultMap<string, WeaponLocalState>(
            getDefaultWeaponLocalState);
        const state = new Map([
            ['test-weapon', { count: 1, firing: false }],
        ]);
        const world = new World(name);
        configureWeaponWorld(world);
        world.resources.set(TimeResource, time);
        world.resources.set(WeaponEntries, entries);
        world.addSystem(WeaponsSystem);
        world.addSystem(ReleaseWeaponTriggerSystem);
        world.entities.set('player', new Entity()
            .addComponent(WeaponsStateComponent, state)
            .addComponent(WeaponsComponent, local)
            .addComponent(MultiplayerData, { owner: 'server' }));
        const weaponState = state.get('test-weapon')!;
        return { shots, time, local, state, world, weaponState };
    }

    it('fires once for a press and release between two steps', () => {
        const { shots, time, local, world, weaponState } = setup('latch-tap');

        // A browser can deliver keydown and keyup with no simulation step in
        // between. The whole tap used to be discarded.
        applyWeaponTrigger(weaponState, local.get('test-weapon'), true);
        applyWeaponTrigger(weaponState, local.get('test-weapon'), false);
        expect(weaponState.firing).toBeTrue();

        time.time += STEP_MS;
        world.step();
        expect(shots.length).toBe(1);
        expect(weaponState.firing).toBeFalse();

        for (let i = 0; i < 120; i++) {
            time.time += STEP_MS;
            world.step();
        }
        expect(shots.length).toBe(1);
    });

    it('releases a normal press without an extra shot', () => {
        const { shots, time, local, world, weaponState } = setup('latch-hold');

        applyWeaponTrigger(weaponState, local.get('test-weapon'), true);
        time.time += STEP_MS;
        world.step();
        expect(shots.length).toBe(1);

        applyWeaponTrigger(weaponState, local.get('test-weapon'), false);
        expect(weaponState.firing).toBeFalse();

        for (let i = 0; i < 120; i++) {
            time.time += STEP_MS;
            world.step();
        }
        expect(shots.length).toBe(1);
    });

    it('keeps reload cadence for a held trigger', () => {
        const { shots, time, local, world, weaponState } = setup('latch-cadence');

        applyWeaponTrigger(weaponState, local.get('test-weapon'), true);
        for (let i = 0; i < 300; i++) {
            time.time += STEP_MS;
            world.step();
        }
        expect(shots.length).toBeGreaterThan(4);
        for (let i = 1; i < shots.length; i++) {
            expect(shots[i] - shots[i - 1]).toBeCloseTo(500, 6);
        }
    });
});

describe('weapon destruction reset', () => {
    it('cannot be restarted by a stale replicated firing state', () => {
        const state = new Map([
            ['test-weapon', { count: 1, firing: true }],
        ]);
        const local = new DefaultMap<string, WeaponLocalState>(
            getDefaultWeaponLocalState);
        clearWeaponFiringState(state, local);
        state.get('test-weapon')!.firing = true;
        clearWeaponFiringState(state, local);
        expect(state.get('test-weapon')!.firing).toBeFalse();
        expect(local.get('test-weapon').shotsOwed).toBe(0);
    });
});

describe('weapon local state', () => {
    it('preserves reload progress when weapons state is refreshed', () => {
        // A replicated or outfit-driven WeaponsState refresh must not reload
        // every weapon; otherwise a held trigger fires far faster than the
        // weapon's reload allows.
        const previous = new DefaultMap<string, WeaponLocalState>(
            getDefaultWeaponLocalState);
        const existing = previous.get('test-weapon');
        existing.shotsOwed = 0.25;
        existing.burstCount = 3;
        existing.exitIndex = 2;

        const world = new World('weapon-local-state-test');
        world.addSystem(WeaponsComponentProvider);
        const entity = new Entity()
            .addComponent(WeaponsStateComponent, new Map([
                ['test-weapon', { count: 1, firing: false }],
            ]))
            .addComponent(WeaponsComponent, previous);
        world.entities.set('player', entity);

        entity.components.set(WeaponsStateComponent, new Map([
            ['test-weapon', { count: 2, firing: false }],
        ]));
        world.step();

        const current = entity.components.get(WeaponsComponent)!;
        expect(current.get('test-weapon').shotsOwed).toBe(0.25);
        expect(current.get('test-weapon').burstCount).toBe(3);
        expect(current.get('test-weapon').exitIndex).toBe(2);
    });
});
