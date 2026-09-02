
export function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
    const ab = buffer.buffer;
    return ab.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
