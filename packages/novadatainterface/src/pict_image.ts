import defaultPict from './default_pict.js';

export type PictImageData = ArrayBuffer;

export function getDefaultPictImageData(): PictImageData {
    return Buffer.from(defaultPict.buffer).buffer;
}
