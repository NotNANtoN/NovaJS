import defaultCicn from 'novadatainterface/default_rled';

export type CicnImageData = ArrayBuffer;

export function getDefaultCicnImageData(): CicnImageData {
    return defaultCicn.buffer.slice(
        defaultCicn.byteOffset,
        defaultCicn.byteOffset + defaultCicn.byteLength,
    ) as ArrayBuffer;
}
