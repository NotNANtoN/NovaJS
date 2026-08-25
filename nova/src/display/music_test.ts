import 'jasmine';
import {
    DEFAULT_MASTER_VOLUME,
    TITLE_MUSIC_URL,
    startTitleMusicOnGesture,
    stopTitleMusic,
} from './music';

class FakeAudio {
    static instances: FakeAudio[] = [];
    static plays: Array<() => Promise<void>> = [];
    readonly src: string;
    loop = false;
    preload = '';
    volume = 1;
    currentTime = 12;
    paused = false;
    playCalls = 0;
    pauseCalls = 0;

    constructor(src: string) {
        this.src = src;
        FakeAudio.instances.push(this);
    }

    play() {
        this.playCalls++;
        this.paused = false;
        return (FakeAudio.plays.shift() ?? (() => Promise.resolve()))();
    }

    pause() {
        this.pauseCalls++;
        this.paused = true;
    }
}

const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};

describe('title music', () => {
    let eventWindow: EventTarget;

    beforeEach(() => {
        eventWindow = new EventTarget();
        (globalThis as any).window = eventWindow;
        (globalThis as any).Audio = FakeAudio;
        FakeAudio.instances = [];
        FakeAudio.plays = [];
        stopTitleMusic();
    });

    afterEach(() => {
        stopTitleMusic();
        delete (globalThis as any).window;
        delete (globalThis as any).Audio;
    });

    it('starts immediately with retail URL, loop, and master volume', async () => {
        startTitleMusicOnGesture();
        await settle();
        const audio = FakeAudio.instances[0]!;
        expect(audio.src).toBe(TITLE_MUSIC_URL);
        expect(audio.loop).toBeTrue();
        expect(audio.volume).toBe(DEFAULT_MASTER_VOLUME);
        expect(audio.playCalls).toBe(1);
        eventWindow.dispatchEvent(new Event('pointerdown'));
        eventWindow.dispatchEvent(new Event('keydown'));
        await settle();
        expect(FakeAudio.instances.length).toBe(1);
        expect(audio.playCalls).toBe(1);
    });

    it('retries after rejection and suppresses duplicate gestures', async () => {
        FakeAudio.plays.push(
            () => Promise.reject(new Error('autoplay blocked')),
            () => Promise.resolve(),
        );
        startTitleMusicOnGesture();
        await settle();
        expect(FakeAudio.instances.length).toBe(1);

        eventWindow.dispatchEvent(new Event('pointerdown'));
        eventWindow.dispatchEvent(new Event('keydown'));
        await settle();
        expect(FakeAudio.instances.length).toBe(2);
        expect(FakeAudio.instances[1]!.playCalls).toBe(1);
    });

    it('stops, rewinds, and can restart on a later main menu', async () => {
        startTitleMusicOnGesture();
        await settle();
        const first = FakeAudio.instances[0]!;
        stopTitleMusic();
        expect(first.pauseCalls).toBeGreaterThan(0);
        expect(first.currentTime).toBe(0);

        startTitleMusicOnGesture();
        await settle();
        expect(FakeAudio.instances.length).toBe(2);
        expect(FakeAudio.instances[1]!.playCalls).toBe(1);
    });
});
