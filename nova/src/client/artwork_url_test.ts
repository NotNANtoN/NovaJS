import 'jasmine';
import { selectArtworkExtension } from './artwork_url';

describe('artwork format selection', () => {
    it('selects WebP when the browser supports it', () => {
        expect(selectArtworkExtension(true)).toBe('.webp');
    });

    it('falls back to PNG when WebP is unsupported', () => {
        expect(selectArtworkExtension(false)).toBe('.png');
    });
});
