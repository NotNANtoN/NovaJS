import 'jasmine';
import sharp from 'sharp';
import { PNG } from 'pngjs';
import { IDSpaceHandler } from '../../../novaparse/src/IDSpaceHandler';
import {
    PictImageMultiParse,
} from '../../../novaparse/src/parsers/PictParse';
import {
    hasRetailData,
    retailDataPath,
} from '../../../test/retail_data';
import {
    encodeLosslessWebP,
    LosslessWebPCache,
} from './lossless_webp';

function fixturePng(): Buffer {
    const image = new PNG({ width: 2, height: 2 });
    image.data = Buffer.from([
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 0, 255, 255,
        255, 255, 255, 0,
    ]);
    return PNG.sync.write(image);
}

async function rawPixels(image: Buffer) {
    return sharp(image).ensureAlpha().raw().toBuffer({
        resolveWithObject: true,
    });
}

describe('lossless WebP encoding', () => {
    it('produces a valid WebP image', async () => {
        const webP = await encodeLosslessWebP(fixturePng());
        const metadata = await sharp(webP).metadata();

        expect(webP.subarray(0, 4).toString('ascii')).toBe('RIFF');
        expect(webP.subarray(8, 12).toString('ascii')).toBe('WEBP');
        expect(metadata.format).toBe('webp');
        expect(metadata.width).toBe(2);
        expect(metadata.height).toBe(2);
    });

    it('preserves every pixel in real generated artwork', async () => {
        if (!hasRetailData()) {
            pending('retail Nova data is not present in this checkout');
            return;
        }

        const idSpace = await new IDSpaceHandler(retailDataPath())
            .getIDSpace();
        const parsed = await PictImageMultiParse(
            idSpace.PICT['nova:8000'],
            message => fail(message),
        );
        const png = Buffer.from(parsed.image);
        const webP = await encodeLosslessWebP(png);
        const source = await rawPixels(png);
        const decoded = await rawPixels(webP);

        expect(decoded.info.width).toBe(source.info.width);
        expect(decoded.info.height).toBe(source.info.height);
        expect(decoded.info.channels).toBe(source.info.channels);
        expect(decoded.data.equals(source.data)).toBeTrue();
    });
});

describe('lossless WebP cache', () => {
    it('encodes a requested image only once', async () => {
        let calls = 0;
        const cache = new LosslessWebPCache(async png => {
            calls++;
            return Buffer.from(png);
        });
        const png = fixturePng();

        const first = cache.get('PictImage:nova:8000', png);
        const second = cache.get('PictImage:nova:8000', png);

        expect(second).toBe(first);
        expect((await second).equals(png)).toBeTrue();
        expect(calls).toBe(1);
    });

    it('runs at most one first-time encode concurrently', async () => {
        let active = 0;
        let maxActive = 0;
        const releases: Array<() => void> = [];
        const cache = new LosslessWebPCache(async png => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>(resolve => releases.push(resolve));
            active--;
            return Buffer.from(png);
        });
        const png = fixturePng();
        const first = cache.get('first', png);
        const second = cache.get('second', png);

        await Promise.resolve();
        expect(releases.length).toBe(1);
        releases.shift()!();
        await first;
        await Promise.resolve();
        expect(releases.length).toBe(1);
        releases.shift()!();
        await second;

        expect(maxActive).toBe(1);
    });
});
