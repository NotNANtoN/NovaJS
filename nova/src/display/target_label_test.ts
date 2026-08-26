import 'jasmine';
import {
    namesItsGovernment,
    targetGovernmentName,
    targetLabel,
} from './target_label';

describe('target label', () => {
    it('puts the retail target name on its own line', () => {
        expect(targetLabel('Starbridge', {
            name: 'Federation',
            commName: 'Federation Navy',
            targetName: 'Fed',
        })).toBe('Starbridge\nFed');
    });

    it('prefers TargetName over the other government names', () => {
        expect(targetGovernmentName({
            name: 'Auroran Empire',
            commName: 'Auroran vessel',
            targetName: 'Auroran',
        })).toBe('Auroran');
    });

    it('falls back for government data without TargetName', () => {
        expect(targetGovernmentName({
            name: 'Federation',
            commName: 'Federation vessel',
        })).toBe('Federation vessel');
        expect(targetGovernmentName({ name: 'Federation' }))
            .toBe('Federation');
    });

    it('leaves ships without a resolved government unchanged', () => {
        expect(targetLabel('Drone', undefined)).toBe('Drone');
        expect(targetLabel('Mission Ship', {
            name: ' ',
            commName: '',
            targetName: '',
        })).toBe('Mission Ship');
    });
});

describe('a hull that already names its owner', () => {
    it('does not repeat the government', () => {
        // Retail's Federation TargetName is "Fed." and ship 141 is named
        // "Fed Destroyer"; showing both only stutters.
        expect(targetLabel('Fed Destroyer', { targetName: 'Fed.' }))
            .toBe('Fed Destroyer');
        expect(targetLabel('Auroran Cruiser', { targetName: 'Auroran' }))
            .toBe('Auroran Cruiser');
    });

    it('still labels a generic hull', () => {
        expect(targetLabel('Shuttle', { targetName: 'Fed.' }))
            .toBe('Shuttle\nFed.');
        expect(targetLabel('Argosy', { targetName: 'Polaris' }))
            .toBe('Argosy\nPolaris');
    });

    it('needs every word of the government to be present', () => {
        expect(namesItsGovernment('Moash Warship', 'Family Moash')).toBeFalse();
        expect(namesItsGovernment('Family Moash Warship', 'Family Moash'))
            .toBeTrue();
    });
});
