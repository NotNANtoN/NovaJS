import 'jasmine';
import { AudioLike, GestureTarget, TitleMusic } from './title_music.js';

/** A fake HTMLAudioElement whose play() outcome the test controls. */
class FakeAudio implements AudioLike {
    loop = false;
    volume = 1;
    paused = true;
    currentTime = 0;
    playCalls = 0;
    pauseCalls = 0;
    /** How the NEXT play() resolves: 'ok' (allowed) or 'blocked' (rejects,
     * like a pre-gesture autoplay). */
    nextPlay: 'ok' | 'blocked' = 'ok';

    play(): Promise<void> {
        this.playCalls++;
        if (this.nextPlay === 'blocked') {
            return Promise.reject(new Error('NotAllowedError'));
        }
        this.paused = false;
        return Promise.resolve();
    }
    pause(): void {
        this.pauseCalls++;
        this.paused = true;
    }
}

/** A fake gesture target that records listeners and can fire them. */
class FakeGestureTarget implements GestureTarget {
    listeners = new Map<string, Set<() => void>>();
    addEventListener(type: string, listener: () => void): void {
        (this.listeners.get(type) ?? this.set(type)).add(listener);
    }
    removeEventListener(type: string, listener: () => void): void {
        this.listeners.get(type)?.delete(listener);
    }
    private set(type: string): Set<() => void> {
        const s = new Set<() => void>();
        this.listeners.set(type, s);
        return s;
    }
    count(type: string): number {
        return this.listeners.get(type)?.size ?? 0;
    }
    fire(type: string): void {
        for (const listener of [...(this.listeners.get(type) ?? [])]) {
            listener();
        }
    }
}

function make(audio: FakeAudio, gestureTarget: FakeGestureTarget) {
    return new TitleMusic({ audio, gestureTarget, volume: 0.5 });
}

describe('TitleMusic', () => {
    it('loops and sets the configured volume on construction', () => {
        const audio = new FakeAudio();
        make(audio, new FakeGestureTarget());
        expect(audio.loop).toBe(true);
        expect(audio.volume).toBe(0.5);
    });

    it('plays immediately when autoplay is allowed, arming no gesture', async () => {
        const audio = new FakeAudio();
        const gestures = new FakeGestureTarget();
        const music = make(audio, gestures);
        audio.nextPlay = 'ok';
        music.play();
        // Let the resolved play() promise settle.
        await Promise.resolve();
        expect(audio.playCalls).toBe(1);
        expect(gestures.count('pointerdown')).toBe(0);
        expect(gestures.count('keydown')).toBe(0);
    });

    it('arms a one-shot gesture fallback when autoplay is blocked', async () => {
        const audio = new FakeAudio();
        const gestures = new FakeGestureTarget();
        const music = make(audio, gestures);
        audio.nextPlay = 'blocked';
        music.play();
        await Promise.resolve();
        // First attempt failed; listeners are now armed.
        expect(audio.playCalls).toBe(1);
        expect(gestures.count('pointerdown')).toBe(1);
        expect(gestures.count('keydown')).toBe(1);

        // The player's first gesture starts playback and disarms both.
        audio.nextPlay = 'ok';
        gestures.fire('pointerdown');
        expect(audio.playCalls).toBe(2);
        expect(gestures.count('pointerdown')).toBe(0);
        expect(gestures.count('keydown')).toBe(0);
    });

    it('does not start on a gesture if stop() cancelled the intent', async () => {
        const audio = new FakeAudio();
        const gestures = new FakeGestureTarget();
        const music = make(audio, gestures);
        audio.nextPlay = 'blocked';
        music.play();
        await Promise.resolve();
        expect(gestures.count('pointerdown')).toBe(1);

        // Entering the game before the player ever interacts: stop() must
        // disarm the fallback so a later stray gesture can't start music.
        music.stop();
        expect(gestures.count('pointerdown')).toBe(0);
        expect(gestures.count('keydown')).toBe(0);
        audio.nextPlay = 'ok';
        gestures.fire('pointerdown');
        expect(audio.playCalls).toBe(1); // still just the blocked attempt
    });

    it('stop() pauses and rewinds to the top', async () => {
        const audio = new FakeAudio();
        const music = make(audio, new FakeGestureTarget());
        audio.nextPlay = 'ok';
        music.play();
        await Promise.resolve();
        audio.currentTime = 42;
        music.stop();
        expect(audio.pauseCalls).toBe(1);
        expect(audio.currentTime).toBe(0);
    });
});
