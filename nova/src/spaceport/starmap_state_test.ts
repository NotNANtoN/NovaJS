import 'jasmine';
import {
    consumeInitialCenter,
    systemMarkerStyle,
} from './starmap_state';

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
});
