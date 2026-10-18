import defaultPict from 'novadatainterface/default_pict';

export type PictImageData = ArrayBuffer;

export function getDefaultPictImageData(): PictImageData {
    return defaultPict.buffer.slice(
        defaultPict.byteOffset,
        defaultPict.byteOffset + defaultPict.byteLength,
    ) as ArrayBuffer;
}
