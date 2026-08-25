import { shortestRoute, shortestRoutes } from './route_planning';

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
