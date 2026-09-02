import * as PIXI from 'pixi.js';

export const TRADE_GLYPH_SIZE = 9;
export const TRADE_GLYPH_COLOR = 0xb8b8b8;

export type TradeCommodityGlyphKey =
    | 'food'
    | 'industrial'
    | 'medical'
    | 'luxury'
    | 'metal'
    | 'equipment'
    | 'generic';

export type TradeCommodityGlyphDraw = (
    graphics: PIXI.Graphics,
    color: number,
) => void;

function filled(
    graphics: PIXI.Graphics,
    color: number,
    draw: () => void,
) {
    draw();
    graphics.fill(color);
}

/**
 * Compact monochrome silhouettes for the Trade Center commodity gutter.
 * Draw functions use local coordinates in a 9px square so callers can pool
 * and position Graphics instances independently.
 */
export const TRADE_COMMODITY_GLYPHS:
Readonly<Record<TradeCommodityGlyphKey, TradeCommodityGlyphDraw>> = {
    food: (graphics, color) => filled(graphics, color, () => {
        graphics.circle(4, 5, 3.25);
        graphics.poly([4, 2, 5, 0, 7.5, 0.5, 6, 2]);
    }),
    industrial: (graphics, color) => filled(graphics, color, () => {
        graphics.rect(0, 4, 9, 5);
        graphics.rect(0.5, 1, 2, 4);
        graphics.poly([2, 4, 4.5, 2, 4.5, 4, 7, 2, 7, 4]);
    }),
    medical: (graphics, color) => filled(graphics, color, () => {
        graphics.rect(3, 0, 3, 9);
        graphics.rect(0, 3, 9, 3);
    }),
    luxury: (graphics, color) => filled(graphics, color, () => {
        graphics.poly([4.5, 0, 9, 3.5, 4.5, 9, 0, 3.5]);
    }),
    metal: (graphics, color) => filled(graphics, color, () => {
        graphics.poly([2, 1, 7, 1, 9, 8, 0, 8]);
    }),
    equipment: (graphics, color) => filled(graphics, color, () => {
        graphics.poly([
            0, 1, 3, 2.5, 6.5, 0, 8.5, 1.5,
            5, 4.5, 9, 8, 7, 9, 3.5, 5, 1.5, 8,
            0, 6.5, 2.5, 3,
        ]);
    }),
    generic: (graphics, color) => {
        graphics.rect(0.75, 0.75, 7.5, 7.5);
        graphics.moveTo(1.5, 1.5);
        graphics.lineTo(7.5, 7.5);
        graphics.moveTo(7.5, 1.5);
        graphics.lineTo(1.5, 7.5);
        graphics.stroke({ width: 1.5, color });
    },
};

const STANDARD_GLYPH_KEYS: Readonly<Record<string, TradeCommodityGlyphKey>> = {
    Food: 'food',
    'Industrial Goods': 'industrial',
    'Medical Supplies': 'medical',
    'Luxury Goods': 'luxury',
    Metal: 'metal',
    Equipment: 'equipment',
};

export function tradeCommodityGlyphKey(
    commodity: string,
): TradeCommodityGlyphKey {
    return STANDARD_GLYPH_KEYS[commodity] ?? 'generic';
}

export function tradeCommodityGlyph(
    commodity: string,
): TradeCommodityGlyphDraw {
    return TRADE_COMMODITY_GLYPHS[tradeCommodityGlyphKey(commodity)];
}
