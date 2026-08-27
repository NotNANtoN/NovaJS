import 'jasmine';
import {
    gameDataCacheControl,
    IMMUTABLE_ASSET_CACHE,
    REVALIDATE_METADATA_CACHE,
} from './setupRoutes';

describe('game-data cache policy', () => {
    it('revalidates stable JSON metadata URLs', () => {
        expect(gameDataCacheControl('/Planet/nova%3A128.json'))
            .toBe(REVALIDATE_METADATA_CACHE);
        expect(gameDataCacheControl('/System/nova%3A130.json'))
            .toBe(REVALIDATE_METADATA_CACHE);
        expect(gameDataCacheControl('/Planet/nova%3A128'))
            .toBe(REVALIDATE_METADATA_CACHE);
    });

    it('keeps large version-stable binary assets immutable', () => {
        expect(gameDataCacheControl('/PictImage/nova%3A128.png'))
            .toBe(IMMUTABLE_ASSET_CACHE);
        expect(gameDataCacheControl('/PictImage/nova%3A128.webp'))
            .toBe(IMMUTABLE_ASSET_CACHE);
        expect(gameDataCacheControl('/SoundFile/nova%3A128.mp3'))
            .toBe(IMMUTABLE_ASSET_CACHE);
    });
});
