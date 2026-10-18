import { dataPath } from '../common/GameDataPaths';

export type ArtworkExtension = '.png' | '.webp';

let detectedExtension: ArtworkExtension | undefined;

export function selectArtworkExtension(
    supportsWebP: boolean,
): ArtworkExtension {
    return supportsWebP ? '.webp' : '.png';
}

export function browserSupportsWebP(): boolean {
    if (typeof document === 'undefined') {
        return false;
    }
    try {
        return document.createElement('canvas')
            .toDataURL('image/webp')
            .startsWith('data:image/webp');
    } catch {
        return false;
    }
}

export function artworkExtension(): ArtworkExtension {
    detectedExtension ??= selectArtworkExtension(browserSupportsWebP());
    return detectedExtension;
}

export const CONQUEST_ARTWORK_VERSION = '4';

export function artworkUrl(type: string, id: string): string {
    const base = `${dataPath}/${type}/${encodeURIComponent(id)}${
        artworkExtension()}`;
    return id.startsWith('conquest:')
        ? `${base}?v=${CONQUEST_ARTWORK_VERSION}`
        : base;
}

export function preferredArtworkPath(path: string): string {
    return path.replace(/\.png$/i, artworkExtension());
}
