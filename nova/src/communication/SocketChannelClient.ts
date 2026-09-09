import { isRight } from 'nova_ecs/either';
import { BehaviorSubject, Subject } from "rxjs";
import { ChannelClient } from "./Channel";
import { getPersistentPlayerToken } from "./player_identity";
import { SocketMessage } from "./SocketMessage";

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
    private readonly openListener = () => this.flushQueue();
    private readonly closeListener = () => this.connected.next(false);
    private messageQueue: SocketMessage[] = [];
    private maxPings: number
    readonly playerToken: string;

    constructor({ webSocket, warn, timeout, webSocketFactory, maxPings,
        playerToken }: {
        webSocket?: WebSocket,
        warn?: ((m: string) => void),
        timeout?: number,
        webSocketFactory?: () => WebSocket,
        maxPings?: number,
        playerToken?: string,
    }) {
        this.playerToken = playerToken ?? getPersistentPlayerToken();
        this.webSocketFactory = webSocketFactory ?? (() => {
            const token = encodeURIComponent(this.playerToken);
            if (location.protocol === "https:") {
                return new WebSocket(`wss://${location.host}?playerToken=${token}`);
            }
            return new WebSocket(`ws://${location.host}?playerToken=${token}`);
        });

        this.webSocket = webSocket ?? this.webSocketFactory();
        this.warn = warn ?? console.warn;
        // Generous defaults: connections tunneled through VPN relays can see
        // multi-second round trips; dropping too eagerly causes reconnect storms.
        this.timeout = timeout ?? 4000;
        this.maxPings = maxPings ?? 4;

        this.messageListener = this.handleMessage.bind(this)
        this.bindSocket();
        this.resetTimeout();
    }

    private bindSocket() {
        this.webSocket.addEventListener('message', this.messageListener);
        this.webSocket.addEventListener('open', this.openListener);
        this.webSocket.addEventListener('close', this.closeListener);
    }

    private unbindSocket() {
        this.webSocket.removeEventListener('message', this.messageListener);
        this.webSocket.removeEventListener('open', this.openListener);
        this.webSocket.removeEventListener('close', this.closeListener);
    }

    private flushQueue() {
        if (this.webSocket.readyState !== this.webSocket.OPEN) return;
        for (const message of this.messageQueue) {
            this.webSocket.send(JSON.stringify(SocketMessage.encode(message)));
        }
        this.messageQueue.length = 0;
    }

    reconnect() {
        this.unbindSocket();
        if (this.webSocket.readyState === this.webSocket.CONNECTING
            || this.webSocket.readyState === this.webSocket.OPEN) {
            this.disconnect();
        }
        this.webSocket = this.webSocketFactory();
        this.bindSocket();
        this.resetTimeout();
        this.sendPing();
    }

    reconnectIfClosed() {
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
        this.reconnectIfClosed();
        if (this.webSocket.readyState === this.webSocket.OPEN) {
            this.flushQueue();
            this.webSocket.send(JSON.stringify(SocketMessage.encode(message)));
        } else {
            this.messageQueue.push(message);
        }
    }

    private handleMessage(messageEvent: MessageEvent) {
        this.resetTimeout();
        this.pingsSentSinceMessage = 0;
        if (!this.connected.value) {
            this.warn("Connected");
            this.connected.next(true);
        }

        const data = messageEvent.data;
        let socketMessage: SocketMessage;
        let parsed: unknown;
        try {
            parsed = JSON.parse(data);
        } catch {
            this.warn('Failed to deserialize message from server: invalid JSON');
            return;
        }
        const maybeSocketMessage = SocketMessage.decode(parsed);
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
        this.unbindSocket();
        if (this.keepaliveTimeout !== undefined) {
            clearTimeout(this.keepaliveTimeout);
            this.keepaliveTimeout = undefined;
        }
        this.webSocket.close();
        this.connected.next(false);
    }
}
