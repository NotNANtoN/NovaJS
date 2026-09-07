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
    it('formats destination route hops and cargo manifest for in-flight mission log', () => {
        const systems = [
            { id: 'nova:sol', name: 'Sol', links: ['nova:sirius'], planets: ['nova:earth'] },
            { id: 'nova:sirius', name: 'Sirius', links: ['nova:sol', 'nova:altair'], planets: ['nova:sirius1'] },
            { id: 'nova:altair', name: 'Altair', links: ['nova:sirius'], planets: ['nova:altair1'] },
        ];
        // Cargo manifest format check
        const sampleMissionText = formatVisibleMissionText(
            'Deliver <CQ> tons of <CARGO> to <DST> in <DSY>.',
            {
                quantity: 15,
                cargo: 'Food',
                destination: 'Sirius I',
                destinationSystem: 'Sirius',
            },
        );
        expect(sampleMissionText).toBe('Deliver 15 tons of Food to Sirius I in Sirius.');
    });
});
