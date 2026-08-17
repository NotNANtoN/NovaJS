import 'jasmine';
import { MockGameData } from 'novadatainterface/mock_game_data';
import { getDefaultPlanetData } from 'novadatainterface/planet_data';
import { getDefaultSystemData } from 'novadatainterface/system_data';
import { MissionUniverse } from './mission_universe.js';

describe('MissionUniverse name lookups', () => {
    it('hides the "; comment" authoring suffix on stellar and system names '
        + '(a mission read "Sol;GM" where the original shows "Sol")',
        async () => {
            const gameData = new MockGameData();
            gameData.data.Planet.map.set('nova:128', {
                ...getDefaultPlanetData(), id: 'nova:128', name: 'Earth;GM',
            });
            gameData.data.System.map.set('nova:128', {
                ...getDefaultSystemData(), id: 'nova:128', name: 'Sol;GM',
                planets: ['nova:128'],
            });
            const universe = new MissionUniverse(gameData);
            await universe.load();

            expect(universe.planetName('nova:128')).toBe('Earth');
            expect(universe.systemNameOfPlanet('nova:128')).toBe('Sol');
            // Unknown ids still fall back to the id itself.
            expect(universe.planetName('nova:999')).toBe('nova:999');
        });
});

describe('MissionUniverse.systemIdOfPlanet across stacked duplicate systems', () => {
    async function universe() {
        const gameData = new MockGameData();
        gameData.data.Planet.map.set('nova:333', {
            ...getDefaultPlanetData(), id: 'nova:333', name: 'Auroran LP I',
        });
        // SPC-1421 twice: nova:308 while !b995, nova:765 once b995 is set.
        gameData.data.System.map.set('nova:308', {
            ...getDefaultSystemData(), id: 'nova:308', name: 'SPC-1421',
            planets: ['nova:333'], visibility: '!b995', position: [10, 20],
        });
        gameData.data.System.map.set('nova:765', {
            ...getDefaultSystemData(), id: 'nova:765', name: 'SPC-1421',
            planets: ['nova:333'], visibility: 'b995', position: [10, 20],
        });
        const u = new MissionUniverse(gameData);
        await u.load();
        return u;
    }

    it('resolves the return stellar to the copy the player can SEE '
        + '(the Moash fleet spawned in the invisible nova:765)', async () => {
            const u = await universe();
            expect(u.systemIdOfPlanet('nova:333', new Set())).toBe('nova:308');
            expect(u.systemIdOfPlanet('nova:333', new Set([995])))
                .toBe('nova:765');
        });

    it('falls back deterministically without bits, and treats the two '
        + 'copies as the same system', async () => {
            const u = await universe();
            expect(u.systemIdOfPlanet('nova:333')).toBe('nova:308');
            expect(u.sameSystem('nova:308', 'nova:765')).toBeTrue();
            expect(u.sameSystem('nova:308', 'nova:128')).toBeFalse();
        });
});
