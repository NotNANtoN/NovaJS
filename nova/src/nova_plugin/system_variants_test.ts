import 'jasmine';
import {
    areSystemsSameOrVariants, isPlanetInSystem, isSystemVisible, SystemVariantIndex,
    visibleGalaxy, visibleJumpTarget,
} from './system_variants';
import { getDefaultSystemData } from 'novadatainterface/SystemData';
import { createDraft, finishDraft } from 'immer';
import { SystemGraph } from '../spaceport/starmap';
import { arePlanetCopies } from './mission_plugin';

describe('SystemVariantIndex', () => {
    const sys = (id: string, name: string, position: [number, number], visibility: string | undefined,
        planets: string[] = [], links: string[] = []) =>
        ({ ...getDefaultSystemData(), id, name, position, visibility, planets, links });
    // Shapes taken from retail data.
    const systems = [
        sys('nova:130', 'Sol', [0, 0], '!(b147 | b305)', ['nova:128', 'nova:159'], ['nova:134']),
        sys('nova:531', 'Sol', [0, 0], '(b147 | b305)', ['nova:426', 'nova:159'], ['nova:134']),
        // Overlaps with b147 set: both expressions are true.
        sys('nova:141', 'Aldebaran', [10, 10], '!(b147 | b305) | !b148', [], ['nova:134']),
        sys('nova:532', 'Aldebaran', [10, 10], '(b147 | b305) | b148', [], ['nova:134']),
        // Neither copy is visible before b9500.
        sys('nova:428', 'Pentori', [5, 5], '!b330 & b9500'),
        sys('nova:622', 'Pentori', [5, 5], 'b330 & b9500'),
        // Kerella links the hidden Sol first, like retail.
        sys('nova:134', 'Kerella', [-120, -60], undefined, [], ['nova:531', 'nova:130', 'nova:141']),
        // Same name, different place: not a copy.
        sys('nova:900', 'Sol', [500, 500], undefined),
    ];
    const index = new SystemVariantIndex(systems);
    const bits = (...on: number[]) => { const b: boolean[] = []; for (const n of on) b[n] = true; return b; };

    it('groups copies by name and position only', () => {
        expect(index.variantsOf('nova:531')).toEqual(['nova:130', 'nova:531']);
        expect(index.same('nova:130', 'nova:531')).toBeTrue();
        expect(index.same('nova:130', 'nova:900')).toBeFalse();
    });

    it('picks exactly one live copy, the later story stage when several are visible', () => {
        expect(index.visibleVariant('nova:531', bits())).toBe('nova:130');
        expect(index.visibleVariant('nova:130', bits(147))).toBe('nova:531');
        expect(index.visibleVariant('nova:141', bits(147))).toBe('nova:532');
        expect(index.visibleVariant('nova:622', bits())).toBe('nova:428');
    });

    it('knows which stellars exist and where they are reached', () => {
        expect(index.isPlanetVisible('nova:128', bits())).toBeTrue();
        expect(index.isPlanetVisible('nova:426', bits())).toBeFalse();
        expect(index.visibleSystemOfPlanet('nova:159', bits(147))).toBe('nova:531');
        expect(index.planetInPlace('nova:426', 'nova:130')).toBeTrue();
    });

    it('builds the live galaxy: hidden copies gone, links redirected, no hidden stellars', () => {
        const galaxy = visibleGalaxy(systems,
            [{ id: 'nova:128' }, { id: 'nova:426' }, { id: 'nova:159' }], bits());
        expect(galaxy.systems.map(s => s.id)).not.toContain('nova:531');
        expect(galaxy.systems.find(s => s.id === 'nova:134')!.links)
            .toEqual(['nova:130', 'nova:141']);
        expect(galaxy.planets.map(p => p.id)).toEqual(['nova:128', 'nova:159']);
        expect(galaxy.planets.find(p => p.id === 'nova:159')!.systemId).toBe('nova:130');
    });

    it('moves a saved stellar to its live copy (Earth 426 -> Earth 128)', () => {
        const names: Record<string, string> = { 'nova:128': 'Earth', 'nova:426': 'Earth', 'nova:159': 'Jupiter' };
        const getPlanet = (id: string) => ({ name: names[id] });
        expect(index.livePlanetCopy('nova:426', bits(), getPlanet)).toBe('nova:128');
        expect(index.livePlanetCopy('nova:128', bits(), getPlanet)).toBe('nova:128');
        expect(index.livePlanetCopy('nova:128', bits(147), getPlanet)).toBe('nova:426');
        expect(index.livePlanetCopy('nova:159', bits(147), getPlanet)).toBe('nova:159');
    });

    it('redirects any jump, not just ones through the current links', () => {
        expect(visibleJumpTarget('nova:531', [], bits(), () => undefined, index)).toBe('nova:130');
    });

    it('treats stellars as copies only when their systems are copies', () => {
        const earth = { name: 'Earth', position: [0, 0] };
        expect(arePlanetCopies('nova:128', earth, 'nova:426', earth, index)).toBeTrue();
        const other = new SystemVariantIndex([...systems,
            sys('nova:777', 'Elsewhere', [99, 99], undefined, ['nova:999'])]);
        expect(arePlanetCopies('nova:128', earth, 'nova:999', earth, other)).toBeFalse();
    });
});

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
