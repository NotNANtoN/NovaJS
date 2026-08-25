import { getDefaultPlanetData } from 'novadatainterface/PlanetData';
import {
    hasRequiredTechnology,
    hasSpaceportService,
    isPurchaseAvailable,
} from './availability';
import { createInitialPlayerState } from '../nova_plugin/player_state';

describe('spaceport availability', () => {
    const planet = {
        ...getDefaultPlanetData(),
        techLevel: 7,
        specialTech: [14, 20, 55],
    };

    it('allows base and explicitly special technology', () => {
        expect(hasRequiredTechnology(7, planet)).toBe(true);
        expect(hasRequiredTechnology(14, planet)).toBe(true);
        expect(hasRequiredTechnology(15, planet)).toBe(false);
    });

    it('evaluates AvailabilityNCB against mission bits', () => {
        expect(isPurchaseAvailable({
            techLevel: 1,
            availabilityNCB: 'b424',
        }, planet, new Set([424]))).toBe(true);
    });

    it('filters unavailable NCB items without mission bits', () => {
        const item = { techLevel: 1, availabilityNCB: 'b424' };
        expect(isPurchaseAvailable(item, planet, [])).toBe(false);
        expect(isPurchaseAvailable(item, planet,
            new Set([424]))).toBe(true);
    });

    it('evaluates player-derived NCB context beyond mission bits', () => {
        const state = createInitialPlayerState();
        state.exploredSystems = ['nova:130'];
        state.daysSinceRegistration = 4;
        const outfits = new Map([['nova:1', { count: 1 }]]);
        expect(isPurchaseAvailable({
            techLevel: 1,
            availabilityNCB: 'G&E130&P5&O1',
        }, planet, state, outfits)).toBe(true);
    });

    it('maps spaceport service flags to their buttons', () => {
        const noOutfitter = { ...planet, flags: 0x01 | 0x08 };
        expect(hasSpaceportService(noOutfitter, 'shipyard')).toBe(true);
        expect(hasSpaceportService(noOutfitter, 'outfitter')).toBe(false);
        expect(hasSpaceportService(noOutfitter, 'commodity')).toBe(false);
    });
});
