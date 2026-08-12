import {
    ClientVersionAction, decideClientAction, VERSION_PATH,
} from "../common/version_handshake.js";

/**
 * The client half of the build-version handshake: decide whether this
 * bundle is stale and, if so, reload once to pick up the current one.
 *
 * Every side effect is injected. The decision itself is
 * `decideClientAction` (pure), and this module is the thin, spec'd shell
 * that turns an action into effects -- so the interesting behavior,
 * including the loop guard, is tested without a DOM or a real
 * `sessionStorage`.
 *
 * ON CACHE BUSTING: none is needed, and none is done. `setup_routes.ts`
 * serves index.html and every bundle with `Cache-Control: no-cache`, which
 * forces a revalidation on each load (a 304 keeps it cheap). So a plain
 * `location.reload()` is guaranteed to re-ask the server and pick up a new
 * bundle. Appending a cache-busting query parameter would additionally
 * change the URL the player sees and would break the `?enter` / `?ship` /
 * `?system` / `?char` startup parameters `browser.ts` reads, so it is
 * deliberately avoided. If a future deploy puts a CDN or a caching proxy in
 * front that ignores `no-cache`, the loop guard below degrades to a
 * hard-refresh prompt rather than a reload loop.
 */

/** Where the one-automatic-reload marker is kept. */
export const RELOAD_MARKER_KEY = 'novajs.versionReloadAttempted';

export const RELOADING_MESSAGE = 'Game updated — reloading…';

export const BLOCKED_MESSAGE =
    'This copy of the game is out of date and reloading did not fix it. '
    + 'Please hard-refresh the page (Ctrl-Shift-R, or Cmd-Shift-R on a Mac).';

export interface VersionCheckDeps {
    /** Reads the marker that survives the one automatic reload. */
    getAlreadyReloaded: () => boolean;
    setAlreadyReloaded: (value: boolean) => void;
    reload: () => void;
    /** Shows the player a notice. `persistent` notices are never cleared. */
    showNotice: (message: string, persistent: boolean) => void;
    warn: (message: string) => void;
}

/**
 * In-memory latch recording that this PAGE has already asked to reload.
 *
 * Distinct from the persisted marker, which survives the reload and
 * answers "did the previous page already try?". This one answers "is a
 * reload already in flight right now?", and it exists because
 * `location.reload()` does NOT stop execution -- the navigation is queued
 * and the document keeps running. Both routes into the check (the
 * `/version` preflight and the websocket refusal) fire within a few
 * milliseconds of each other on a real mismatch, so without this latch the
 * second one reads the marker the first one just persisted, concludes
 * "already reloaded once", and replaces the correct "reloading…" banner
 * with the terminal hard-refresh error -- on a reload that is about to
 * succeed.
 */
export interface VersionCheckState { reloadRequested: boolean; }

export function makeVersionCheckState(): VersionCheckState {
    return { reloadRequested: false };
}

/**
 * Turns a decided action into effects.
 *
 * `state` makes this idempotent across BOTH routes: pass the same state
 * object to every call for a given page and at most one reload is ever
 * requested, and a late `blocked` cannot stomp an in-flight reload. The
 * default argument is a fresh state, i.e. "this call shares nothing",
 * which is what a one-off caller wants.
 */
export function applyVersionAction(
    action: ClientVersionAction, deps: VersionCheckDeps,
    state: VersionCheckState = makeVersionCheckState(),
): void {
    switch (action) {
        case 'ok':
            // The build matches, so whatever reload got us here worked.
            // Clearing the marker restores the one-free-reload budget for
            // the next deploy; without this, a tab that reloaded once
            // would refuse to auto-reload ever again.
            deps.setAlreadyReloaded(false);
            return;
        case 'reload':
            if (state.reloadRequested) {
                return;
            }
            state.reloadRequested = true;
            // Set the marker BEFORE reloading. If it were set after, the
            // reload would race it and the fresh page could come up with
            // no record that it had already tried -- which is exactly the
            // infinite loop the guard exists to prevent.
            deps.setAlreadyReloaded(true);
            deps.showNotice(RELOADING_MESSAGE, false);
            deps.reload();
            return;
        case 'blocked':
            // A reload this page already requested is still in flight, so
            // the mismatch is expected and about to be fixed. Saying
            // "reloading did not help" here would be both wrong and the
            // last thing the player sees before the page goes away.
            if (state.reloadRequested) {
                return;
            }
            deps.warn('Build version still mismatched after an automatic '
                + 'reload; not reloading again.');
            deps.showNotice(BLOCKED_MESSAGE, true);
            return;
        case 'unknown':
            return;
    }
}

/**
 * Compares `serverVersion` against this bundle's `clientVersion` and acts.
 * Returns the action taken, for tests and for callers that want to log it.
 */
export function handleServerVersion(
    serverVersion: string | undefined,
    clientVersion: string | undefined,
    deps: VersionCheckDeps,
    state: VersionCheckState = makeVersionCheckState(),
): ClientVersionAction {
    const action = decideClientAction(
        serverVersion, clientVersion, deps.getAlreadyReloaded());
    applyVersionAction(action, deps, state);
    return action;
}

/** Element id of the notice overlay, so it is only ever created once. */
const NOTICE_ELEMENT_ID = 'nova-version-notice';

/**
 * Shows (or updates) the version notice as a plain DOM overlay.
 *
 * Deliberately NOT drawn with PIXI: this must be able to appear when the
 * bundle is stale or the game never finished starting, so it may not
 * depend on any game state being alive.
 */
function showBrowserNotice(message: string, persistent: boolean) {
    let element = document.getElementById(NOTICE_ELEMENT_ID);
    if (!element) {
        element = document.createElement('div');
        element.id = NOTICE_ELEMENT_ID;
        element.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
            'padding:12px 16px', 'background:#101014', 'color:#e8e8ea',
            'font:16px/1.4 sans-serif', 'text-align:center',
            'border-bottom:1px solid #3a3a44',
        ].join(';');
        document.body.appendChild(element);
    }
    element.textContent = message;
    // A persistent notice is the terminal state, so make it unmissable.
    element.style.background = persistent ? '#3a1414' : '#101014';
}

/**
 * Real browser effects: a per-tab `sessionStorage` marker, a DOM overlay,
 * and `location.reload()`.
 *
 * `sessionStorage` (not `localStorage`) because the guard is about THIS
 * tab's one reload attempt; a second tab deserves its own attempt, and the
 * marker should not outlive the browsing session.
 *
 * Access is wrapped because it throws outright in a partitioned or
 * storage-blocked context. A context that cannot persist the marker
 * reports "already reloaded" (i.e. FAILS SAFE): it forfeits its automatic
 * reload and goes straight to the hard-refresh message. Reporting "not yet
 * reloaded" would read better but is the one genuinely unacceptable
 * answer -- with no way to remember the attempt, every reloaded page would
 * decide to reload again, which is an infinite loop rather than a missing
 * convenience.
 */
export function browserVersionCheckDeps(): VersionCheckDeps {
    return {
        getAlreadyReloaded: () => {
            try {
                return sessionStorage.getItem(RELOAD_MARKER_KEY) === 'true';
            } catch {
                return true;
            }
        },
        setAlreadyReloaded: (value: boolean) => {
            try {
                if (value) {
                    sessionStorage.setItem(RELOAD_MARKER_KEY, 'true');
                } else {
                    sessionStorage.removeItem(RELOAD_MARKER_KEY);
                }
            } catch {
                // Storage unavailable; the loop guard degrades to off.
            }
        },
        reload: () => location.reload(),
        showNotice: showBrowserNotice,
        warn: (m: string) => console.warn(m),
    };
}

/**
 * Wires the whole client-side check up in the browser: run the `/version`
 * preflight now, and react to a websocket refusal if one arrives first.
 *
 * The preflight does NOT block the game's startup. The browser bundle is
 * an IIFE, so it has no top-level `await`, and the socket is opened from
 * module top-level; gating that on a fetch would mean restructuring
 * startup. It does not need to be blocking, because it is not the
 * enforcement point -- `SocketChannelServer` refuses a mismatched client
 * outright, so the worst case is that a doomed client renders for the
 * fraction of a second before the reload lands.
 */
export function installVersionCheck(
    clientVersion: string | undefined,
    deps: VersionCheckDeps = browserVersionCheckDeps(),
): {
    onVersionMismatch: (reason: string) => void,
    onAdmitted: () => void,
} {
    // ONE state shared by both routes, so they cannot fight; see
    // VersionCheckState.
    const state = makeVersionCheckState();

    void (async () => {
        const serverVersion = await fetchServerVersion();
        handleServerVersion(serverVersion, clientVersion, deps, state);
    })();

    return {
        // The websocket refusal carries the server's stamp in its close
        // reason, but it is not parsed: the refusal itself already proves
        // a mismatch, so the action is decided from the guard alone.
        onVersionMismatch: (reason: string) => {
            deps.warn(`Server refused this build: ${reason}`);
            applyVersionAction(
                deps.getAlreadyReloaded() ? 'blocked' : 'reload', deps, state);
        },
        /**
         * Called once the server has actually admitted this client, which
         * it only does for a matching build -- so admission is positive
         * proof the versions agree, and the strongest re-arm signal there
         * is. Without it the loop guard's reset would depend entirely on
         * the `/version` preflight, the route that is NOT the enforcement
         * point: if that route were persistently unreachable, the marker
         * would never clear and the next real deploy would skip straight
         * to the hard-refresh message without spending its one reload.
         */
        onAdmitted: () => {
            if (state.reloadRequested) {
                return;
            }
            deps.setAlreadyReloaded(false);
        },
    };
}

/**
 * Longest plausible build stamp. Real ones are ~10-30 characters; the cap
 * only has to be small enough to reject a document.
 */
const MAX_VERSION_LENGTH = 200;

/**
 * True iff `text` could be a build stamp rather than something else the
 * server happened to return with a 200.
 *
 * This guards a specific, reachable case: a server predating this feature
 * has no `/version` route, so the request falls through to setupRoutes'
 * `use("/")` catch-all and comes back as **index.html with status 200**.
 * Without this check that HTML would be read as the server's stamp, every
 * client would "mismatch", and the loop guard would park the page on a
 * hard-refresh message that no amount of refreshing fixes. A stamp is a
 * single short token with no whitespace and no markup.
 */
function looksLikeVersion(text: string): boolean {
    return text.length > 0
        && text.length <= MAX_VERSION_LENGTH
        && !/[\s<>]/.test(text);
}

/**
 * Fetches the server's build stamp. Resolves to undefined on any failure,
 * which `decideClientAction` reads as `unknown` and ignores -- a network
 * blip or a proxy error page must not trigger a reload.
 */
export async function fetchServerVersion(
    doFetch: typeof fetch = fetch,
): Promise<string | undefined> {
    try {
        const response = await doFetch(VERSION_PATH, { cache: 'no-store' });
        if (!response.ok) {
            return undefined;
        }
        // An HTML body means the catch-all answered, not the version
        // route; see looksLikeVersion.
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType && !contentType.includes('text/plain')) {
            return undefined;
        }
        const text = (await response.text()).trim();
        return looksLikeVersion(text) ? text : undefined;
    } catch {
        return undefined;
    }
}
