import 'jasmine';
import {
    formatVisibleMissionText,
    missionInfoDisplayText,
    missionOfferDisplayText,
} from '../nova_plugin/mission_text';

describe('visible mission text', () => {
    it('resolves retail and unknown placeholders without leaking tokens', () => {
        const rendered = formatVisibleMissionText(
            'Take <CQ> tons of <CARGO> to <DST> in <DSY>; <PLUGIN_TAG>.',
            {
                quantity: 7,
                cargo: 'Medical Supplies',
                destination: 'Earth',
                destinationSystem: 'Sol',
            },
        );
        expect(rendered).toContain(
            'Take 7 tons of Medical Supplies to Earth in Sol');
        expect(rendered).toContain('mission information');
        expect(rendered).not.toMatch(/<[A-Za-z][^>]*>/);
    });

    it('removes quantityless cargo markers', () => {
        expect(formatVisibleMissionText('<CT>', { cargo: '*passengers' }))
            .toBe('passengers');
    });

    it('uses offer text before acceptance and quick text in Mission Info', () => {
        const mission = {
            name: 'Delivery',
            offerText: 'Initial offer',
            quickBrief: 'Active summary',
            briefText: 'Post-accept briefing',
        };
        expect(missionOfferDisplayText(mission)).toBe('Initial offer');
        expect(missionInfoDisplayText(mission)).toBe('Active summary');
        expect(missionOfferDisplayText(mission))
            .not.toBe(mission.briefText);
    });
});
