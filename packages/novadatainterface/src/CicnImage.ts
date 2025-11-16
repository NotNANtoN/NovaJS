import defaultCicn from './default_rled.js';

export type CicnImageData = ArrayBuffer;

export function getDefaultCicnImageData(): CicnImageData {
    return Buffer.from(defaultCicn.buffer);
}
