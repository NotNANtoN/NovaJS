export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

function getActiveLogLevel(): LogLevel {
    if (typeof process !== 'undefined' && process.env?.NOVA_LOG_LEVEL) {
        const env = process.env.NOVA_LOG_LEVEL.toLowerCase() as LogLevel;
        if (env in LEVEL_WEIGHTS) return env;
    }
    return 'info';
}

export interface Logger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

export function createLogger(context: string): Logger {
    const minLevel = getActiveLogLevel();
    const minWeight = LEVEL_WEIGHTS[minLevel];

    const formatPrefix = (level: string) => {
        const now = new Date().toISOString();
        return `[${now}] [${level}] [${context}]`;
    };

    return {
        debug(message: string, ...args: unknown[]) {
            if (LEVEL_WEIGHTS.debug >= minWeight) {
                console.debug(`${formatPrefix('DEBUG')} ${message}`, ...args);
            }
        },
        info(message: string, ...args: unknown[]) {
            if (LEVEL_WEIGHTS.info >= minWeight) {
                console.info(`${formatPrefix('INFO')} ${message}`, ...args);
            }
        },
        warn(message: string, ...args: unknown[]) {
            if (LEVEL_WEIGHTS.warn >= minWeight) {
                console.warn(`${formatPrefix('WARN')} ${message}`, ...args);
            }
        },
        error(message: string, ...args: unknown[]) {
            if (LEVEL_WEIGHTS.error >= minWeight) {
                console.error(`${formatPrefix('ERROR')} ${message}`, ...args);
            }
        },
    };
}
