import 'jasmine';
import { getStatDelta, Stat } from './stat';

describe('stat replication cadence', () => {
    it('sends a hit at once but lets recharge wait', () => {
        const shield = new Stat({ current: 50, max: 100, recharge: 1 });
        // The first read is always allowed through; take it out of the way.
        getStatDelta(shield, shield);

        shield.current = 50.1;
        expect(getStatDelta(shield, shield))
            .withContext('a sliver of recharge should wait for the interval')
            .toBeUndefined();

        shield.current = 20;
        expect(getStatDelta(shield, shield))
            .withContext('a hit must not wait a second to be seen')
            .toEqual(jasmine.objectContaining({ current: 20 }));
    });

    it('sends even a small hit immediately', () => {
        const armor = new Stat({ current: 10_000, max: 10_000, recharge: 0 });
        getStatDelta(armor, armor);

        armor.current = 9_995;
        expect(getStatDelta(armor, armor))
            .withContext('a hit below the sharp-change fraction is still a hit')
            .toEqual(jasmine.objectContaining({ current: 9_995 }));
    });
});
