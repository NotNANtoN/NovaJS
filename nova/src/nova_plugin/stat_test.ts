import 'jasmine';
import { getStatDelta, Stat } from './stat';

describe('stat replication cadence', () => {
    it('sends a hit at once but lets recharge wait', () => {
        const shield = new Stat({ current: 100, max: 100, recharge: 1 });
        // The first read is always allowed through; take it out of the way.
        getStatDelta(shield, shield);

        shield.current = 99.9;
        expect(getStatDelta(shield, shield))
            .withContext('a sliver of recharge should wait for the interval')
            .toBeUndefined();

        shield.current = 60;
        expect(getStatDelta(shield, shield))
            .withContext('a hit must not wait a second to be seen')
            .toEqual(jasmine.objectContaining({ current: 60 }));
    });
});
