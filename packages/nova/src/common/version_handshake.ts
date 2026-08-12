/**
 * The client/server build-version handshake.
 *
 * WHY THIS EXISTS
 * ---------------
 * The multiplayer design assumes every peer runs the SAME build of NovaJS.
 * Nothing in the netcode reconciles two different builds: a stale client
 * that joins a room alongside updated peers steps a different simulation
 * and fails the desync hash immediately. Historically that failure mode
 * arrived disguised as a netcode mystery (see the `no-cache` note in
 * `src/server/setup_routes.ts`), because a browser happily reuses a cached
 * bundle against a redeployed server.
 *
 * So the assumption is ENFORCED rather than hoped for: the server knows the
 * build it was compiled from, every client announces the build its bundle
 * was compiled from, and a client that does not match is refused admission
 * and told to reload.
 *
 * RELATIONSHIP TO `rollback_relay.ts`
 * -----------------------------------
 * The rollback relay tracks per-peer protocol stamps and mismatch streaks
 * (peerProtocols / mismatchStreaks). That machinery is FORENSIC: it runs
 * once a peer is already in the room, and can only observe and report that
 * two peers disagree -- by then the desync has happened. This handshake is
 * PREVENTIVE and sits strictly earlier: a mismatched build never reaches
 * the relay, so the relay's mismatch counters should now only ever be
 * tripped by a genuine bug within a single build rather than by a
 * version skew. The relay is deliberately left as-is; the two layers are
 * complementary, not redundant.
 *
 * This module is pure and dependency-free on purpose: the server imports it
 * to decide admission, the browser imports it to decide whether to reload,
 * and the specs exercise it without a socket, a DOM, or a build stamp.
 */

/** HTTP route serving the server's build stamp as `text/plain`. */
export const VERSION_PATH = '/version';

/**
 * Query parameter carrying the client's build stamp on the websocket
 * connect URL (`ws://host/?v=<stamp>`).
 *
 * A query parameter is used rather than a new message in the socket
 * protocol because the check must happen BEFORE the client is admitted --
 * i.e. before `clientConnect` fires and the client can join a room. A
 * protocol-level hello would require the server to hold an unadmitted
 * socket in a pending state and would change `SocketMessage` for every
 * peer; the connect URL is available in the upgrade request itself.
 */
export const VERSION_QUERY_PARAM = 'v';

/**
 * Websocket close code sent to a client whose build does not match.
 *
 * 4000-4999 is the range reserved for application use, so no proxy or
 * browser assigns it a meaning of its own.
 */
export const VERSION_MISMATCH_CLOSE_CODE = 4001;

/**
 * Reads the build stamp a client put on its websocket connect URL.
 *
 * `url` is the raw request target from the upgrade request, which is
 * path-and-query only (`/?v=abc123`), so it is resolved against a dummy
 * origin to parse. Returns undefined when the parameter is absent or the
 * target is unparseable -- both of which `shouldAdmitClient` treats as a
 * refusal.
 */
export function versionFromConnectUrl(
    url: string | undefined | null,
): string | undefined {
    if (!url) {
        return undefined;
    }
    try {
        // The base is never used for anything but satisfying the parser;
        // only the query is read.
        const parsed = new URL(url, 'http://placeholder.invalid');
        return parsed.searchParams.get(VERSION_QUERY_PARAM) ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * Builds the websocket URL a client connects to, carrying its build stamp.
 *
 * `origin` is a `protocol://host` prefix such as `ws://localhost:8000`.
 */
export function connectUrlWithVersion(
    origin: string, clientVersion: string,
): string {
    return `${origin}/?${VERSION_QUERY_PARAM}=`
        + `${encodeURIComponent(clientVersion)}`;
}

/**
 * Truncates a close reason to fit a websocket close frame.
 *
 * The protocol caps the reason at 123 BYTES, and `ws` throws if it is
 * exceeded -- which would turn a tidy refusal into a server-side crash on
 * the very path meant to handle bad clients. Truncation is done on the
 * UTF-8 encoding, then trimmed back off any split multi-byte character.
 */
export function truncateCloseReason(reason: string): string {
    const maxBytes = 123;
    const encoded = new TextEncoder().encode(reason);
    if (encoded.length <= maxBytes) {
        return reason;
    }
    // A non-fatal decoder (the default) turns a trailing partial
    // character into U+FFFD; dropping it keeps the reason valid UTF-8 and
    // within the cap.
    const decoded = new TextDecoder('utf-8').decode(encoded.slice(0, maxBytes));
    return decoded.replace(/�$/, '');
}

/**
 * Longest announced version echoed back into a log line or close reason.
 * Real stamps are ~10-40 characters.
 */
const MAX_REPORTED_VERSION_LENGTH = 64;

/**
 * Makes a client-announced version safe to put in a server log line.
 *
 * The value arrives on an unauthenticated query string, so it is wholly
 * attacker-controlled: without a bound, a client could write megabytes per
 * connection attempt into the server's log, and newlines would let it
 * forge whole log entries. Control characters are stripped and the rest is
 * truncated.
 */
export function sanitizeReportedVersion(version: string): string {
    // eslint-disable-next-line no-control-regex
    const stripped = version.replace(/[\x00-\x1f\x7f]/g, '');
    return stripped.length > MAX_REPORTED_VERSION_LENGTH
        ? stripped.slice(0, MAX_REPORTED_VERSION_LENGTH) + '…'
        : stripped;
}

/** Whether a connecting client may be admitted. */
export type AdmitDecision =
    | { admit: true }
    | { admit: false, reason: string };

/**
 * Decides whether a client announcing `clientVersion` may be admitted by a
 * server built as `serverVersion`.
 *
 * FAILS CLOSED. A client that announces nothing at all is refused, because
 * that is exactly what a bundle predating this handshake looks like -- and
 * such a bundle is by definition not the current build. Admitting it would
 * put a stale simulation in a room with updated peers, which is the whole
 * failure this handshake exists to prevent.
 */
export function shouldAdmitClient(
    serverVersion: string,
    clientVersion: string | undefined | null,
): AdmitDecision {
    if (!clientVersion) {
        return {
            admit: false,
            reason: `Client announced no build version (server is `
                + `${serverVersion}). It predates the version handshake.`,
        };
    }
    if (clientVersion !== serverVersion) {
        return {
            admit: false,
            // The comparison above uses the RAW value; only the reported
            // copy is sanitized. The reason string is logged server-side
            // and echoed in the close frame, and clientVersion is
            // unauthenticated query-string input.
            reason: `Client build ${sanitizeReportedVersion(clientVersion)} `
                + `does not match server build ${serverVersion}.`,
        };
    }
    return { admit: true };
}

/**
 * What the client should do about the server's build stamp.
 *
 * - `ok`: builds match. Clear the "already reloaded" marker.
 * - `reload`: builds differ and we have not yet auto-reloaded. Set the
 *   marker, show the notice, reload.
 * - `blocked`: builds differ and we ALREADY auto-reloaded once. Do not
 *   reload again -- show a persistent message asking for a hard refresh.
 * - `unknown`: we could not establish either stamp. Do nothing.
 */
export type ClientVersionAction = 'ok' | 'reload' | 'blocked' | 'unknown';

/**
 * Pure decision behind the client's force-reload, kept free of `location`,
 * `sessionStorage`, and the DOM so it can be spec'd directly.
 *
 * FAILS OPEN, unlike `shouldAdmitClient`. If either stamp is missing we
 * return `unknown` and do nothing: a failed `/version` fetch is far more
 * likely to be a network blip or a proxy error page than a real version
 * skew, and reloading on those would spin the page. Nothing is lost by
 * being lenient here, because the server independently refuses the socket
 * -- the client-side check exists to make the common case fast and legible,
 * not to be the enforcement point.
 *
 * `alreadyReloaded` is the loop guard: it is the persisted record that this
 * tab has already burned its one automatic reload. One reload fixes a
 * genuinely stale cache; a second would not, so a build that still
 * mismatches after reloading yields `blocked` forever rather than looping.
 * That also covers the dev-mode case of a hand-restarted server serving a
 * bundle built from a different tree, which no amount of reloading fixes.
 */
export function decideClientAction(
    serverVersion: string | undefined | null,
    clientVersion: string | undefined | null,
    alreadyReloaded: boolean,
): ClientVersionAction {
    if (!serverVersion || !clientVersion) {
        return 'unknown';
    }
    if (serverVersion === clientVersion) {
        return 'ok';
    }
    return alreadyReloaded ? 'blocked' : 'reload';
}
