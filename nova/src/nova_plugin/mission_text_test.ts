import { formatMissionText } from './mission_text';

describe('mission text formatting', () => {
    it('expands destination, pilot, ship, and rank wildcards', () => {
        const text = formatMissionText(
            '<DST>/<RET>/<SYS>/<PSN>/<PNM>/<SHT>/<PRK>',
            {
                destination: 'Luna',
                returnDestination: 'Earth',
                destinationSystem: 'Sol',
                shipName: 'Resolute',
                pilotName: 'Avery',
                shipType: 'Shuttle',
                ranks: [{ id: 3, convName: 'Marshal', weight: 10 }],
                activeRanks: [3],
            },
        );
        expect(text).toBe(
            'Luna/Earth/Sol/Resolute/Avery/Shuttle/Marshal');
    });

    it('selects gender and control-bit alternatives', () => {
        expect(formatMissionText(
            '{G "he" "she"} {B b007 "paid" "owes"}',
            {
                gender: 'female',
                missionBits: new Set([7]),
            },
        )).toBe('she paid');
        expect(formatMissionText(
            '{!G "he" "she"} {B b007 "paid" "owes"}',
            {
                gender: 'female',
                missionBits: new Set(),
            },
        )).toBe('he owes');
    });

    it('preserves unknown tags', () => {
        expect(formatMissionText('keep <PLUGIN_TAG>', {}))
            .toBe('keep <PLUGIN_TAG>');
    });
});
