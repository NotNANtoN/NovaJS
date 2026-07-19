import { getDefaultGovtData, GovtData } from 'novadatainterface/govt_data';
import { getDefaultOutfitData, OutfitData } from 'novadatainterface/outfit_data';
import {
    deriveIff,
    dispositionColor,
    IFF_FRIENDLY_COLOR,
    IFF_HOSTILE_COLOR,
    IFF_NEUTRAL_COLOR,
    shipDisposition,
    targetCornerStyle,
} from './iff_plugin.js';
import { OutfitsState } from './outfit_plugin.js';

/** A gameData stub exposing only the Outfit.getCached the deriver uses. */
function mockGameData(outfits: { [id: string]: OutfitData | undefined }) {
    return {
        data: {
            Outfit: {
                getCached: (id: string) => outfits[id],
            },
        },
    } as any;
}

function iffOutfit(id: string): OutfitData {
    return { ...getDefaultOutfitData(), id, iff: true };
}

function plainOutfit(id: string): OutfitData {
    return { ...getDefaultOutfitData(), id };
}

function govt(over: Partial<GovtData>): GovtData {
    return { ...getDefaultGovtData(), ...over };
}

describe('deriveIff', () => {
    it('reports hasIff false when the ship owns no IFF outfit', () => {
        const outfits: OutfitsState = new Map([['nova:1', { count: 1 }]]);
        const result = deriveIff(outfits,
            mockGameData({ 'nova:1': plainOutfit('nova:1') }));
        expect(result?.hasIff).toBe(false);
    });

    it('reports hasIff true when an IFF outfit is owned', () => {
        const outfits: OutfitsState = new Map([['nova:185', { count: 1 }]]);
        const result = deriveIff(outfits,
            mockGameData({ 'nova:185': iffOutfit('nova:185') }));
        expect(result?.hasIff).toBe(true);
    });

    it('ignores an IFF outfit with a zero count', () => {
        const outfits: OutfitsState = new Map([['nova:185', { count: 0 }]]);
        const result = deriveIff(outfits,
            mockGameData({ 'nova:185': iffOutfit('nova:185') }));
        expect(result?.hasIff).toBe(false);
    });

    it('returns undefined until the outfit data is cached', () => {
        const outfits: OutfitsState = new Map([['nova:185', { count: 1 }]]);
        const result = deriveIff(outfits, mockGameData({}));
        expect(result).toBeUndefined();
    });
});

describe('shipDisposition', () => {
    it('is neutral for a ship with no government', () => {
        expect(shipDisposition(undefined, undefined)).toBe('neutral');
    });

    it('is hostile when the ship govt always attacks the player', () => {
        const ship = govt({ id: 'nova:200' });
        ship.flags.alwaysAttacksPlayer = true;
        expect(shipDisposition(ship, undefined)).toBe('hostile');
    });

    it('is hostile for a xenophobic govt', () => {
        const ship = govt({ id: 'nova:200' });
        ship.flags.xenophobic = true;
        expect(shipDisposition(ship, undefined)).toBe('hostile');
    });

    it('neverAttacksPlayer overrides alwaysAttacksPlayer', () => {
        const ship = govt({ id: 'nova:200' });
        ship.flags.alwaysAttacksPlayer = true;
        ship.flags.neverAttacksPlayer = true;
        expect(shipDisposition(ship, undefined)).toBe('neutral');
    });

    it('is hostile when the ship govt enemies intersect the player classes', () => {
        const ship = govt({ id: 'nova:200', enemies: [2, 10] });
        const player = govt({ id: 'nova:128', classes: [10] });
        expect(shipDisposition(ship, player)).toBe('hostile');
    });

    it('is friendly when the ship govt allies intersect the player classes', () => {
        const ship = govt({ id: 'nova:200', allies: [1, 12] });
        const player = govt({ id: 'nova:128', classes: [12] });
        expect(shipDisposition(ship, player)).toBe('friendly');
    });

    it('is friendly when ship and player share a government', () => {
        const ship = govt({ id: 'nova:128' });
        const player = govt({ id: 'nova:128', classes: [1] });
        expect(shipDisposition(ship, player)).toBe('friendly');
    });

    it('prefers hostile over friendly when both would apply', () => {
        const ship = govt({ id: 'nova:200', enemies: [10], allies: [10] });
        const player = govt({ id: 'nova:128', classes: [10] });
        expect(shipDisposition(ship, player)).toBe('hostile');
    });

    it('is neutral for an unrelated government', () => {
        const ship = govt({ id: 'nova:200', enemies: [2], allies: [3] });
        const player = govt({ id: 'nova:128', classes: [10] });
        expect(shipDisposition(ship, player)).toBe('neutral');
    });
});

describe('dispositionColor', () => {
    it('maps dispositions to the IFF radar palette', () => {
        expect(dispositionColor('hostile')).toBe(IFF_HOSTILE_COLOR);
        expect(dispositionColor('friendly')).toBe(IFF_FRIENDLY_COLOR);
        expect(dispositionColor('neutral')).toBe(IFF_NEUTRAL_COLOR);
    });
});

describe('targetCornerStyle', () => {
    it('follows the political disposition when the target is not ' +
        'attacking the player', () => {
            expect(targetCornerStyle('neutral', false)).toBe('neutral');
            expect(targetCornerStyle('friendly', false)).toBe('friendly');
            expect(targetCornerStyle('hostile', false)).toBe('hostile');
        });

    it('a ship attacking the player is hostile regardless of politics ' +
        '(e.g. a brave trader fighting back)', () => {
            expect(targetCornerStyle('neutral', true)).toBe('hostile');
            expect(targetCornerStyle('friendly', true)).toBe('hostile');
            expect(targetCornerStyle('hostile', true)).toBe('hostile');
        });
});
