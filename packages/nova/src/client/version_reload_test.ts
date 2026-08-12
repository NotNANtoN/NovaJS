import 'jasmine';
import {
    applyVersionAction, BLOCKED_MESSAGE, fetchServerVersion,
    handleServerVersion, installVersionCheck, makeVersionCheckState,
    RELOADING_MESSAGE, VersionCheckDeps,
} from './version_reload.js';

/**
 * A fake for every effect the client-side check performs, plus a recorded
 * history. No DOM, no sessionStorage, no jsdom -- the decision and the
 * loop guard are the behavior under test.
 */
class FakeDeps implements VersionCheckDeps {
    alreadyReloaded = false;
    reloads = 0;
    notices: { message: string, persistent: boolean }[] = [];
    warnings: string[] = [];

    getAlreadyReloaded = () => this.alreadyReloaded;
    setAlreadyReloaded = (value: boolean) => { this.alreadyReloaded = value; };
    reload = () => { this.reloads++; };
    showNotice = (message: string, persistent: boolean) =>
        { this.notices.push({ message, persistent }); };
    warn = (message: string) => { this.warnings.push(message); };
}

describe('client version reload', () => {
    let deps: FakeDeps;
    beforeEach(() => { deps = new FakeDeps(); });

    describe('matching builds', () => {
        it('does not reload', () => {
            handleServerVersion('same', 'same', deps);
            expect(deps.reloads).toEqual(0);
        });

        it('shows no notice', () => {
            handleServerVersion('same', 'same', deps);
            expect(deps.notices).toEqual([]);
        });

        // Restores the one-free-reload budget for the NEXT deploy.
        it('clears the loop-guard marker', () => {
            deps.alreadyReloaded = true;
            handleServerVersion('same', 'same', deps);
            expect(deps.alreadyReloaded).toBeFalse();
        });
    });

    describe('mismatched builds', () => {
        it('reloads once', () => {
            handleServerVersion('server', 'client', deps);
            expect(deps.reloads).toEqual(1);
        });

        it('tells the player it is reloading', () => {
            handleServerVersion('server', 'client', deps);
            expect(deps.notices.length).toEqual(1);
            expect(deps.notices[0].message).toEqual(RELOADING_MESSAGE);
            expect(deps.notices[0].persistent).toBeFalse();
        });

        // The marker must be durable BEFORE the reload, or the fresh page
        // races it and comes up with no record of having tried.
        it('persists the marker before reloading', () => {
            let markerWhenReloaded: boolean | undefined;
            deps.reload = () => { markerWhenReloaded = deps.alreadyReloaded; };
            handleServerVersion('server', 'client', deps);
            expect(markerWhenReloaded).toBeTrue();
        });
    });

    describe('loop guard', () => {
        // The core requirement: a broken deploy must not reload forever.
        it('does not reload a second time', () => {
            handleServerVersion('server', 'client', deps);
            expect(deps.reloads).toEqual(1);
            // The page reloaded; the marker survived; still mismatched.
            handleServerVersion('server', 'client', deps);
            expect(deps.reloads).toEqual(1);
        });

        it('shows a persistent hard-refresh message instead', () => {
            deps.alreadyReloaded = true;
            handleServerVersion('server', 'client', deps);
            const notice = deps.notices[deps.notices.length - 1];
            expect(notice.message).toEqual(BLOCKED_MESSAGE);
            expect(notice.persistent).toBeTrue();
        });

        it('mentions hard-refreshing in that message', () => {
            expect(BLOCKED_MESSAGE.toLowerCase()).toContain('hard-refresh');
        });

        it('warns when it declines to reload again', () => {
            deps.alreadyReloaded = true;
            handleServerVersion('server', 'client', deps);
            expect(deps.warnings.length).toBeGreaterThan(0);
        });

        it('stays blocked over many checks', () => {
            handleServerVersion('server', 'client', deps);
            for (let i = 0; i < 10; i++) {
                handleServerVersion('server', 'client', deps);
            }
            expect(deps.reloads).toEqual(1);
        });

        // The dev-mode case from the task: a hand-restarted server serving
        // a bundle built from a different tree. Reloading cannot fix it,
        // so it must settle rather than spin.
        it('settles when a restarted dev server serves a stale bundle',
            () => {
                handleServerVersion('devB', 'devA', deps);
                handleServerVersion('devB', 'devA', deps);
                handleServerVersion('devB', 'devA', deps);
                expect(deps.reloads).toEqual(1);
                expect(deps.notices[deps.notices.length - 1].persistent)
                    .toBeTrue();
            });

        // Once the deploy is fixed, a later mismatch gets a fresh reload.
        it('re-arms after a successful match', () => {
            handleServerVersion('v2', 'v1', deps);
            expect(deps.reloads).toEqual(1);
            // Reload lands on the good build.
            handleServerVersion('v2', 'v2', deps);
            // A later deploy arrives.
            handleServerVersion('v3', 'v2', deps);
            expect(deps.reloads).toEqual(2);
        });
    });

    describe('unknown versions', () => {
        // A failed /version fetch is far likelier to be a blip than a skew.
        it('does nothing when the server version is unavailable', () => {
            handleServerVersion(undefined, 'client', deps);
            expect(deps.reloads).toEqual(0);
            expect(deps.notices).toEqual([]);
        });

        it('does not clear the marker when unknown', () => {
            deps.alreadyReloaded = true;
            handleServerVersion(undefined, 'client', deps);
            expect(deps.alreadyReloaded).toBeTrue();
        });
    });

    // `location.reload()` does not stop execution, so both routes into the
    // check keep running after one of them asks to reload. A shared state
    // object is what keeps them from fighting.
    describe('shared state across both routes', () => {
        it('reloads once when both routes see the mismatch', () => {
            const state = makeVersionCheckState();
            applyVersionAction('reload', deps, state);
            applyVersionAction('reload', deps, state);
            expect(deps.reloads).toEqual(1);
        });

        // The bug this guards: route A reloads and persists the marker,
        // then route B reads that marker, concludes "already tried", and
        // replaces the correct banner with the terminal error -- on a
        // reload that is about to succeed.
        it('does not show the blocked message over an in-flight reload',
            () => {
                const state = makeVersionCheckState();
                applyVersionAction('reload', deps, state);
                // Route B resolves a moment later and, reading the marker
                // route A just set, decides `blocked`.
                applyVersionAction('blocked', deps, state);
                expect(deps.notices.length).toEqual(1);
                expect(deps.notices[0].message).toEqual(RELOADING_MESSAGE);
                expect(deps.notices.some(n => n.persistent)).toBeFalse();
            });

        it('does not warn about a failed reload over an in-flight one',
            () => {
                const state = makeVersionCheckState();
                applyVersionAction('reload', deps, state);
                applyVersionAction('blocked', deps, state);
                expect(deps.warnings).toEqual([]);
            });

        // Without a shared state the two routes are independent, which is
        // what the default argument means.
        it('still blocks when no reload happened on this page', () => {
            const state = makeVersionCheckState();
            applyVersionAction('blocked', deps, state);
            expect(deps.notices[0].message).toEqual(BLOCKED_MESSAGE);
        });

        it('does nothing at all for the unknown action', () => {
            applyVersionAction('unknown', deps);
            expect(deps.reloads).toEqual(0);
            expect(deps.notices).toEqual([]);
            expect(deps.warnings).toEqual([]);
        });

        it('reloads once when driven through handleServerVersion twice',
            () => {
                const state = makeVersionCheckState();
                handleServerVersion('s', 'c', deps, state);
                handleServerVersion('s', 'c', deps, state);
                expect(deps.reloads).toEqual(1);
            });
    });

    // installVersionCheck's own fetch is not injectable, but in node the
    // relative '/version' URL simply fails, which is the `unknown` path --
    // so these specs isolate the two callbacks it returns.
    describe('installVersionCheck callbacks', () => {
        it('reloads on a websocket refusal', () => {
            const { onVersionMismatch } = installVersionCheck('client', deps);
            onVersionMismatch('server build is newer');
            expect(deps.reloads).toEqual(1);
        });

        it('blocks instead when it already reloaded once', () => {
            deps.alreadyReloaded = true;
            const { onVersionMismatch } = installVersionCheck('client', deps);
            onVersionMismatch('server build is newer');
            expect(deps.reloads).toEqual(0);
            expect(deps.notices[deps.notices.length - 1].persistent)
                .toBeTrue();
        });

        it('reloads only once when refused twice', () => {
            const { onVersionMismatch } = installVersionCheck('client', deps);
            onVersionMismatch('a');
            onVersionMismatch('b');
            expect(deps.reloads).toEqual(1);
        });

        // Admission is positive proof the builds agree, and is the re-arm
        // signal that does not depend on the /version route.
        it('clears the marker when the server admits the client', () => {
            deps.alreadyReloaded = true;
            const { onAdmitted } = installVersionCheck('client', deps);
            onAdmitted();
            expect(deps.alreadyReloaded).toBeFalse();
        });

        // A reload is already in flight; the socket that briefly connects
        // belongs to the outgoing page and must not clear the marker the
        // reload depends on.
        it('does not clear the marker once a reload is in flight', () => {
            const { onVersionMismatch, onAdmitted } =
                installVersionCheck('client', deps);
            onVersionMismatch('stale');
            expect(deps.alreadyReloaded).toBeTrue();
            onAdmitted();
            expect(deps.alreadyReloaded).toBeTrue();
        });
    });

    describe('fetchServerVersion', () => {
        it('returns the trimmed body on success', async () => {
            const fake = (async () => new Response('  abc123\n',
                { status: 200 })) as unknown as typeof fetch;
            expect(await fetchServerVersion(fake)).toEqual('abc123');
        });

        it('returns undefined on a non-ok response', async () => {
            const fake = (async () => new Response('nope',
                { status: 500 })) as unknown as typeof fetch;
            expect(await fetchServerVersion(fake)).toBeUndefined();
        });

        it('returns undefined when the request throws', async () => {
            const fake = (async () => {
                throw new Error('network down');
            }) as unknown as typeof fetch;
            expect(await fetchServerVersion(fake)).toBeUndefined();
        });

        // An empty body is not a build stamp; treating it as one would
        // make every client mismatch against "".
        it('returns undefined for an empty body', async () => {
            const fake = (async () => new Response('   ',
                { status: 200 })) as unknown as typeof fetch;
            expect(await fetchServerVersion(fake)).toBeUndefined();
        });

        // A server predating this feature has no /version route, so the
        // request falls through to the `use("/")` catch-all and returns
        // index.html with a 200. Reading that as a stamp would mismatch
        // every client and park the page on the hard-refresh message.
        it('returns undefined for an html catch-all response', async () => {
            const html = '<!DOCTYPE HTML>\n<html><body>nova</body></html>';
            const fake = (async () => new Response(html, {
                status: 200,
                headers: { 'content-type': 'text/html; charset=utf-8' },
            })) as unknown as typeof fetch;
            expect(await fetchServerVersion(fake)).toBeUndefined();
        });

        it('returns undefined for html even without a content type',
            async () => {
                const html = '<!DOCTYPE HTML><html></html>';
                const fake = (async () => new Response(html,
                    { status: 200 })) as unknown as typeof fetch;
                expect(await fetchServerVersion(fake)).toBeUndefined();
            });

        it('returns undefined for an implausibly long body', async () => {
            const fake = (async () => new Response('a'.repeat(5000),
                { status: 200 })) as unknown as typeof fetch;
            expect(await fetchServerVersion(fake)).toBeUndefined();
        });

        it('accepts a realistic dirty-tree stamp', async () => {
            const stamp = 'f7397464-dirty-1786501588159';
            const fake = (async () => new Response(stamp, {
                status: 200,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
            })) as unknown as typeof fetch;
            expect(await fetchServerVersion(fake)).toEqual(stamp);
        });
    });
});
