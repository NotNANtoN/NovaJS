import 'jasmine';
import {
    consumeInitialCenter,
    systemMarkerStyle,
} from './starmap_state';
import { getMissionDestinationMarkers } from './starmap';

describe('starmap world presentation state', () => {
    it('centers only the first open in each constructed system world', () => {
        const firstWorld = { centeredOnce: false };
        expect(consumeInitialCenter(firstWorld)).toBeTrue();
        expect(consumeInitialCenter(firstWorld)).toBeFalse();

        const destinationWorld = { centeredOnce: false };
        expect(consumeInitialCenter(destinationWorld)).toBeTrue();
    });

    it('marks the current system independently of the plotted route', () => {
        expect(systemMarkerStyle('nova:130', 'nova:130')).toEqual({
            current: true,
            ringColor: 0xffffff,
            ringWidth: 2,
        });
        expect(systemMarkerStyle('nova:162', 'nova:130'))
            .toEqual({ current: false });
    });

    it('identifies destination systems and mission types for map markers', () => {
        const systems = [
            { id: 'nova:128', name: 'Sol', planets: ['nova:128', 'nova:129'] },
            { id: 'nova:130', name: 'Alpha Centauri', planets: ['nova:130'] },
            { id: 'nova:135', name: 'Barnard', planets: ['nova:135'] },
        ] as never;

        const missions = [
            {
                missionId: 'm1',
                state: 'active' as const,
                travelDestination: 'nova:130',
                cargo: { type: 1001, quantity: 10 },
            },
            {
                missionId: 'm2',
                state: 'active' as const,
                destination: 'nova:135',
                cargo: { type: 1, quantity: 5 },
            },
            {
                missionId: 'm3',
                state: 'active' as const,
                destination: 'nova:128',
            },
        ];

        const markers = getMissionDestinationMarkers(missions as never, systems);
        expect(markers.get('nova:130')).toBe('passenger');
        expect(markers.get('nova:135')).toBe('cargo');
        expect(markers.get('nova:128')).toBe('storyline');
    });
});
