import { shortestRoute, shortestRoutes } from './route_planning';
import { filterLiveTerritoryPoints } from './starmap';
import type { SystemData } from 'novadatainterface/SystemData';

describe('starmap route planning', () => {
    const systems = [
        { id: 'a', links: ['b', 'c'] },
        { id: 'b', links: ['a', 'd'] },
        { id: 'c', links: ['a', 'd'] },
        { id: 'd', links: ['b', 'c', 'e'] },
        { id: 'e', links: ['d'] },
    ];

    it('returns a shortest hyperlink route', () => {
        expect(shortestRoute(systems, 'a', 'e')).toEqual(['b', 'd', 'e']);
    });

    it('does not route through unknown systems', () => {
        expect(shortestRoute(
            systems, 'a', 'e', ['a', 'c', 'd', 'e'],
        )).toEqual(['c', 'd', 'e']);
        expect(shortestRoute(
            systems, 'a', 'b', ['a', 'c', 'd', 'e'],
        )).toEqual([]);
    });

    it('plans every destination from one source traversal', () => {
        expect(shortestRoutes(systems, 'a')).toEqual(new Map([
            ['a', []],
            ['b', ['b']],
            ['c', ['c']],
            ['d', ['b', 'd']],
            ['e', ['b', 'd', 'e']],
        ]));
    });
});

describe('starmap live territory filtering', () => {
    it('swaps active system territory colors when mission bits flip variants', () => {
        const sysA = { id: 'nova:128', name: 'Sol', position: [0, 0], links: [], planets: [], visibility: '!b10' } as unknown as SystemData;
        const sysB = { id: 'nova:500', name: 'Sol', position: [0, 0], links: [], planets: [], visibility: 'b10' } as unknown as SystemData;
        const systems = new Map<string, SystemData>([
            [sysA.id, sysA],
            [sysB.id, sysB],
        ]);
        const points = [
            { x: 0, y: 0, color: 0x0000ff, systemId: sysA.id },
            { x: 0, y: 0, color: 0xff0000, systemId: sysB.id },
        ];

        const before = filterLiveTerritoryPoints(points, systems, new Set());
        expect(before.map(p => p.systemId)).toEqual(['nova:128']);
        expect(before[0].color).toBe(0x0000ff);

        const after = filterLiveTerritoryPoints(points, systems, new Set([10]));
        expect(after.map(p => p.systemId)).toEqual(['nova:500']);
        expect(after[0].color).toBe(0xff0000);
    });
});
