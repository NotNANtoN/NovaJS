const MASTER_VOLUME_KEY = 'nova.masterVolume';
export const DEFAULT_MASTER_VOLUME = 0.045;
export const MASTER_VOLUME_STEP = 0.005;
export const TITLE_MUSIC_URL = '/music/Nova%20Music.mp3';

let masterVolume = readStoredVolume();
let titleMusic: HTMLAudioElement | undefined;
let titleMusicStopped = false;
let gestureHandler: (() => void) | undefined;

function clampVolume(volume: number): number {
    return Math.min(1, Math.max(0, volume));
}

function readStoredVolume(): number {
    if (typeof localStorage === 'undefined') {
        return DEFAULT_MASTER_VOLUME;
    }

    try {
        const stored = Number(localStorage.getItem(MASTER_VOLUME_KEY));
        return Number.isFinite(stored)
            ? clampVolume(stored) : DEFAULT_MASTER_VOLUME;
    } catch {
        return DEFAULT_MASTER_VOLUME;
    }
}

export function getMasterVolume(): number {
    return masterVolume;
}

export function setMasterVolume(volume: number): number {
    masterVolume = clampVolume(volume);
    if (titleMusic) {
        titleMusic.volume = masterVolume;
    }

    if (typeof localStorage !== 'undefined') {
        try {
            localStorage.setItem(MASTER_VOLUME_KEY, String(masterVolume));
        } catch {
            // Some browsers disable storage, but audio should still work.
        }
    }
    return masterVolume;
}

function removeGestureHandler() {
    if (!gestureHandler || typeof window === 'undefined') {
        return;
    }
    window.removeEventListener('pointerdown', gestureHandler);
    window.removeEventListener('keydown', gestureHandler);
    gestureHandler = undefined;
}

function playTitleMusic() {
    if (titleMusicStopped || titleMusic || typeof Audio === 'undefined') {
        return;
    }

    const audio = new Audio(TITLE_MUSIC_URL);
    audio.loop = true;
    audio.preload = 'auto';
    audio.volume = masterVolume;
    titleMusic = audio;

    const playPromise = audio.play();
    if (playPromise) {
        void playPromise.catch(error => {
            console.warn('Unable to play Nova title music', error);
        });
    }
}

/**
 * Start the title theme on the first browser gesture. It is deliberately
 * independent of the ECS worlds, since it should only play once per session.
 */
export function startTitleMusicOnGesture() {
    if (typeof window === 'undefined' || gestureHandler || titleMusicStopped) {
        return;
    }

    titleMusicStopped = false;
    gestureHandler = playTitleMusic;
    window.addEventListener('pointerdown', gestureHandler, { once: true });
    window.addEventListener('keydown', gestureHandler, { once: true });
}

/**
 * The current client has no main menu. Stop the theme permanently once the
 * player ship has spawned in its first system.
 */
export function stopTitleMusic() {
    titleMusicStopped = true;
    removeGestureHandler();
    if (titleMusic) {
        titleMusic.pause();
        titleMusic.currentTime = 0;
        titleMusic = undefined;
    }
}
