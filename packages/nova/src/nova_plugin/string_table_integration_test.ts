import 'jasmine';
import { getIntegrationGameData } from '../communication/simulation_test_fixture.js';
import {
    NO_SHIPS_FOR_HIRE, NO_SHIPS_FOR_HIRE_INDEX, NO_SHIPS_FOR_HIRE_TABLE,
} from '../spaceport/hire_escort.js';

// These assertions run against the real Nova game data (Nova_Data). They
// pin the STR# and dësc resources the title screen and the bar read their
// text from, so a regression in the string-table accessor shows up here
// rather than as a blank dialog in the game.
describe('StringTable against real Nova data', () => {
    it('pins STR# 2002 ("misc strings")', async () => {
        const gameData = await getIntegrationGameData();
        const table = await gameData.data.StringTable.get('nova:2002');
        expect(table.name).toBe('misc strings');
        expect(table.strings.length).toBe(396);
    });

    it('sources the hire message from STR# 2002 index 223', async () => {
        const gameData = await getIntegrationGameData();
        const table = await gameData.data.StringTable.get(
            NO_SHIPS_FOR_HIRE_TABLE);
        expect(table.strings[NO_SHIPS_FOR_HIRE_INDEX])
            .toBe('There are no ships available for hire.');
        // The hardcoded fallback must stay in step with the data.
        expect(table.strings[NO_SHIPS_FOR_HIRE_INDEX])
            .toBe(NO_SHIPS_FOR_HIRE);
    });

    it('keeps the shipyard sibling at index 222 distinct', async () => {
        const gameData = await getIntegrationGameData();
        const table = await gameData.data.StringTable.get('nova:2002');
        // The hire string has no trailing "here"; index 222 does.
        expect(table.strings[222])
            .toBe('There are no ships available for purchase here.');
    });

    it('exposes string tables in the id list', async () => {
        const gameData = await getIntegrationGameData();
        const ids = await gameData.ids;
        expect(ids.StringTable).toContain('nova:2002');
    });
});

describe('About text against real Nova data', () => {
    // The About box text is NOT in a STR# table: the original reads it
    // from dësc 32767 (credits) and dësc 32766 (special thanks).
    it('pins the credits dësc (nova:32767)', async () => {
        const gameData = await getIntegrationGameData();
        const desc = await gameData.data.Description.get('nova:32767');
        expect(desc.text.startsWith('Escape Velocity:  Nova')).toBeTrue();
        expect(desc.text).toContain('(c)1996-2008 Ambrosia Software, Inc.');
        expect(desc.text).toContain('Engine Programming:');
        expect(desc.text).toContain('Matt Burch');
        expect(desc.text).toContain('ATMOS Software Productions');
    });

    it('pins the special-thanks dësc (nova:32766)', async () => {
        const gameData = await getIntegrationGameData();
        const desc = await gameData.data.Description.get('nova:32766');
        expect(desc.text).toContain('ATMOS would like to thank Ambrosia');
    });

    it('normalizes classic-Mac line endings to \\n', async () => {
        const gameData = await getIntegrationGameData();
        const desc = await gameData.data.Description.get('nova:32767');
        expect(desc.text).not.toContain('\r');
        expect(desc.text).toContain('\n');
    });

    it('carries the <REG> placeholder the dialog substitutes', async () => {
        const gameData = await getIntegrationGameData();
        const desc = await gameData.data.Description.get('nova:32767');
        expect(desc.text).toContain('<REG>');
    });
});
