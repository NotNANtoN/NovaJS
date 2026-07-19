import "jasmine";
import { computeHypergateSystemLinks } from "./starmap.js";

describe('computeHypergateSystemLinks', () => {
    it('links the systems containing linked hypergates', () => {
        // Gate spöb A in system SA links to gate spöb B in system SB.
        const systemOfSpob = new Map([
            ['spobA', 'SA'],
            ['spobB', 'SB'],
        ]);
        const gateDestinations = new Map([
            ['spobA', ['spobB']],
            ['spobB', ['spobA']],
        ]);
        const links = computeHypergateSystemLinks(systemOfSpob, gateDestinations);
        expect(links).toContain(['SA', 'SB']);
        expect(links).toContain(['SB', 'SA']);
    });

    it('drops links to spöbs not in any known system', () => {
        const systemOfSpob = new Map([['spobA', 'SA']]);
        const gateDestinations = new Map([['spobA', ['spobMissing']]]);
        expect(computeHypergateSystemLinks(systemOfSpob, gateDestinations))
            .toEqual([]);
    });

    it('ignores spöbs with no gate destinations', () => {
        const systemOfSpob = new Map([['spobA', 'SA'], ['spobB', 'SB']]);
        // Only non-hypergate/absent spöbs => no gate links.
        const gateDestinations = new Map<string, string[]>();
        expect(computeHypergateSystemLinks(systemOfSpob, gateDestinations))
            .toEqual([]);
    });
});
