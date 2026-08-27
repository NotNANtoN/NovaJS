import 'jasmine';
import {
    abbreviateTargetGovernment,
    namesItsGovernment,
    targetGovernmentName,
    targetLabel,
} from './target_label';

describe('target label', () => {
    it('returns separate retail heading pieces', () => {
        expect(targetLabel('Starbridge', 'Stolen Tech', {
            name: 'Federation',
            commName: 'Federation Navy',
            targetName: 'Fed',
        })).toEqual({
            name: 'Starbridge',
            subtitle: 'Stolen Tech',
            government: 'Fed',
        });
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
        expect(targetLabel('Drone', '', undefined)).toEqual({
            name: 'Drone',
            subtitle: undefined,
        });
        expect(targetLabel('Mission Ship', undefined, {
            name: ' ',
            commName: '',
            targetName: '',
        })).toEqual({
            name: 'Mission Ship',
            subtitle: undefined,
        });
    });

    it('uses an authored short name and truncates a long fallback', () => {
        expect(abbreviateTargetGovernment({
            name: 'Association',
            targetName: 'Assoc',
        })).toBe('Assoc');
        expect(abbreviateTargetGovernment({
            name: 'Association',
        })).toBe('Associa…');
    });
});

describe('a hull that already names its owner', () => {
    it('does not repeat the government', () => {
        // Retail's Federation TargetName is "Fed." and ship 141 is named
        // "Fed Destroyer"; showing both only stutters.
        expect(targetLabel('Fed Destroyer', '', { targetName: 'Fed.' }))
            .toEqual({ name: 'Fed Destroyer', subtitle: undefined });
        expect(targetLabel('Auroran Cruiser', '', { targetName: 'Auroran' }))
            .toEqual({ name: 'Auroran Cruiser', subtitle: undefined });
    });

    it('still labels a generic hull', () => {
        expect(targetLabel('Shuttle', '', { targetName: 'Fed.' }))
            .toEqual({
                name: 'Shuttle',
                subtitle: undefined,
                government: 'Fed.',
            });
        expect(targetLabel('Argosy', '', { targetName: 'Polaris' }))
            .toEqual({
                name: 'Argosy',
                subtitle: undefined,
                government: 'Polaris',
            });
    });

    it('needs every word of the government to be present', () => {
        expect(namesItsGovernment('Moash Warship', 'Family Moash')).toBeFalse();
        expect(namesItsGovernment('Family Moash Warship', 'Family Moash'))
            .toBeTrue();
    });
});
