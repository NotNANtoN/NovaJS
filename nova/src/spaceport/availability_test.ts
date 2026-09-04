import { getDefaultPlanetData } from 'novadatainterface/PlanetData';
import {
    hasRequiredTechnology,
    hasSpaceportService,
    hashSample,
    isPurchaseAvailable,
    isPurchaseUnlocked,
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

    it('correctly maps Tau Prime services with flags 67', () => {
        const tauPrime = resolveSpaceportPlanetData(getDefaultPlanetData(), {
            id: 'nova:151',
            name: 'Tau Prime',
            flags: 67, // 0x43: canLand, commodity, bar
            techLevel: 0,
        });
        expect(hasSpaceportService(tauPrime, 'outfitter')).toBe(false);
        expect(hasSpaceportService(tauPrime, 'shipyard')).toBe(false);
        expect(hasSpaceportService(tauPrime, 'commodity')).toBe(true);
        expect(hasSpaceportService(tauPrime, 'bar')).toBe(true);
    });
    it('never stocks a ship with BuyRandom 0 (retail NPC/variant hulls)', () => {
        // Fed Carrier/Patrol variant hulls have displayWeight > 0 and empty NCB,
        // but BuyRandom 0. In EV Nova Bible, BuyRandom 0 means never sold.
        const npcVariant = {
            id: 'nova:218',
            techLevel: 14,
            availabilityNCB: '',
            displayWeight: 5,
            buyRandom: 0,
        };
        expect(isPurchaseAvailable(npcVariant, planet)).toBe(false);
        expect(isPurchaseUnlocked(npcVariant, planet)).toBe(false);
    });

    it('requires mission bits to unlock advanced ships like Fed Destroyer', () => {
        const fedDestroyer = {
            id: 'nova:141',
            techLevel: 14,
            availabilityNCB: 'b78 & P30',
            displayWeight: 175,
            buyRandom: 80,
        };
        const freshPilot = createInitialPlayerState();
        // Without bit 78, neither unlocked nor available
        expect(isPurchaseUnlocked(fedDestroyer, planet, freshPilot)).toBe(false);
        expect(isPurchaseAvailable(fedDestroyer, planet, freshPilot)).toBe(false);

        // With bit 78 granted
        freshPilot.missionBits[78] = true;
        expect(isPurchaseUnlocked(fedDestroyer, planet, freshPilot)).toBe(true);
    });

    it('varies ship stock by day using deterministic BuyRandom rolls', () => {
        const earthPlanet = {
            ...planet,
            id: 'nova:128',
        };
        const ship = {
            id: 'nova:133',
            techLevel: 5,
            availabilityNCB: '',
            displayWeight: 189,
            buyRandom: 50,
        };
        const state = createInitialPlayerState();

        // Sample across multiple days to verify some days have it and some do not
        const daysWithStock: number[] = [];
        const daysWithoutStock: number[] = [];
        for (let day = 0; day < 20; day++) {
            state.gameDate = day;
            const sample = hashSample(`nova:128:${day}:nova:133`);
            const available = isPurchaseAvailable(ship, earthPlanet, state);
            if (sample < 50) {
                expect(available).toBe(true);
                daysWithStock.push(day);
            } else {
                expect(available).toBe(false);
                daysWithoutStock.push(day);
            }
        }
        expect(daysWithStock.length).toBeGreaterThan(0);
        expect(daysWithoutStock.length).toBeGreaterThan(0);
    });

    it('always stocks a ship with BuyRandom 100 on every day', () => {
        const earthPlanet = {
            ...planet,
            id: 'nova:128',
        };
        const ship = {
            id: 'nova:167',
            techLevel: 4,
            availabilityNCB: '',
            displayWeight: 197,
            buyRandom: 100,
        };
        const state = createInitialPlayerState();
        for (let day = 0; day < 10; day++) {
            state.gameDate = day;
            expect(isPurchaseAvailable(ship, earthPlanet, state)).toBe(true);
        }
    });
});