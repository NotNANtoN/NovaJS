import { isLeft } from 'nova_ecs/either';
import https from "https";
import http from "http";
import { BehaviorSubject, Subject } from "rxjs";
import { v4 } from "uuid";
import WebSocket, { WebSocketServer } from "ws";
import { ChannelServer, MessageWithSourceType } from "./Channel";
import { SocketMessage } from "./SocketMessage";

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

interface Client {
    socket: WebSocket;
    playerToken?: string;
    keepaliveTimeout?: NodeJS.Timeout;
}

export class SocketChannelServer implements ChannelServer {
    readonly message = new Subject<MessageWithSourceType<unknown>>();
    readonly clientConnect = new Subject<string>();
    readonly clientDisconnect = new Subject<string>();
    readonly connected = new BehaviorSubject(true); // Server is always connected

    private clientMap = new Map<string, Client>();
    readonly wss: WebSocketServer;
    private warn: (m: string) => void = console.warn;

    // Send a ping if a packet hasn't been received in this long
    // If the ping doesn't get back in this much time, disconnect them.
    readonly timeout: number;

    constructor({ server, warn, wss, timeout }: {
        server?: http.Server | https.Server,
        warn?: ((m: string) => void),
        wss?: WebSocketServer, timeout?: number
    }) {

        if (warn) {
            this.warn = warn;
        }

        if (wss) {
            this.wss = wss;
        }
        else if (server) {
            this.wss = new WebSocketServer({
                server: server,
                // Game packets are a few KB; the ws default is 100 MiB.
                maxPayload: MAX_PAYLOAD_BYTES,
            });
        }
        else {
            throw new Error("httpsServer or wss must be defined");
        }

        if (timeout) {
            this.timeout = timeout;
        } else {
            this.timeout = 30000;
        }

        this.wss.on("connection", this.onConnect.bind(this));
    }

    get clients() {
        return new Set(this.clientMap.keys());
    }

    private sendRawIfOpen(destination: string,
        socketMessage: SocketMessage): boolean {

        const client = this.clientMap.get(destination);
        if (!client) {
            this.warn(`No such client ${destination}`);
        } else if (client.socket.readyState === WebSocket.OPEN) {
            client.socket.send(JSON.stringify(SocketMessage.encode(socketMessage)));
            return true;
        }
        return false;
    }

    send(destination: string, message: unknown) {
        return this.sendRawIfOpen(destination, { message });
    }

    private resetClientTimeout(uuid: string) {
        const client = this.clientMap.get(uuid);
        if (!client) {
            throw new Error(`Tried to reset keepalive timeout`
                + ` of nonexistant client ${uuid}`);
        }

        if (client.keepaliveTimeout) {
            clearTimeout(client.keepaliveTimeout);
        }

        client.keepaliveTimeout = setTimeout(() => {
            // Send the client a ping
            this.sendRawIfOpen(uuid, { ping: true });
            client.keepaliveTimeout = setTimeout(() => {
                // Remove the client if it hasn't responded. Terminate the
                // socket too; otherwise a half-open TCP connection leaks.
                try {
                    client.socket.terminate();
                } catch {}
                this.handleClientClose(uuid);
            }, this.timeout);
        }, this.timeout);
    }

    getPlayerToken(clientId: string) {
        return this.clientMap.get(clientId)?.playerToken;
    }

    /** Handles when a client first connects */
    private onConnect(webSocket: WebSocket, request?: http.IncomingMessage) {
        const clientUUID = v4();
        // This uuid is used only for communication and
        // has nothing to do with the game engine's uuids
        // Disable Nagle's algorithm for immediate dispatch of low-latency game deltas
        const tcpSocket = (webSocket as unknown as { _socket?: { setNoDelay?: (noDelay: boolean) => void } })._socket;
        if (tcpSocket && typeof tcpSocket.setNoDelay === 'function') {
            tcpSocket.setNoDelay(true);
        }

        const client: Client = {
            socket: webSocket,
            playerToken: this.getTokenFromRequest(request),
        };
        this.clientMap.set(clientUUID, client);
        this.resetClientTimeout(clientUUID);

        if (webSocket.readyState === WebSocket.CONNECTING) {
            webSocket.on("open", () => {
                this.clientConnect.next(clientUUID);
            });
        } else if (webSocket.readyState === WebSocket.OPEN) {
            this.clientConnect.next(clientUUID);
        } else {
            const state = webSocket.readyState === WebSocket.CLOSING
                ? "CLOSING" : "CLOSED";
            throw new Error(`Expected socket to be in CONNECTING or CONNECTED state but it was ${state}`);
        }

        webSocket.on("message", this.handleMessageFromClient.bind(this, clientUUID));
        webSocket.on("close", this.handleClientClose.bind(this, clientUUID));
    }

    private getTokenFromRequest(request?: http.IncomingMessage) {
        if (!request?.url) {
            return undefined;
        }
        const host = request.headers.host ?? 'localhost';
        const url = new URL(request.url, `http://${host}`);
        return url.searchParams.get('playerToken') ?? undefined;
    }

    // Handles messages received from clients. Forwards messages to their destination.
    private handleMessageFromClient(clientUUID: string, serialized: string) {
        this.resetClientTimeout(clientUUID);
        const client = this.clientMap.get(clientUUID);
        if (!client) {
            throw new Error(`Missing client object for ${clientUUID}`);
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(String(serialized));
        } catch {
            this.warn(`Received invalid JSON from client ${clientUUID}`);
            return;
        }
        const maybeSocketMessage = SocketMessage.decode(parsed);

        if (isLeft(maybeSocketMessage)) {
            console.warn(`Received bad message from client ${clientUUID}: ${maybeSocketMessage.left}`);
            return;
        }

        const socketMessage = maybeSocketMessage.right;
        if (socketMessage.pong) {
            // We already reset the client timeout above.
            // No need to do anything if it's a pong.
            return;
        }

        if (socketMessage.ping) {
            this.sendRawIfOpen(clientUUID, { pong: true });
            return;
        }

        if (!socketMessage.message) {
            this.warn(`Message from ${clientUUID} had no data`);
            return;
        }

        this.message.next({
            message: socketMessage.message,
            source: clientUUID,
        });
    }

    private handleClientClose(clientUUID: string) {
        const client = this.clientMap.get(clientUUID);
        if (!client) {
            // The keepalive timeout and the socket close event can both
            // arrive for the same client.
            return;
        }

        if (client.keepaliveTimeout !== undefined) {
            clearTimeout(client.keepaliveTimeout);
        }

        client.socket.removeAllListeners();
        this.clientMap.delete(clientUUID);
        this.clientDisconnect.next(clientUUID);
    }
}
