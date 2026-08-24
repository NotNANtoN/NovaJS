import {
    getStellarSelectorCandidates,
    getSystemSelectorCandidates,
    matchesStellarSelector,
    resolveStellarSelector,
    resolveSystemSelector,
    StellarSelectorContext,
} from './stellar_selector';

const context: StellarSelectorContext = {
    planets: [
        { id: 'nova:128', inhabited: true, government: 128, systemId: 'nova:128' },
        { id: 'nova:129', inhabited: true, government: 129, systemId: 'nova:129' },
        { id: 'nova:130', inhabited: true, government: 130, systemId: 'nova:130' },
        { id: 'nova:131', inhabited: false, government: -1, systemId: 'nova:131' },
        { id: 'nova:132', inhabited: true, government: 132, systemId: 'nova:132' },
    ],
    systems: [
        {
            id: 'nova:128',
            government: 128,
            links: ['nova:129'],
            planets: ['nova:128'],
        },
        {
            id: 'nova:129',
            government: 129,
            links: ['nova:128', 'nova:130'],
            planets: ['nova:129'],
        },
        {
            id: 'nova:130',
            government: 130,
            links: ['nova:129'],
            planets: ['nova:130'],
        },
        {
            id: 'nova:131',
            government: -1,
            links: ['nova:130'],
            planets: ['nova:131'],
        },
        {
            id: 'nova:132',
            government: 132,
            links: [],
            planets: ['nova:132'],
        },
    ],
    governments: [
        { index: 0, classes: [7], allies: [8], enemies: [9] },
        { index: 1, classes: [7, 8], allies: [7], enemies: [9] },
        { index: 2, classes: [9], allies: [], enemies: [7] },
    ],
    currentPlanetId: 'nova:128',
    currentSystemId: 'nova:128',
    initialPlanetId: 'nova:128',
    initialSystemId: 'nova:128',
    travelPlanetId: 'nova:129',
    returnPlanetId: 'nova:130',
    random: () => 0.99,
};

function sorted(values: string[]) {
    return [...values].sort();
}

describe('stellar selector', () => {
    it('resolves specific stellar IDs in the documented range', () => {
        expect(getStellarSelectorCandidates(129, context))
            .toEqual(['nova:129']);
        expect(matchesStellarSelector(
            129, context.planets![1]!, context, 'availability')).toBeTrue();
        expect(getStellarSelectorCandidates(2175, context)).toEqual([]);
    });

    it('resolves AvailStel adjacent-system selectors 5000-7047', () => {
        // 5129 is 5000 + the specific system ID 129.
        expect(sorted(getStellarSelectorCandidates(
            5129, context, 'availability')))
            .toEqual(['nova:128', 'nova:130']);
        expect(matchesStellarSelector(
            5129, context.planets![0]!, context, 'availability')).toBeTrue();
        expect(matchesStellarSelector(
            5129, context.planets![1]!, context, 'availability')).toBeFalse();
    });

    it('resolves any and random stellar selectors', () => {
        expect(sorted(getStellarSelectorCandidates(
            -1, context))).toEqual([
            'nova:128', 'nova:129', 'nova:130', 'nova:131', 'nova:132',
        ]);
        expect(resolveStellarSelector(-1, context).wildcard).toBeTrue();
        expect(resolveStellarSelector(-2, context).selected).toBe('nova:132');
        expect(resolveStellarSelector(-3, context).selected).toBe('nova:131');
        expect(resolveStellarSelector(9999, context).selected).toBe('nova:132');
    });

    it('resolves each government relationship range', () => {
        expect(getStellarSelectorCandidates(10000, context))
            .toEqual(['nova:128']);
        expect(getStellarSelectorCandidates(15000, context))
            .toEqual(['nova:129']);
        expect(sorted(getStellarSelectorCandidates(20000, context)))
            .toEqual(['nova:129', 'nova:130', 'nova:131', 'nova:132']);
        expect(getStellarSelectorCandidates(25000, context))
            .toEqual(['nova:130']);
        expect(sorted(getStellarSelectorCandidates(30000, context)))
            .toEqual(['nova:128', 'nova:129']);
        expect(sorted(getStellarSelectorCandidates(31000, context)))
            .toEqual(['nova:130', 'nova:131', 'nova:132']);
    });

    it('resolves ReturnStel -4 to the initial stellar', () => {
        expect(resolveStellarSelector(-4, context).selected)
            .toBe('nova:128');
    });

    it('resolves ShipSyst special values and specific systems', () => {
        expect(getSystemSelectorCandidates(-1, context)).toEqual(['nova:128']);
        expect(resolveSystemSelector(-2, context).selected).toBe('nova:132');
        expect(getSystemSelectorCandidates(-3, context)).toEqual(['nova:129']);
        expect(getSystemSelectorCandidates(-4, context)).toEqual(['nova:130']);
        expect(getSystemSelectorCandidates(-5, context)).toEqual(['nova:129']);
        expect(getSystemSelectorCandidates(-6, context)).toEqual(['nova:128']);
        expect(getSystemSelectorCandidates(130, context)).toEqual(['nova:130']);
    });

    it('resolves government-based ShipSyst ranges', () => {
        expect(getSystemSelectorCandidates(10000, context))
            .toEqual(['nova:128']);
        expect(getSystemSelectorCandidates(15000, context))
            .toEqual(['nova:129']);
        expect(sorted(getSystemSelectorCandidates(20000, context)))
            .toEqual(['nova:129', 'nova:130', 'nova:131', 'nova:132']);
        expect(getSystemSelectorCandidates(25000, context))
            .toEqual(['nova:130']);
        expect(sorted(getSystemSelectorCandidates(30000, context)))
            .toEqual(['nova:128', 'nova:129']);
        expect(sorted(getSystemSelectorCandidates(31000, context)))
            .toEqual(['nova:130', 'nova:131', 'nova:132']);
    });
});
