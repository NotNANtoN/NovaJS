import 'jasmine';
import {
    STANDARD_COMMODITIES,
} from 'novadatainterface/CommodityData';
import {
    TRADE_COMMODITY_GLYPHS,
    tradeCommodityGlyph,
    tradeCommodityGlyphKey,
} from './trade_center_glyphs';

describe('Trade Center commodity glyphs', () => {
    it('assigns every standard commodity and special cargo a distinct key',
        () => {
            const standardKeys = STANDARD_COMMODITIES.map(
                tradeCommodityGlyphKey);
            expect(new Set(standardKeys).size).toBe(
                STANDARD_COMMODITIES.length);
            expect(standardKeys).not.toContain('generic');

            const specialKey = tradeCommodityGlyphKey(
                'Vrenna Ice Lizard Pelts');
            expect(specialKey).toBe('generic');
            expect(new Set([...standardKeys, specialKey]).size)
                .toBe(STANDARD_COMMODITIES.length + 1);
        });

    it('maps every glyph key to a distinct draw function', () => {
        expect(new Set(Object.values(TRADE_COMMODITY_GLYPHS)).size)
            .toBe(Object.keys(TRADE_COMMODITY_GLYPHS).length);
    });

    it('falls back to the generic glyph for unknown commodities', () => {
        expect(() => tradeCommodityGlyphKey('Uncatalogued Cargo'))
            .not.toThrow();
        expect(tradeCommodityGlyphKey('Uncatalogued Cargo'))
            .toBe('generic');
        expect(tradeCommodityGlyph('Uncatalogued Cargo'))
            .toBe(TRADE_COMMODITY_GLYPHS.generic);
    });
});
