import 'jasmine';
import { displayName } from './display_name.js';

describe('displayName', () => {
    it('drops the "; developer note" suffix', () => {
        // Real mïsn names from Nova Data 1 (space after the ';').
        expect(displayName('Delivery to Earth; Vellos1'))
            .toEqual('Delivery to Earth');
        expect(displayName('Rescue Rebel; Vellos8a')).toEqual('Rescue Rebel');
        // ...and without the space (Polaris string chain).
        expect(displayName('Transport Mu\'Randa;Polaris1'))
            .toEqual('Transport Mu\'Randa');
    });

    it('handles govt and rank names too', () => {
        // Nova Data 1 govt / Nova Data 2 rank names carry the same suffix.
        expect(displayName('Federation;hates Temmin Shard'))
            .toEqual('Federation');
        expect(displayName('T5; Vell-os 1')).toEqual('T5');
    });

    it('leaves plain names untouched', () => {
        expect(displayName('Starbridge')).toEqual('Starbridge');
        expect(displayName('Laser Cannon')).toEqual('Laser Cannon');
    });

    it('trims whitespace around the visible part', () => {
        expect(displayName('Viper ; internal')).toEqual('Viper');
        expect(displayName('  Spaced Out  ')).toEqual('Spaced Out');
    });

    it('yields an empty string when the note is the whole name', () => {
        expect(displayName(';dev-only')).toEqual('');
    });
});
