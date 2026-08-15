import 'jasmine';
import { Random } from 'nova_ecs/plugins/random_plugin';
import {
    getIntegrationGameData,
    makeSimulationBridgeHarness,
} from '../communication/simulation_test_fixture.js';
import { IdFactory } from './id_factory.js';
import { PersComponent } from './pers_plugin.js';
import { DisabledComponent } from './disabled_component.js';
import { ArmorComponent, ShieldComponent } from './health_plugin.js';
import { ShipDataComponent } from './ship_plugin.js';
import {
    buildPersSpawnTable,
    PersSpawnEntry,
    spawnNpc,
} from './npc_spawn_plugin.js';

/**
 * përs spawning against real Nova data: table construction pins known
 * stock people, and the spawn path is deterministic (same seed, same
 * table => identical people at identical positions on every world).
 */
describe('përs spawning against real Nova data', () => {
    it('parses known stock people', async () => {
        const gameData = await getIntegrationGameData();
        // Jack Folstam, the Night-Master of Booster: a warship pilot
        // bound to sÿst nova:132.
        const jack = await gameData.data.Pers.get('nova:131');
        expect(jack.name).toBe('Jack Folstam');
        expect(jack.subtitle).toBe('Night-Master');
        expect(jack.linkSyst).toEqual({ type: 'system', id: 'nova:132' });
        expect(jack.ship).toBe('nova:279');
        expect(jack.govt).toBe('nova:149');
        expect(jack.aiType).toBe(3);
        // Matt Burch (the game's author, a stock easter-egg përs)
        // roams anywhere.
        const burch = await gameData.data.Pers.get('nova:161');
        expect(burch.name).toBe('Matt Burch');
        expect(burch.subtitle).toBe('31337');
        expect(burch.linkSyst).toEqual({ type: 'any' });
        // nova:128, by contrast, is bound away from one govt's space.
        const terrapin = await gameData.data.Pers.get('nova:128');
        expect(terrapin.name).toBe('Terrapin');
        expect(terrapin.linkSyst)
            .toEqual({ type: 'notGovtSystems', govt: 'nova:135' });
    }, 30_000);

    it('builds a deterministic table that honors LinkSyst and ActiveOn',
        async () => {
            const harness = await makeSimulationBridgeHarness();
            const gameData = await getIntegrationGameData();
            const systemData = await gameData.data.System.get('nova:134');

            const table = await buildPersSpawnTable(
                harness.world, 'nova:134', systemData);
            const again = await buildPersSpawnTable(
                harness.world, 'nova:134', systemData);
            expect(table).toEqual(again);

            // The Terrapin (nova:140) is bound to this very system...
            const terrapin = table.find(entry => entry.id === 'nova:140');
            expect(terrapin).toEqual(jasmine.objectContaining({
                name: 'Terrapin',
                subtitle: 'Standard',
                ship: 'nova:136',
                govt: 'nova:157',
                aiType: 2,
            }));
            // ...and people not bound to a single system are eligible
            // too (nova:128 is "anywhere except gövt nova:135 space",
            // and Kerella is not in it).
            expect(table.some(entry => entry.id === 'nova:128')).toBeTrue();
            // People bound to other systems are not.
            for (const entry of table) {
                const pers = await gameData.data.Pers.get(entry.id);
                if (pers.linkSyst.type === 'system') {
                    expect(pers.linkSyst.id).toBe('nova:134');
                }
            }

            // The shared-spawn constraint: a person whose ActiveOn
            // needs a set control bit (Jack Folstam, "b0 & !b8") is
            // excluded, because per-player bits cannot drive shared
            // spawns (see the npc_spawn_plugin module comment).
            const jackSystem = await gameData.data.System.get('nova:132');
            const jackTable = await buildPersSpawnTable(
                harness.world, 'nova:132', jackSystem);
            expect((await gameData.data.Pers.get('nova:131')).activeOn)
                .toBe('b0 & !b8');
            expect(jackTable.some(entry => entry.id === 'nova:131'))
                .toBeFalse();
        }, 120_000);

    it('spawns people deterministically, at most one of each',
        async () => {
            const [a, b] = await Promise.all(
                [makeSimulationBridgeHarness(), makeSimulationBridgeHarness()]);
            const gameData = await getIntegrationGameData();
            const systemData =
                await gameData.data.System.get(a.systemId);

            const spawn = async (harness: typeof a) => {
                const table: PersSpawnEntry[] = await buildPersSpawnTable(
                    harness.world, harness.systemId, systemData);
                const random = new Random(1234);
                const ids = new IdFactory();
                // Empty dude table: every draw is purely the përs roll.
                for (let i = 0; i < 200; i++) {
                    spawnNpc(harness.world, gameData, ids, random,
                        [], true, table);
                }
                const people: Array<[string, string, string | undefined]> = [];
                for (const [uuid, entity] of harness.world.entities) {
                    const pers = entity.components.get(PersComponent);
                    if (pers) {
                        people.push([uuid, pers.id, entity.name]);
                    }
                }
                return people;
            };

            const peopleA = await spawn(a);
            const peopleB = await spawn(b);
            // The 5% roll fired at least once over 200 draws.
            expect(peopleA.length).toBeGreaterThan(0);
            // Identical on both worlds: same uuids, same people.
            expect(peopleA).toEqual(peopleB);
            // At most one living instance of each person.
            const ids = peopleA.map(([, id]) => id);
            expect(new Set(ids).size).toBe(ids.length);
        }, 240_000);

    it('spawns Drifting Derelicts already disabled', async () => {
        const harness = await makeSimulationBridgeHarness();
        const gameData = await getIntegrationGameData();
        const systemData = await gameData.data.System.get('nova:130');

        // The Drifting Derelict përs nova:156 is bound to sÿst nova:130
        // and belongs to the derelict govt (nova:160), whose gövt Flags1
        // 0x0800 ("Ships start disabled") makes its ships spawn disabled.
        const table = await buildPersSpawnTable(
            harness.world, 'nova:130', systemData);
        const derelict = table.find(entry => entry.id === 'nova:156');
        expect(derelict).toEqual(jasmine.objectContaining({
            name: 'Drifting Derelict',
            ship: 'nova:129',
            govt: 'nova:160',
        }));

        // Spawn from a single-entry derelict table until the 5% roll
        // fires (deterministic seed, so this is stable and repeatable).
        const random = new Random(1234);
        const ids = new IdFactory();
        for (let i = 0; i < 200; i++) {
            spawnNpc(harness.world, gameData, ids, random, [], true,
                [derelict!]);
        }
        const hulks = [...harness.world.entities.values()].filter(
            entity => entity.components.get(PersComponent)?.id === 'nova:156');
        expect(hulks.length).toBeGreaterThan(0);

        for (const hulk of hulks) {
            // Disabled from spawn, with no self-repair scheduled, marked
            // as a hulk (disabled regardless of armor).
            const disabled = hulk.components.get(DisabledComponent);
            expect(disabled).toBeDefined();
            expect(disabled!.repairAt).toBeNull();
            expect(disabled!.hulk).toBeTrue();

            // FULL armor and shields: the original's derelicts read
            // "disabled" yet take a whole hull's worth of shots to
            // destroy (Matthew's playtest observation, 2026-08-14).
            const shipData = hulk.components.get(ShipDataComponent);
            const armor = hulk.components.get(ArmorComponent);
            const shield = hulk.components.get(ShieldComponent);
            expect(shipData).toBeDefined();
            expect(armor).toBeDefined();
            expect(armor!.current).toBe(armor!.max);
            expect(shield!.current).toBe(shield!.max);
        }
    }, 120_000);
});
