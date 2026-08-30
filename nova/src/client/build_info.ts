declare const __BUILD_COMMIT__: string | undefined;
declare const __BUILD_MESSAGE__: string | undefined;
declare const __BUILD_DATE__: string | undefined;

export interface BuildInfo {
    commit: string;
    message: string;
    date: string;
}

export function getBuildInfo(): BuildInfo {
    const now = new Date();
    const fallbackDate = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    return {
        commit: typeof __BUILD_COMMIT__ !== 'undefined' && __BUILD_COMMIT__ ? __BUILD_COMMIT__ : 'dev',
        message: typeof __BUILD_MESSAGE__ !== 'undefined' && __BUILD_MESSAGE__ ? __BUILD_MESSAGE__ : 'local development',
        date: typeof __BUILD_DATE__ !== 'undefined' && __BUILD_DATE__ ? __BUILD_DATE__ : fallbackDate,
    };
}
