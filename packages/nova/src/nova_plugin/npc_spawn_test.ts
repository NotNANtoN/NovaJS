import 'jasmine';
import { getDefaultGovtData } from 'novadatainterface/govt_data';
import { Random } from 'nova_ecs/plugins/random_plugin';
import {
    fleetAllowedInSystem, MAX_NPC_POPULATION, pickWeighted,
    rollPopulationTarget,
} from './npc_spawn_plugin.js';

function govt(overrides: Partial<ReturnType<typeof getDefaultGovtData>>) {
    return { ...getDefaultGovtData(), ...overrides };
}

describe('pickWeighted', () => {
    it('is deterministic for a given seed', () => {
        const entries = [
            { weight: 10, name: 'a' },
            { weight: 20, name: 'b' },
            { weight: 70, name: 'c' },
        ];
        const picksA = [], picksB = [];
        const randomA = new Random(42), randomB = new Random(42);
        for (let i = 0; i < 50; i++) {
            picksA.push(pickWeighted(entries, randomA)!.name);
            picksB.push(pickWeighted(entries, randomB)!.name);
        }
        expect(picksA).toEqual(picksB);
        // All entries get picked over enough draws.
        expect(new Set(picksA)).toEqual(new Set(['a', 'b', 'c']));
    });

    it('consumes exactly one draw regardless of which entry wins', () => {
        const random = new Random(7);
        const reference = new Random(7);
        pickWeighted([{ weight: 1 }, { weight: 1 }, { weight: 1 }], random);
        reference.next();
        expect(random.next()).toEqual(reference.next());
    });

    it('never picks zero-weight entries', () => {
        const random = new Random(3);
        for (let i = 0; i < 100; i++) {
            const picked = pickWeighted([
                { weight: 0, name: 'never' },
                { weight: 5, name: 'always' },
            ] as const, random);
            expect(picked!.name).toBe('always');
        }
    });

    it('returns undefined for empty or all-zero tables', () => {
        const random = new Random(1);
        expect(pickWeighted([], random)).toBeUndefined();
        expect(pickWeighted([{ weight: 0 }], random)).toBeUndefined();
    });
});

describe('rollPopulationTarget', () => {
    it('is zero for an empty system', () => {
        expect(rollPopulationTarget(0, new Random(1))).toBe(0);
    });

    it('stays within the Bible average +/- 50%', () => {
        const random = new Random(99);
        for (let i = 0; i < 200; i++) {
            const target = rollPopulationTarget(6, random);
            expect(target).toBeGreaterThanOrEqual(3);
            expect(target).toBeLessThanOrEqual(9);
        }
    });

    it('caps runaway plugin AvgShips', () => {
        const random = new Random(5);
        for (let i = 0; i < 50; i++) {
            expect(rollPopulationTarget(50, random))
                .toBeLessThanOrEqual(MAX_NPC_POPULATION);
        }
    });
});

describe('fleetAllowedInSystem (flët LinkSyst ranges)', () => {
    const federation = govt({
        id: 'nova:128', classes: [1], allies: [2], enemies: [3],
    });
    const ally = govt({ id: 'nova:131', classes: [2] });
    const enemy = govt({ id: 'nova:129', classes: [3] });
    const bystander = govt({ id: 'nova:132', classes: [9] });

    it('any: every system', () => {
        expect(fleetAllowedInSystem({ type: 'any' }, 'nova:130', null,
            undefined, undefined)).toBeTrue();
    });

    it('system: only the named system', () => {
        const link = { type: 'system', id: 'nova:130' } as const;
        expect(fleetAllowedInSystem(link, 'nova:130', null,
            undefined, undefined)).toBeTrue();
        expect(fleetAllowedInSystem(link, 'nova:131', null,
            undefined, undefined)).toBeFalse();
    });

    it("govtSystems: only the govt's own systems", () => {
        const link = { type: 'govtSystems', govt: 'nova:128' } as const;
        expect(fleetAllowedInSystem(link, 'nova:130', 'nova:128',
            federation, undefined)).toBeTrue();
        expect(fleetAllowedInSystem(link, 'nova:130', 'nova:129',
            enemy, undefined)).toBeFalse();
        expect(fleetAllowedInSystem(link, 'nova:130', null,
            undefined, undefined)).toBeFalse();
    });

    it("notGovtSystems: anywhere but the govt's systems", () => {
        const link = { type: 'notGovtSystems', govt: 'nova:128' } as const;
        expect(fleetAllowedInSystem(link, 'nova:130', 'nova:128',
            federation, undefined)).toBeFalse();
        expect(fleetAllowedInSystem(link, 'nova:130', 'nova:129',
            enemy, undefined)).toBeTrue();
        expect(fleetAllowedInSystem(link, 'nova:130', null,
            undefined, undefined)).toBeTrue();
    });

    it("allySystems: systems whose govt lists the linked govt's classes " +
        'among its allies', () => {
            const link = { type: 'allySystems', govt: 'nova:131' } as const;
            // Federation allies with class 2; nova:131 is class 2.
            expect(fleetAllowedInSystem(link, 'nova:130', 'nova:128',
                federation, ally)).toBeTrue();
            expect(fleetAllowedInSystem(link, 'nova:130', 'nova:132',
                bystander, ally)).toBeFalse();
            // A govt is its own ally.
            expect(fleetAllowedInSystem(
                { type: 'allySystems', govt: 'nova:128' },
                'nova:130', 'nova:128', federation, federation)).toBeTrue();
            // Independent systems have no allies.
            expect(fleetAllowedInSystem(link, 'nova:130', null,
                undefined, ally)).toBeFalse();
        });

    it("enemySystems: systems whose govt lists the linked govt's classes " +
        'among its enemies', () => {
            const link = { type: 'enemySystems', govt: 'nova:129' } as const;
            expect(fleetAllowedInSystem(link, 'nova:130', 'nova:128',
                federation, enemy)).toBeTrue();
            expect(fleetAllowedInSystem(link, 'nova:130', 'nova:132',
                bystander, enemy)).toBeFalse();
            // A govt is never its own enemy.
            expect(fleetAllowedInSystem(
                { type: 'enemySystems', govt: 'nova:128' },
                'nova:130', 'nova:128', federation, federation)).toBeFalse();
        });
});
