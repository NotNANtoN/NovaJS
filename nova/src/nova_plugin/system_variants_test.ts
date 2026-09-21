import 'jasmine';
import { areSystemsSameOrVariants, isPlanetInSystem } from './system_variants';
import { getDefaultSystemData } from 'novadatainterface/SystemData';

describe('system_variants', () => {
    describe('areSystemsSameOrVariants', () => {
        it('identifies systems sharing name and position as variants', () => {
            const systems = new Map([
                ['nova:193', { ...getDefaultSystemData(), id: 'nova:193', name: 'Glimmer', position: [-60, -80] as [number, number] }],
                ['nova:759', { ...getDefaultSystemData(), id: 'nova:759', name: 'Glimmer', position: [-60, -80] as [number, number] }],
                ['nova:130', { ...getDefaultSystemData(), id: 'nova:130', name: 'Sol', position: [0, 0] as [number, number] }],
            ]);

            expect(areSystemsSameOrVariants('nova:193', 'nova:759', systems)).toBeTrue();
            expect(areSystemsSameOrVariants('nova:193', 'nova:130', systems)).toBeFalse();
        });
    });

    describe('isPlanetInSystem', () => {
        it('matches planets directly listed in system planets', async () => {
            const system = { ...getDefaultSystemData(), id: 'nova:130', planets: ['nova:128', 'nova:129'] };
            const source = { get: async (id: string) => id === 'nova:130' ? system : undefined };

            expect(await isPlanetInSystem('nova:128', system, source)).toBeTrue();
            expect(await isPlanetInSystem('nova:999', system, source)).toBeFalse();
        });

        it('matches planets in storyline variant systems sharing name and coordinates', async () => {
            const sys761 = { ...getDefaultSystemData(), id: 'nova:761', name: 'Glimmer', position: [-60, -80] as [number, number], planets: ['nova:505'] };
            const sys759 = { ...getDefaultSystemData(), id: 'nova:759', name: 'Glimmer', position: [-60, -80] as [number, number], planets: ['nova:503'] };
            const systemsMap = new Map([['nova:761', sys761], ['nova:759', sys759]]);
            const source = { get: async (id: string) => systemsMap.get(id) };

            // Player is in nova:761, planet is nova:503 (Brass) listed in storyline clone nova:759
            expect(await isPlanetInSystem('nova:503', sys761, source, ['nova:761', 'nova:759'])).toBeTrue();
        });
    });
});
