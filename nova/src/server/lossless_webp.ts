import sharp from 'sharp';

export type WebPEncode = (png: Buffer) => Promise<Buffer>;

export async function encodeLosslessWebP(png: Buffer): Promise<Buffer> {
    return sharp(png)
        .webp({
            effort: 0,
            lossless: true,
        })
        .toBuffer();
}

export class LosslessWebPCache {
    private readonly encoded = new Map<string, Promise<Buffer>>();
    private queue = Promise.resolve();

    constructor(private readonly encode: WebPEncode = encodeLosslessWebP) {}

    get(key: string, png: Buffer): Promise<Buffer> {
        const cached = this.encoded.get(key);
        if (cached) {
            return cached;
        }

        const result = this.queue.then(() => this.encode(png));
        this.queue = result.then(() => undefined, () => undefined);
        this.encoded.set(key, result);
        void result.catch(() => {
            if (this.encoded.get(key) === result) {
                this.encoded.delete(key);
            }
        });
        return result;
    }
}
