/**
 * Client runtime telemetry reporter for NovaJS.
 * Reports uncaught errors and flight anomalies back to the /client-error server endpoint.
 */
export function reportClientError(
    error: unknown,
    context = 'general',
    systemId?: string,
): void {
    try {
        if (typeof window === 'undefined') {
            return;
        }

        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        const currentSys = systemId
            ?? (window as any).system?.resources?.get?.((window as any).SystemIdResource);
        const playerToken = typeof localStorage !== 'undefined'
            ? localStorage.getItem('playerToken') ?? undefined
            : undefined;

        const payload = JSON.stringify({
            message,
            stack,
            context,
            systemId: currentSys,
            url: window.location.href,
            userAgent: navigator.userAgent,
            playerToken,
            timestamp: new Date().toISOString(),
        });

        if (typeof navigator.sendBeacon === 'function') {
            const blob = new Blob([payload], { type: 'application/json' });
            navigator.sendBeacon('/client-error', blob);
        } else {
            void fetch('/client-error', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload,
                keepalive: true,
            }).catch(() => undefined);
        }
    } catch {
        // Telemetry failure must never affect the user experience.
    }
}
