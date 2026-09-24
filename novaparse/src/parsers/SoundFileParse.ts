import { SndResource } from '../resource_parsers/SndResource';

interface Mp3EncoderLike {
    encodeBuffer(left: ArrayLike<number>): Int8Array;
    flush(): Int8Array;
}
type Mp3EncoderConstructor = new (channels: 1 | 2, sampleRate: number,
    bitrate: number) => Mp3EncoderLike;

let encoderConstructor: Promise<Mp3EncoderConstructor> | undefined;

/**
 * lamejs 1.2.1's CommonJS entry relies on sloppy-mode implicit globals
 * (`MPEGMode`, `Lame`, ...) and throws "MPEGMode is not defined" when loaded
 * as a module, so no sound effect could be converted. Its single-file build
 * is self-contained; evaluate that in an isolated context instead.
 */
async function loadMp3Encoder(): Promise<Mp3EncoderConstructor> {
    encoderConstructor ??= (async () => {
        const [{ createRequire }, fs, vm] = await Promise.all([
            import('node:module'), import('node:fs'), import('node:vm'),
        ]);
        const require = createRequire(import.meta.url);
        const source = fs.readFileSync(require.resolve('lamejs/lame.all.js'), 'utf8');
        const context = vm.createContext({ console });
        vm.runInContext(`${source};this.__lamejs = lamejs;`, context);
        return (context as { __lamejs: { Mp3Encoder: Mp3EncoderConstructor } })
            .__lamejs.Mp3Encoder;
    })();
    return encoderConstructor;
}

export async function SoundFileParse(sound: SndResource): Promise<ArrayBuffer> {
    let mp3Samples: number[];
    let mp3Rate: number;
    try {
        ({ mp3Samples, mp3Rate } = sound.sound);
    } catch (e) {
        console.warn(e);
        mp3Samples = [];
        mp3Rate = 8000;
    }
    const Mp3Encoder = await loadMp3Encoder();
    const encoder = new Mp3Encoder(1, mp3Rate, 128);
    const a = encoder.encodeBuffer(mp3Samples); //encode mp3
    const b = encoder.flush();

    const out = new Int8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out.buffer;
}
