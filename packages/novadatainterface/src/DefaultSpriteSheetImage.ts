import defaultRled from './default_rled';
export function getDefaultSpriteSheetImage() {
    return Buffer.from(defaultRled.buffer);
}
