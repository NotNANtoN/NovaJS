import { isRight } from "fp-ts/lib/Either.js";
import { BehaviorSubject, Subject } from "rxjs";
import { ChannelClient } from "./channel.js";
import { SocketMessage } from "./socket_message.js";
import {
    connectUrlWithVersion, VERSION_MISMATCH_CLOSE_CODE,
} from "../common/version_handshake.js";

export class SocketChannelClient implements ChannelClient {
    readonly message = new Subject<unknown>();
    readonly connected = new BehaviorSubject(false);

    webSocket: WebSocket;
    private webSocketFactory: () => WebSocket;
    warn: (m: string) => void;
    readonly timeout: number;
    private keepaliveTimeout?: NodeJS.Timeout;
    private pingsSentSinceMessage = 0;
    private messageListener: (m: MessageEvent) => void;
    private closeListener?: (e: CloseEvent) => void;
    private messageQueue: SocketMessage[] = [];
    private maxPings: number

    /**
     * Set once the server has refused this client for a build mismatch.
     *
     * Latches the reconnect machinery OFF. Without it the keepalive would
     * treat the refusal as an ordinary dropped connection and reconnect
     * every timeout, hammering a server that will refuse it every time --
     * and the page is on its way to reloading anyway. Only a reload (a
     * fresh bundle, hence a fresh client) clears this.
     */
    private versionRefused = false;

    constructor({ webSocket, warn, timeout, webSocketFactory, maxPings,
        buildVersion, onVersionMismatch }: {
            webSocket?: WebSocket,
            warn?: ((m: string) => void),
            timeout?: number,
            webSocketFactory?: () => WebSocket,
            maxPings?: number,
            /**
             * This bundle's build stamp, announced on the connect URL so
             * the server can refuse a stale client before admitting it.
             * When omitted no stamp is sent, which a version-checking
             * server treats as a mismatch.
             */
            buildVersion?: string,
            /**
             * Called when the server closes the socket with the
             * version-mismatch code. Opt-in: the close listener is only
             * registered when this is supplied, so a plain client keeps
             * exactly the listeners it always had.
             */
            onVersionMismatch?: (reason: string) => void,
        }) {
        this.webSocketFactory = webSocketFactory ?? (() => {
            const protocol = location.protocol === "https:" ? "wss" : "ws";
            const origin = `${protocol}://${location.host}`;
            if (buildVersion === undefined) {
                return new WebSocket(origin);
            }
            return new WebSocket(connectUrlWithVersion(origin, buildVersion));
        });

        this.webSocket = webSocket ?? this.webSocketFactory();
        this.warn = warn ?? console.warn;
        this.timeout = timeout ?? 1200;
        this.maxPings = maxPings ?? 3;

        if (onVersionMismatch) {
            this.closeListener = (event: CloseEvent) => {
                if (event.code !== VERSION_MISMATCH_CLOSE_CODE) {
                    return;
                }
                this.versionRefused = true;
                if (this.keepaliveTimeout !== undefined) {
                    clearTimeout(this.keepaliveTimeout);
                    this.keepaliveTimeout = undefined;
                }
                onVersionMismatch(event.reason);
            };
        }

        this.messageListener = this.handleMessage.bind(this)
        this.webSocket.addEventListener("message", this.messageListener);
        this.addCloseListener();
        this.resetTimeout();
    }

    private addCloseListener() {
        if (this.closeListener) {
            this.webSocket.addEventListener("close", this.closeListener);
        }
    }

    reconnect() {
        // A build-mismatched client stays down; see `versionRefused`.
        if (this.versionRefused) {
            return;
        }
        this.webSocket.removeEventListener("message", this.messageListener);
        // NOTE: the close listener is deliberately NOT removed from the
        // outgoing socket. A browser sets readyState to CLOSING/CLOSED
        // synchronously when a close frame arrives but dispatches the
        // `close` event as a queued task, so a keepalive firing inside
        // that window sees a dead socket and reconnects while a version
        // refusal is still pending delivery. Detaching here would drop
        // that event on the floor, the latch would never engage, and the
        // client would reconnect-loop forever against a server that
        // refuses it every time -- silently, with no reload. Leaving it
        // attached costs nothing (the discarded socket is collected along
        // with its listener) and lets a late 4001 still latch.
        if (this.webSocket.readyState === this.webSocket.CONNECTING
            || this.webSocket.readyState === this.webSocket.OPEN) {
            this.disconnect();
        }
        this.webSocket = this.webSocketFactory();
        this.webSocket.addEventListener("message", this.messageListener);
        this.addCloseListener();
        this.resetTimeout();
        this.sendPing();
    }

    reconnectIfClosed() {
        if (this.versionRefused) {
            return;
        }
        if (this.webSocket.readyState === this.webSocket.CLOSED
            || this.webSocket.readyState === this.webSocket.CLOSING) {
            this.reconnect();
        }
    }

    send(message: unknown): void {
        this.sendRaw({ message });
    }

    private sendPing() {
        this.sendRaw({ ping: true });
        this.pingsSentSinceMessage++;
    }

    private keepaliveTimeoutCallback = () => {
        // A refused client must not re-arm the keepalive: doing so would
        // ping and re-time-out forever behind the reload.
        if (this.versionRefused) {
            return;
        }
        if (this.webSocket.readyState === this.webSocket.CLOSED
            || this.webSocket.readyState === this.webSocket.CLOSING
            || this.pingsSentSinceMessage > this.maxPings) {
            this.disconnect();
            this.warn("Lost connection. Reconnecting...");
            this.reconnect();
        }

        this.sendPing();
        this.resetTimeout();
    }

    resetTimeout() {
        if (this.keepaliveTimeout !== undefined) {
            clearTimeout(this.keepaliveTimeout);
        }
        this.keepaliveTimeout = setTimeout(
            this.keepaliveTimeoutCallback, this.timeout);
    }

    private sendRaw(message: SocketMessage) {
        // A refused client has no socket to flush to and will never get
        // one, so queueing would grow without bound behind the reload (or
        // behind the persistent error, if the loop guard stopped us).
        // Drop instead: nothing this client sends can be delivered.
        if (this.versionRefused) {
            this.messageQueue.length = 0;
            return;
        }
        this.reconnectIfClosed();
        if (this.webSocket.readyState === this.webSocket.OPEN) {
            for (const message of this.messageQueue) {
                this.webSocket.send(JSON.stringify(SocketMessage.encode(message)));
            }
            this.messageQueue.length = 0;
            this.webSocket.send(JSON.stringify(SocketMessage.encode(message)));
        } else {
            this.messageQueue.push(message);
        }
    }

    private async handleMessage(messageEvent: MessageEvent) {
        this.resetTimeout();
        this.pingsSentSinceMessage = 0;
        if (!this.connected.value) {
            this.warn("Connected");
            this.connected.next(true);
        }

        const data = messageEvent.data;
        let socketMessage: SocketMessage;
        const maybeSocketMessage = SocketMessage.decode(JSON.parse(data) as unknown);
        if (isRight(maybeSocketMessage)) {
            socketMessage = maybeSocketMessage.right;
        } else {
            this.warn(`Failed to deserialize message from server. `
                + `Errors: ${maybeSocketMessage.left}`);
            return;
        }

        if (socketMessage.pong) {
            // We already reset the timeout above.
            // No need to do anything if it's a pong.
            return;
        }

        if (socketMessage.ping) {
            // Reply with pong
            this.sendRaw({ pong: true });
            return;
        }

        const message = socketMessage.message;
        if (message) {
            this.message.next(message);
            return;
        }

        this.warn('Message had no body and was not a ping.');
    }

    disconnect() {
        this.webSocket.removeEventListener(
            "message", this.messageListener);
        this.webSocket.close();
        this.connected.next(false);
    }
}
