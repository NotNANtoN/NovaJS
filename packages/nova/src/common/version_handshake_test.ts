import {
    connectUrlWithVersion, decideClientAction, sanitizeReportedVersion,
    shouldAdmitClient, truncateCloseReason, VERSION_MISMATCH_CLOSE_CODE,
    VERSION_PATH, VERSION_QUERY_PARAM, versionFromConnectUrl,
} from './version_handshake.js';

describe('version handshake', () => {
    describe('shouldAdmitClient', () => {
        it('admits a client built from the same stamp', () => {
            expect(shouldAdmitClient('abc123', 'abc123'))
                .toEqual({ admit: true });
        });

        it('refuses a client built from a different stamp', () => {
            const decision = shouldAdmitClient('abc123', 'def456');
            expect(decision.admit).toBeFalse();
        });

        it('names both builds in the refusal reason', () => {
            const decision = shouldAdmitClient('abc123', 'def456');
            if (decision.admit) {
                throw new Error('Expected a refusal');
            }
            expect(decision.reason).toContain('abc123');
            expect(decision.reason).toContain('def456');
        });

        // Fails closed: a bundle predating the handshake announces nothing,
        // and is by definition not the current build.
        it('refuses a client that announces no version', () => {
            expect(shouldAdmitClient('abc123', undefined).admit).toBeFalse();
            expect(shouldAdmitClient('abc123', null).admit).toBeFalse();
            expect(shouldAdmitClient('abc123', '').admit).toBeFalse();
        });

        it('compares stamps exactly, without normalizing', () => {
            expect(shouldAdmitClient('abc123', 'ABC123').admit).toBeFalse();
            expect(shouldAdmitClient('abc123', ' abc123').admit).toBeFalse();
            expect(shouldAdmitClient('abc123', 'abc1234').admit).toBeFalse();
        });

        // A dev build stamps `<sha>-dirty-<epochMs>`; two dev builds of the
        // same commit are different builds and must not mix.
        it('refuses two dirty builds of the same commit', () => {
            expect(shouldAdmitClient(
                'abc123-dirty-1000', 'abc123-dirty-2000').admit).toBeFalse();
        });
    });

    describe('decideClientAction', () => {
        it('reports ok when the builds match', () => {
            expect(decideClientAction('abc123', 'abc123', false)).toEqual('ok');
        });

        // Clearing the loop-guard marker is the caller's job, but a match
        // must report `ok` even when the marker is still set -- that is the
        // successful-reload case, and it is what resets the guard.
        it('reports ok on a match even after an automatic reload', () => {
            expect(decideClientAction('abc123', 'abc123', true)).toEqual('ok');
        });

        it('reloads once when the builds differ', () => {
            expect(decideClientAction('server1', 'client2', false))
                .toEqual('reload');
        });

        it('blocks instead of reloading again when it already reloaded', () => {
            expect(decideClientAction('server1', 'client2', true))
                .toEqual('blocked');
        });

        // Fails open: a failed /version fetch is far likelier to be a
        // network blip than a real skew, and reloading would spin the page.
        it('does nothing when the server version is unknown', () => {
            expect(decideClientAction(undefined, 'abc123', false))
                .toEqual('unknown');
            expect(decideClientAction(null, 'abc123', false))
                .toEqual('unknown');
            expect(decideClientAction('', 'abc123', false))
                .toEqual('unknown');
        });

        it('does nothing when the client version is unknown', () => {
            expect(decideClientAction('abc123', undefined, false))
                .toEqual('unknown');
            expect(decideClientAction('abc123', '', false))
                .toEqual('unknown');
        });

        it('stays unknown rather than blocking when both are unknown', () => {
            expect(decideClientAction(undefined, undefined, true))
                .toEqual('unknown');
        });

        // The loop guard is the whole point: a broken deploy must settle on
        // `blocked` and stay there rather than reloading forever.
        it('never returns reload twice for the same skew', () => {
            const first = decideClientAction('server1', 'client2', false);
            expect(first).toEqual('reload');
            // The client persists the marker, reloads, and asks again.
            const second = decideClientAction('server1', 'client2', true);
            expect(second).toEqual('blocked');
            // And it stays blocked no matter how many times it is asked.
            expect(decideClientAction('server1', 'client2', true))
                .toEqual('blocked');
        });
    });

    describe('connect url', () => {
        it('round-trips a stamp through the connect url', () => {
            const url = connectUrlWithVersion('ws://host:8000', 'abc123');
            expect(versionFromConnectUrl(new URL(url).pathname
                + new URL(url).search)).toEqual('abc123');
        });

        it('round-trips a stamp containing url-significant characters', () => {
            const awkward = 'abc+123/4 5&6=7';
            const url = connectUrlWithVersion('ws://host', awkward);
            const parsed = new URL(url);
            expect(versionFromConnectUrl(parsed.pathname + parsed.search))
                .toEqual(awkward);
        });

        it('reads the stamp from a raw request target', () => {
            expect(versionFromConnectUrl('/?v=abc123')).toEqual('abc123');
        });

        it('reads the stamp alongside other parameters', () => {
            expect(versionFromConnectUrl('/?foo=bar&v=abc123&baz=qux'))
                .toEqual('abc123');
        });

        // Each of these is a refusal, per shouldAdmitClient.
        it('returns undefined when there is no stamp', () => {
            expect(versionFromConnectUrl('/')).toBeUndefined();
            expect(versionFromConnectUrl('/?other=1')).toBeUndefined();
            expect(versionFromConnectUrl(undefined)).toBeUndefined();
            expect(versionFromConnectUrl('')).toBeUndefined();
        });

        it('returns empty string for an empty stamp parameter', () => {
            // Distinct from "absent", but shouldAdmitClient refuses both.
            expect(versionFromConnectUrl('/?v=')).toEqual('');
            expect(shouldAdmitClient('x', versionFromConnectUrl('/?v='))
                .admit).toBeFalse();
        });
    });

    describe('truncateCloseReason', () => {
        // The websocket protocol caps the reason at 123 bytes, and `ws`
        // throws past it -- which would crash the server on the very path
        // that handles bad clients.
        it('leaves a short reason alone', () => {
            expect(truncateCloseReason('short')).toEqual('short');
        });

        it('caps a long reason at 123 bytes', () => {
            const long = 'a'.repeat(500);
            const encoded = new TextEncoder()
                .encode(truncateCloseReason(long));
            expect(encoded.length).toBeLessThanOrEqual(123);
        });

        it('does not split a multi-byte character', () => {
            // 'é' is 2 bytes, so a 123-byte cut lands mid-character.
            const long = 'é'.repeat(200);
            const truncated = truncateCloseReason(long);
            expect(truncated).not.toContain('�');
            expect(new TextEncoder().encode(truncated).length)
                .toBeLessThanOrEqual(123);
        });

        it('keeps a real refusal reason within the cap', () => {
            const decision = shouldAdmitClient(
                'server-' + 'x'.repeat(200), 'client-' + 'y'.repeat(200));
            if (decision.admit) {
                throw new Error('Expected a refusal');
            }
            expect(new TextEncoder()
                .encode(truncateCloseReason(decision.reason)).length)
                .toBeLessThanOrEqual(123);
        });
    });

    describe('sanitizeReportedVersion', () => {
        // The announced version is unauthenticated query-string input and
        // ends up in a server log line, so it must not be able to forge
        // log entries or write unbounded text.
        it('leaves an ordinary stamp alone', () => {
            expect(sanitizeReportedVersion('f7397464-dirty-1786501588159'))
                .toEqual('f7397464-dirty-1786501588159');
        });

        it('strips newlines that could forge a log line', () => {
            const forged = 'abc\n2026-01-01 FATAL everything is fine';
            expect(sanitizeReportedVersion(forged)).not.toContain('\n');
        });

        it('strips carriage returns and NULs', () => {
            expect(sanitizeReportedVersion('a\r\0b')).toEqual('ab');
        });

        it('bounds an enormous announced version', () => {
            expect(sanitizeReportedVersion('a'.repeat(100000)).length)
                .toBeLessThan(100);
        });

        // The comparison must use the raw value; only the echoed copy is
        // sanitized, or two versions differing solely in stripped
        // characters would be treated as equal.
        it('does not let sanitizing make two builds compare equal', () => {
            expect(shouldAdmitClient('abc', 'a\nbc').admit).toBeFalse();
        });

        it('keeps a refusal reason bounded for a huge announced version',
            () => {
                const decision = shouldAdmitClient('server', 'x'.repeat(50000));
                if (decision.admit) {
                    throw new Error('Expected a refusal');
                }
                expect(decision.reason.length).toBeLessThan(200);
            });
    });

    describe('wire constants', () => {
        // The close code must sit in the application-reserved range so no
        // proxy or browser assigns it a meaning of its own.
        it('uses an application-reserved websocket close code', () => {
            expect(VERSION_MISMATCH_CLOSE_CODE).toBeGreaterThanOrEqual(4000);
            expect(VERSION_MISMATCH_CLOSE_CODE).toBeLessThanOrEqual(4999);
        });

        it('serves the version at a rooted path', () => {
            expect(VERSION_PATH.startsWith('/')).toBeTrue();
        });

        it('has a non-empty query parameter name', () => {
            expect(VERSION_QUERY_PARAM.length).toBeGreaterThan(0);
        });
    });
});
