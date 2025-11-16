import defaultRled from './default_rled.js';
export function getDefaultSpriteSheetImage() {
    return Buffer.from(defaultRled.buffer);
}
