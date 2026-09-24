import 'jasmine';
import { areSystemsSameOrVariants, isPlanetInSystem, isSystemVisible, visibleJumpTarget } from './system_variants';
import { getDefaultSystemData } from 'novadatainterface/SystemData';
import { createDraft, finishDraft } from 'immer';
import { SystemGraph } from '../spaceport/starmap';

describe('storyline clone visibility', () => {
    // Retail Kerella links both Sol 130 and its hidden clone Sol 531.
    const sol = { ...getDefaultSystemData(), id: 'nova:130', name: 'Sol', position: [0, 0] as [number, number],
        links: ['nova:134'], visibility: '!(b147 | b305)' };
    const solClone = { ...sol, id: 'nova:531', visibility: '(b147 | b305)' };
    const kerella = { ...getDefaultSystemData(), id: 'nova:134', name: 'Kerella', position: [-120, -60] as [number, number],
        links: ['nova:531', 'nova:130'] };
    const byId = new Map([sol, solClone, kerella].map(s => [s.id, s]));

    it('jumps to the visible Sol, not its hidden clone listed first', () => {
        const bits: boolean[] = [];
        expect(visibleJumpTarget('nova:531', kerella.links, bits, id => byId.get(id))).toBe('nova:130');
        expect(visibleJumpTarget('nova:130', kerella.links, bits, id => byId.get(id))).toBe('nova:130');
        bits[147] = true;
        expect(visibleJumpTarget('nova:130', kerella.links, bits, id => byId.get(id))).toBe('nova:531');
    });

    it('treats unreadable bits as hidden rather than visible', () => {
        const draft = createDraft({ bits: [] as boolean[] });
        const revoked = draft.bits;
        finishDraft(draft);
        expect(isSystemVisible(solClone, revoked)).toBeFalse();
    });

    it('routes the starmap to the visible Sol even with a revoked bit list', () => {
        const draft = createDraft({ bits: [] as boolean[] });
        const revoked = draft.bits;
        finishDraft(draft);
        const graph = new SystemGraph([sol, solClone, kerella], 'nova:134', undefined,
            () => {}, () => true, undefined, revoked);
        (graph as unknown as { onClickSystem(id: string): void }).onClickSystem('nova:531');
        expect(graph.route).toEqual(['nova:130']);
    });
});

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
