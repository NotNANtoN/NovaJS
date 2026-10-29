import { isRight } from 'nova_ecs/either';
import { BehaviorSubject, Subject } from "rxjs";
import {
    decodeFastBinaryPacket,
    isBinaryPacket,
    isUnreliableDatagramCandidate,
    tryEncodeFastBinaryPacket,
} from "./binary_packet";
import { ChannelClient } from "./Channel";
import { UnreliableDatagramClient } from "./datagram_channel";
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
    private reconnectTimeout?: NodeJS.Timeout;
    private retryCount = 0;
    private isExplicitlyDisconnected = false;
    private readonly initialRetryDelay = 500;
    private readonly maxRetryDelay = 5000;
    private pingsSentSinceMessage = 0;
    private messageListener: (m: MessageEvent) => void;
    private readonly openListener = () => {
        this.retryCount = 0;
        if (this.reconnectTimeout !== undefined) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }
        this.flushQueue();
    };
    private readonly closeListener = () => {
        this.handleSocketLost();
    };
    private readonly errorListener = () => {
        this.handleSocketLost();
    };
    /**
     * Outbound messages waiting for a socket. Game traffic is a stream of
     * 60 Hz deltas; replaying a stale backlog into a new session would apply
     * old movement and fire intent after the server has already resynced.
     */
    private messageQueue: { message: SocketMessage, queuedAt: number }[] = [];
    private readonly maxQueuedMessageAgeMs = 1000;
    private maxPings: number
    readonly playerToken: string;
    private datagram?: UnreliableDatagramClient;

    constructor({ webSocket, warn, timeout, webSocketFactory, maxPings,
        playerToken, datagram }: {
        webSocket?: WebSocket,
        warn?: ((m: string) => void),
        timeout?: number,
        webSocketFactory?: () => WebSocket,
        maxPings?: number,
        playerToken?: string,
        datagram?: UnreliableDatagramClient,
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
        if (datagram) {
            this.setDatagramChannel(datagram);
        }
        this.bindSocket();
        this.resetTimeout();
    }

    setDatagramChannel(datagram: UnreliableDatagramClient | undefined) {
        if (this.datagram && this.datagram !== datagram) {
            this.datagram.onDatagram = undefined;
        }
        this.datagram = datagram;
        if (this.datagram) {
            this.datagram.onDatagram = (payload) => {
                this.handleMessage({ data: payload } as MessageEvent);
            };
        }
    }

    private bindSocket() {
        try {
            this.webSocket.binaryType = 'arraybuffer';
        } catch {}
        this.webSocket.addEventListener('message', this.messageListener);
        this.webSocket.addEventListener('open', this.openListener);
        this.webSocket.addEventListener('close', this.closeListener);
        this.webSocket.addEventListener('error', this.errorListener);
    }

    private unbindSocket() {
        this.webSocket.removeEventListener('message', this.messageListener);
        this.webSocket.removeEventListener('open', this.openListener);
        this.webSocket.removeEventListener('close', this.closeListener);
        this.webSocket.removeEventListener('error', this.errorListener);
    }

    private sendWireMessage(message: SocketMessage) {
        const encoded = SocketMessage.encode(message);
        const binary = tryEncodeFastBinaryPacket(encoded);
        if (binary && this.datagram?.isOpen && isUnreliableDatagramCandidate(encoded)) {
            if (this.datagram.send(binary)) {
                return;
            }
        }
        this.webSocket.send(binary ?? JSON.stringify(encoded));
    }

    private flushQueue() {
        if (this.webSocket.readyState !== this.webSocket.OPEN) return;
        const now = Date.now();
        for (const { message, queuedAt } of this.messageQueue) {
            if (now - queuedAt > this.maxQueuedMessageAgeMs) continue;
            this.sendWireMessage(message);
        }
        this.messageQueue.length = 0;
    }

    private handleSocketLost() {
        // Anything queued for the lost session is obsolete. The multiplayer
        // layer requests a fresh full state after reconnecting.
        this.messageQueue.length = 0;
        this.connected.next(false);
        this.scheduleReconnect();
    }

    scheduleReconnect(immediate = false) {
        if (this.isExplicitlyDisconnected) return;
        if (this.reconnectTimeout !== undefined) return;
        if (this.webSocket.readyState === this.webSocket.CONNECTING
            || this.webSocket.readyState === this.webSocket.OPEN) {
            return;
        }

        if (immediate) {
            this.reconnect();
            return;
        }

        const baseDelay = Math.min(
            this.maxRetryDelay,
            this.initialRetryDelay * Math.pow(1.5, this.retryCount),
        );
        const jitter = (Math.random() * 0.3 - 0.15) * baseDelay;
        const delay = Math.max(100, Math.round(baseDelay + jitter));
        this.retryCount++;

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = undefined;
            if (this.isExplicitlyDisconnected) return;
            this.reconnect();
        }, delay);
    }

    reconnect() {
        if (this.isExplicitlyDisconnected) return;
        if (this.reconnectTimeout !== undefined) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }
        this.unbindSocket();
        if (this.webSocket.readyState === this.webSocket.CONNECTING
            || this.webSocket.readyState === this.webSocket.OPEN) {
            try {
                this.webSocket.close();
            } catch {}
        }
        try {
            this.webSocket = this.webSocketFactory();
            this.bindSocket();
            this.resetTimeout();
            this.sendPing();
        } catch (error) {
            this.warn(`WebSocket instantiation failed: ${error}`);
            this.scheduleReconnect();
        }
    }

    reconnectIfClosed() {
        if (this.isExplicitlyDisconnected) return;
        if (this.webSocket.readyState === this.webSocket.CLOSED
            || this.webSocket.readyState === this.webSocket.CLOSING) {
            this.scheduleReconnect();
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
            this.warn("Lost connection. Reconnecting...");
            this.reconnect();
            return;
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
            this.sendWireMessage(message);
        } else {
            if (this.messageQueue.length >= 300) {
                this.messageQueue.shift();
            }
            this.messageQueue.push({ message, queuedAt: Date.now() });
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
        if (isBinaryPacket(data)) {
            const decodedBinary = decodeFastBinaryPacket(data);
            if (!decodedBinary) {
                this.warn('Failed to deserialize binary message from server');
                return;
            }
            socketMessage = decodedBinary;
        } else {
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
        this.isExplicitlyDisconnected = true;
        this.unbindSocket();
        if (this.keepaliveTimeout !== undefined) {
            clearTimeout(this.keepaliveTimeout);
            this.keepaliveTimeout = undefined;
        }
        if (this.reconnectTimeout !== undefined) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }
        try {
            this.datagram?.close();
        } catch {}
        try {
            this.webSocket.close();
        } catch {}
        this.connected.next(false);
    }
}
