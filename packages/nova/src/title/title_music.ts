/**
 * The original's title theme (`Nova Music.mp3`), looped on the title
 * screen.
 *
 * It's a plain ~9 MB mp3 sitting in the game data, NOT a `snd` resource,
 * so it deliberately bypasses the parsed-resource / @pixi/sound pipeline:
 * that path would pull the whole file into memory as a decoded buffer. A
 * single streaming `HTMLAudioElement` (served over the whitelisted
 * `/title_music.mp3` route, which supports Range requests) is both simpler
 * and lighter — it streams and loops without ever holding the decoded PCM.
 *
 * Autoplay policy is the real subtlety: the title is the first thing shown,
 * before any user gesture, so browsers block `play()`. We attempt playback
 * immediately anyway and, if blocked, arm a one-shot gesture listener
 * (pointerdown / keydown) that starts it on the player's first interaction.
 * Either way nothing is logged — a blocked autoplay is expected, not an
 * error.
 */

/** The subset of HTMLAudioElement this uses (injectable for tests). */
export interface AudioLike {
    loop: boolean;
    volume: number;
    paused: boolean;
    currentTime: number;
    play(): Promise<void> | undefined;
    pause(): void;
}

/** The subset of an EventTarget this uses for the gesture fallback. */
export interface GestureTarget {
    addEventListener(type: string, listener: () => void,
        options?: boolean | AddEventListenerOptions): void;
    removeEventListener(type: string, listener: () => void,
        options?: boolean | EventListenerOptions): void;
}

/** URL of the whitelisted static route the server serves the mp3 on. */
export const TITLE_MUSIC_URL = '/title_music.mp3';

/** A middle-of-the-road level: audible over the quiet title screen without
 * drowning the 600/601 button clicks (which play at 0.2). */
const DEFAULT_VOLUME = 0.35;

/** The gestures that count as "the player interacted", unblocking audio. */
const GESTURE_EVENTS = ['pointerdown', 'keydown'] as const;

export class TitleMusic {
    private readonly audio: AudioLike;
    private readonly gestureTarget: GestureTarget;
    private readonly volume: number;
    /** True between play() and stop(): the intent to be playing. Guards the
     * gesture retry so a stop() before the first gesture cancels it. */
    private wantPlaying = false;
    /** The armed gesture listener, if playback is waiting on a gesture. */
    private gestureListener?: () => void;

    constructor(options: {
        audio?: AudioLike,
        gestureTarget?: GestureTarget,
        volume?: number,
        src?: string,
    } = {}) {
        this.volume = options.volume ?? DEFAULT_VOLUME;
        // Defaults only touch the DOM globals when not injected, so the
        // class stays constructible (with fakes) under Node/jasmine.
        this.audio = options.audio
            ?? new Audio(options.src ?? TITLE_MUSIC_URL);
        this.gestureTarget = options.gestureTarget ?? window;
        this.audio.loop = true;
        this.audio.volume = this.volume;
    }

    /**
     * Starts (or resumes) the looping theme. Attempts playback right away;
     * if the browser blocks it (no user gesture yet), arms a one-shot
     * gesture listener to start it on the first pointerdown / keydown. Safe
     * to call when already playing (no-op) and silent on a blocked autoplay.
     */
    play() {
        this.wantPlaying = true;
        this.audio.volume = this.volume;
        this.attemptPlay();
    }

    /**
     * Stops the theme and rewinds it (the original restarts the track when
     * you return to the title, rather than resuming mid-phrase). Disarms any
     * pending gesture retry, so a stop() before the first gesture cancels the
     * queued start.
     */
    stop() {
        this.wantPlaying = false;
        this.disarmGesture();
        if (!this.audio.paused) {
            this.audio.pause();
        }
        this.audio.currentTime = 0;
    }

    private attemptPlay() {
        const result = this.audio.play();
        // Some environments (and every fake) return undefined rather than a
        // promise; nothing more to do there.
        if (result && typeof result.catch === 'function') {
            result.catch(() => {
                // Autoplay blocked before a user gesture — expected, not an
                // error. Wait for the first interaction, unless a stop() has
                // meanwhile cancelled the intent.
                if (this.wantPlaying) {
                    this.armGesture();
                }
            });
        }
    }

    private armGesture() {
        if (this.gestureListener) {
            return;
        }
        const listener = () => {
            this.disarmGesture();
            if (this.wantPlaying) {
                // The gesture allows audio now; a residual rejection is
                // swallowed to avoid console spam.
                const result = this.audio.play();
                result?.catch?.(() => { /* give up silently */ });
            }
        };
        this.gestureListener = listener;
        for (const type of GESTURE_EVENTS) {
            // Capture phase so a handler that stops bubbling (e.g. Pixi's
            // canvas interaction) can't swallow the very first gesture.
            this.gestureTarget.addEventListener(type, listener, true);
        }
    }

    private disarmGesture() {
        if (!this.gestureListener) {
            return;
        }
        for (const type of GESTURE_EVENTS) {
            this.gestureTarget.removeEventListener(
                type, this.gestureListener, true);
        }
        this.gestureListener = undefined;
    }
}
