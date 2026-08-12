import 'jasmine';
import { VERSION_MISMATCH_CLOSE_CODE } from '../common/version_handshake.js';
import { SocketChannelClient } from './socket_channel_client.js';
import { Callbacks, On, trackOn } from './test_utils.js';

/**
 * The client's reaction to being refused for a build mismatch.
 *
 * The point of these specs is the LATCH: once refused, the client must go
 * quiet. Without it the keepalive treats the refusal as an ordinary
 * dropped connection and reconnects every timeout, hammering a server
 * that will refuse it every time -- while the page is already reloading.
 */
describe('SocketChannelClient version refusal', () => {
    let webSocket: jasmine.SpyObj<WebSocket>;
    let warn: jasmine.Spy<(m: string) => void>;
    let callbacks: Callbacks;
    let clock: jasmine.Clock;
    let socketsCreated: number;

    function makeSocketSpy(): jasmine.SpyObj<WebSocket> {
        return jasmine.createSpyObj<WebSocket>("webSocketSpy",
            ["addEventListener", "send", "close", "removeEventListener"], {
            CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3,
            readyState: 1, // OPEN
        });
    }

    beforeEach(() => {
        clock = jasmine.clock();
        clock.install();
        socketsCreated = 0;
        webSocket = makeSocketSpy();
        warn = jasmine.createSpy<(m: string) => void>("mockWarn");
        let on: On;
        [callbacks, on] = trackOn();
        webSocket.addEventListener.and.callFake(on);
    });
    afterEach(() => { clock.uninstall(); });

    function makeClient(onVersionMismatch?: (reason: string) => void) {
        return new SocketChannelClient({
            webSocket, warn, onVersionMismatch,
            webSocketFactory: () => {
                socketsCreated++;
                return makeSocketSpy();
            },
        });
    }

    /** Delivers a close event to the client's close listener. */
    function closeWith(code: number, reason = '') {
        const closeListeners = callbacks["close"] ?? [];
        for (const listener of closeListeners) {
            listener({ code, reason } as CloseEvent);
        }
        return closeListeners.length;
    }

    it('registers a close listener when a handler is supplied', () => {
        makeClient(() => { });
        expect(callbacks["close"]?.length).toEqual(1);
    });

    // Opt-in, so a plain client keeps exactly the listeners it always had
    // (an existing spec asserts addEventListener is called exactly once).
    it('registers no close listener without a handler', () => {
        makeClient();
        expect(callbacks["close"]).toBeUndefined();
        expect(webSocket.addEventListener).toHaveBeenCalledTimes(1);
    });

    it('invokes the handler on the version-mismatch close code', () => {
        const handler = jasmine.createSpy<(r: string) => void>('handler');
        makeClient(handler);
        closeWith(VERSION_MISMATCH_CLOSE_CODE, 'stale build');
        expect(handler).toHaveBeenCalledOnceWith('stale build');
    });

    it('ignores an ordinary close', () => {
        const handler = jasmine.createSpy<(r: string) => void>('handler');
        makeClient(handler);
        closeWith(1006);
        expect(handler).not.toHaveBeenCalled();
    });

    // The latch: an ordinary drop reconnects, a refusal must not.
    it('does not reconnect after a refusal', () => {
        makeClient(() => { });
        closeWith(VERSION_MISMATCH_CLOSE_CODE);
        (webSocket as any).readyState = webSocket.CLOSED;
        clock.tick(60000);
        expect(socketsCreated).toEqual(0);
    });

    it('stops sending pings after a refusal', () => {
        makeClient(() => { });
        const sendsBefore = webSocket.send.calls.count();
        closeWith(VERSION_MISMATCH_CLOSE_CODE);
        clock.tick(60000);
        expect(webSocket.send.calls.count()).toEqual(sendsBefore);
    });

    it('reconnects normally when it was never refused', () => {
        makeClient(() => { });
        (webSocket as any).readyState = webSocket.CLOSED;
        clock.tick(60000);
        expect(socketsCreated).toBeGreaterThan(0);
    });

    // Nothing a refused client sends can be delivered, so queueing it
    // would grow without bound behind the reload.
    it('drops outgoing messages instead of queueing them', () => {
        const client = makeClient(() => { });
        closeWith(VERSION_MISMATCH_CLOSE_CODE);
        (webSocket as any).readyState = webSocket.CLOSED;
        for (let i = 0; i < 1000; i++) {
            client.send({ some: 'message' });
        }
        expect((client as any).messageQueue.length).toEqual(0);
    });

    it('sends nothing on the refused socket', () => {
        const client = makeClient(() => { });
        closeWith(VERSION_MISMATCH_CLOSE_CODE);
        const sendsBefore = webSocket.send.calls.count();
        client.send({ some: 'message' });
        expect(webSocket.send.calls.count()).toEqual(sendsBefore);
    });
});
