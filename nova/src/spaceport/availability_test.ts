import { getDefaultPlanetData } from 'novadatainterface/PlanetData';
import {
    hasRequiredTechnology,
    hasSpaceportService,
    isPurchaseAvailable,
    resolveSpaceportPlanetData,
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

    it('never stocks a variant hull with no display weight', () => {
        expect(isPurchaseAvailable({
            techLevel: 1,
            availabilityNCB: '',
            displayWeight: 0,
        }, planet)).toBe(false);
        expect(isPurchaseAvailable({
            techLevel: 1,
            availabilityNCB: '',
            displayWeight: 189,
        }, planet)).toBe(true);
    });

    it('treats a registered pilot as passing the P test', () => {
        const state = createInitialPlayerState();
        expect(isPurchaseAvailable({
            techLevel: 1,
            availabilityNCB: 'P30',
        }, planet, state)).toBe(true);
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

    it('uses authoritative Earth flags over a stale local schema', () => {
        const staleEarth = {
            ...getDefaultPlanetData(),
            id: 'nova:128',
            name: 'Cached Earth',
            flags: undefined,
            techLevel: undefined,
            specialTech: undefined,
            hasCommodityExchange: undefined,
            hasOutfitter: undefined,
            hasShipyard: undefined,
            hasBar: undefined,
        };
        const resolved = resolveSpaceportPlanetData(staleEarth, {
            id: 'nova:128',
            name: 'Earth',
            flags: 0x2214204f,
            techLevel: 12,
            specialTech: [14, 20],
        });
        expect(resolved).toEqual(jasmine.objectContaining({
            name: 'Earth',
            flags: 0x2214204f,
            techLevel: 12,
            specialTech: [14, 20],
            hasCommodityExchange: true,
            hasOutfitter: true,
            hasShipyard: true,
            hasBar: true,
        }));
    });

    it('does not invent services or unrestricted catalogs', () => {
        const stale = {
            ...getDefaultPlanetData(),
            flags: undefined,
            techLevel: undefined,
            specialTech: undefined,
        };
        const resolved = resolveSpaceportPlanetData(stale, {
            id: 'nova:159',
            name: 'Jupiter',
            flags: 0x20,
            techLevel: 0,
            specialTech: [],
        });
        expect(hasSpaceportService(resolved, 'commodity')).toBe(false);
        expect(hasSpaceportService(resolved, 'outfitter')).toBe(false);
        expect(hasSpaceportService(resolved, 'shipyard')).toBe(false);
        expect(hasSpaceportService(resolved, 'bar')).toBe(false);
        expect(hasRequiredTechnology(1, resolved)).toBe(false);
    });

    it('falls back to explicit local data for old id-only peers', () => {
        const local = {
            ...getDefaultPlanetData(),
            flags: undefined,
            techLevel: 7,
            specialTech: [14],
            hasCommodityExchange: false,
            hasOutfitter: true,
            hasShipyard: false,
            hasBar: true,
        };
        const resolved = resolveSpaceportPlanetData(local, {
            id: 'nova:legacy',
        });
        expect(resolved.techLevel).toBe(7);
        expect(resolved.specialTech).toEqual([14]);
        expect(hasSpaceportService(resolved, 'outfitter')).toBe(true);
        expect(hasSpaceportService(resolved, 'bar')).toBe(true);
        expect(hasSpaceportService(resolved, 'shipyard')).toBe(false);
    });

    it('treats completely absent catalog metadata conservatively', () => {
        const stale = {
            ...getDefaultPlanetData(),
            flags: undefined,
            techLevel: undefined,
            specialTech: undefined,
            hasCommodityExchange: undefined,
            hasOutfitter: undefined,
            hasShipyard: undefined,
            hasBar: undefined,
        };
        const resolved = resolveSpaceportPlanetData(stale, {
            id: 'nova:legacy',
        });
        expect(resolved.techLevel).toBe(-1);
        expect(hasRequiredTechnology(0, resolved)).toBe(false);
        expect(hasSpaceportService(resolved, 'bar')).toBe(false);
    });
});
