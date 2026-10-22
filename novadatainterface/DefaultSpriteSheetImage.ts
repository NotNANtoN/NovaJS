import defaultRled from 'novadatainterface/default_rled';
import { SpriteSheetImageData } from './SpriteSheetData';

export function getDefaultSpriteSheetImage(): SpriteSheetImageData {
    return defaultRled.buffer.slice(
        defaultRled.byteOffset,
        defaultRled.byteOffset + defaultRled.byteLength,
    ) as ArrayBuffer;
}
