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
