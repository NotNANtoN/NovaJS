import 'jasmine';
import { Gettable } from 'novadatainterface/Gettable';
import { getDefaultProjectileWeaponData } from 'novadatainterface/WeaponData';
import { Entity } from 'nova_ecs/entity';
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
    ReleaseWeaponTriggerSystem,
    WeaponsSystem,
} from './weapon_plugin';

const STEP_MS = 1000 / 60;

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
        fireFromEntity: () => {
            if (blocked()) {
                return undefined;
            }
            shots.push(time.time);
            return new Entity();
        },
    } as unknown as WeaponEntry;
    const entries = new Gettable<WeaponEntry | undefined>(
        async () => entry,
    );
    entries.gotten[data.id] = entry;
    return entries;
}

describe('weapon firing', () => {
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
        world.resources.set(TimeResource, time);
        world.resources.set(WeaponEntries, entries);
        world.addSystem(WeaponsSystem);
        world.entities.set('player', new Entity()
            .addComponent(WeaponsStateComponent, new Map([
                ['test-weapon', { count: 1, firing: true }],
            ]))
            .addComponent(WeaponsComponent, local));

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
        world.resources.set(TimeResource, time);
        world.resources.set(WeaponEntries, entries);
        world.addSystem(WeaponsSystem);
        world.entities.set('player', new Entity()
            .addComponent(WeaponsStateComponent, new Map([
                ['test-weapon', { count: 1, firing: true }],
            ]))
            .addComponent(WeaponsComponent, local));

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
        world.resources.set(TimeResource, time);
        world.resources.set(WeaponEntries, entries);
        world.addSystem(WeaponsSystem);
        world.entities.set('player', new Entity()
            .addComponent(WeaponsStateComponent, new Map([
                ['test-weapon', { count: 1, firing: true }],
            ]))
            .addComponent(WeaponsComponent, local));

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
        world.resources.set(TimeResource, time);
        world.resources.set(WeaponEntries, entries);
        world.addSystem(WeaponsSystem);
        world.entities.set('player', new Entity()
            .addComponent(WeaponsStateComponent, state)
            .addComponent(WeaponsComponent, local));

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
        world.resources.set(TimeResource, time);
        world.resources.set(WeaponEntries, entries);
        world.addSystem(WeaponsSystem);
        world.addSystem(ReleaseWeaponTriggerSystem);
        world.entities.set('player', new Entity()
            .addComponent(WeaponsStateComponent, state)
            .addComponent(WeaponsComponent, local));
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
