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
    src = '';
    loop = false;
    preload = '';
    volume = 1;
    currentTime = 12;
    paused = false;
    playCalls = 0;
    pauseCalls = 0;
    loadCalls = 0;
    removedAttributes: string[] = [];

    constructor() {
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

    removeAttribute(attribute: string) {
        this.removedAttributes.push(attribute);
        if (attribute === 'src') {
            this.src = '';
        }
    }

    load() {
        this.loadCalls++;
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

    it('does not assign the source before a browser gesture', async () => {
        startTitleMusicOnGesture();
        await settle();
        expect(FakeAudio.instances.length).toBe(0);

        eventWindow.dispatchEvent(new Event('pointerdown'));
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

    it('aborts a rejected download before retrying', async () => {
        FakeAudio.plays.push(
            () => Promise.reject(new Error('autoplay blocked')),
            () => Promise.resolve(),
        );
        startTitleMusicOnGesture();
        eventWindow.dispatchEvent(new Event('pointerdown'));
        await settle();
        expect(FakeAudio.instances.length).toBe(1);
        const rejected = FakeAudio.instances[0]!;
        expect(rejected.src).toBe('');
        expect(rejected.removedAttributes).toContain('src');
        expect(rejected.loadCalls).toBe(1);

        eventWindow.dispatchEvent(new Event('pointerdown'));
        eventWindow.dispatchEvent(new Event('keydown'));
        await settle();
        expect(FakeAudio.instances.length).toBe(2);
        expect(FakeAudio.instances[1]!.playCalls).toBe(1);
    });

    it('stops, rewinds, and can restart on a later main menu', async () => {
        startTitleMusicOnGesture();
        eventWindow.dispatchEvent(new Event('pointerdown'));
        await settle();
        const first = FakeAudio.instances[0]!;
        stopTitleMusic();
        expect(first.pauseCalls).toBeGreaterThan(0);
        expect(first.currentTime).toBe(0);

        startTitleMusicOnGesture();
        eventWindow.dispatchEvent(new Event('pointerdown'));
        await settle();
        expect(FakeAudio.instances.length).toBe(2);
        expect(FakeAudio.instances[1]!.playCalls).toBe(1);
    });
});
