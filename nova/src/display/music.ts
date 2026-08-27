const MASTER_VOLUME_KEY = 'nova.masterVolume';
export const DEFAULT_MASTER_VOLUME = 0.045;
export const MASTER_VOLUME_STEP = 0.005;
export const TITLE_MUSIC_URL = '/music/Nova%20Music.mp3';

let masterVolume = readStoredVolume();
let titleMusic: HTMLAudioElement | undefined;
let titleMusicPlay: Promise<void> | undefined;
let gestureHandlersInstalled = false;

function hasPriorUserActivation(): boolean {
    if (typeof navigator === 'undefined') {
        return false;
    }
    return navigator.userActivation?.hasBeenActive ?? false;
}

function clampVolume(volume: number): number {
    return Math.min(1, Math.max(0, volume));
}

function readStoredVolume(): number {
    if (typeof localStorage === 'undefined') {
        return DEFAULT_MASTER_VOLUME;
    }

    try {
        const raw = localStorage.getItem(MASTER_VOLUME_KEY);
        if (raw === null) {
            return DEFAULT_MASTER_VOLUME;
        }
        const stored = Number(raw);
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

export function getTitleMusicState() {
    return {
        created: titleMusic !== undefined,
        paused: titleMusic?.paused ?? true,
        currentTime: titleMusic?.currentTime ?? 0,
        url: titleMusic?.src ?? TITLE_MUSIC_URL,
        loop: titleMusic?.loop ?? true,
        volume: titleMusic?.volume ?? masterVolume,
        playPending: titleMusicPlay !== undefined,
        retryArmed: gestureHandlersInstalled,
    };
}

function removeGestureHandler() {
    if (!gestureHandlersInstalled || typeof window === 'undefined') {
        return;
    }
    window.removeEventListener('pointerdown', retryTitleMusic);
    window.removeEventListener('keydown', retryTitleMusic);
    gestureHandlersInstalled = false;
}

function installGestureHandlers() {
    if (gestureHandlersInstalled || typeof window === 'undefined') {
        return;
    }
    gestureHandlersInstalled = true;
    window.addEventListener('pointerdown', retryTitleMusic);
    window.addEventListener('keydown', retryTitleMusic);
}

function retryTitleMusic() {
    void playTitleMusic();
}

function abortTitleMusicDownload(audio: HTMLAudioElement) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
}

async function playTitleMusic() {
    if (titleMusicPlay || typeof Audio === 'undefined') {
        return titleMusicPlay;
    }

    const audio = titleMusic ?? new Audio();
    audio.loop = true;
    audio.preload = 'auto';
    audio.volume = masterVolume;
    audio.src = TITLE_MUSIC_URL;
    titleMusic = audio;

    let playback: Promise<void> | void;
    try {
        playback = audio.play();
    } catch (error) {
        abortTitleMusicDownload(audio);
        titleMusic = undefined;
        installGestureHandlers();
        console.warn('Unable to play Nova title music', error);
        return;
    }
    const attempt = Promise.resolve(playback).then(() => {
        if (titleMusic === audio) {
            removeGestureHandler();
        }
    }).catch(error => {
        if (titleMusic === audio) {
            abortTitleMusicDownload(audio);
            titleMusic = undefined;
            installGestureHandlers();
            console.warn('Unable to play Nova title music', error);
        }
    }).finally(() => {
        if (titleMusicPlay === attempt) {
            titleMusicPlay = undefined;
        }
    });
    titleMusicPlay = attempt;
    return attempt;
}

/**
 * Start the title theme on the first browser gesture. It is deliberately
 * independent of the ECS worlds, since it should only play once per session.
 */
export function startTitleMusicOnGesture() {
    if (typeof window === 'undefined') {
        return;
    }
    if (hasPriorUserActivation()) {
        void playTitleMusic();
    } else {
        installGestureHandlers();
    }
}

/**
 * The current client has no main menu. Stop the theme permanently once the
 * player ship has spawned in its first system.
 */
export function stopTitleMusic() {
    removeGestureHandler();
    titleMusicPlay = undefined;
    if (titleMusic) {
        abortTitleMusicDownload(titleMusic);
        titleMusic.currentTime = 0;
        titleMusic = undefined;
    }
}
