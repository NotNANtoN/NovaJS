import { isLeft } from "fp-ts/lib/Either.js";
import https from "https";
import http from "http";
import { BehaviorSubject, Subject } from "rxjs";
import { v4 } from "uuid";
import { WebSocketServer, WebSocket as NodeWebSocket } from "ws";
import { ChannelServer, MessageWithSourceType } from "./channel.js";
import { SocketMessage } from "./socket_message.js";
import {
    shouldAdmitClient, truncateCloseReason, VERSION_MISMATCH_CLOSE_CODE,
    versionFromConnectUrl,
} from "../common/version_handshake.js";

interface Client {
    socket: NodeWebSocket;
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

    /**
     * This server's build stamp. When set, a connecting client must
     * announce the same stamp or it is refused before it is admitted.
     *
     * Optional because the socket layer is also used by tests and tools
     * that have no build identity; when it is undefined the check is
     * skipped entirely. Production always sets it (`server.ts`).
     */
    private readonly buildVersion?: string;

    constructor({ server, warn, wss, timeout, buildVersion }: {
        server?: http.Server | https.Server,
        warn?: ((m: string) => void),
        wss?: WebSocketServer, timeout?: number,
        buildVersion?: string,
    }) {

        if (warn) {
            this.warn = warn;
        }

        this.buildVersion = buildVersion;

        if (wss) {
            this.wss = wss;
        }
        else if (server) {
            this.wss = new WebSocketServer({ server: server });
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
                // Remove the client if it hasn't responded
                this.handleClientClose(uuid);
            }, this.timeout);
        }, this.timeout);
    }

    /**
     * Handles when a client first connects.
     *
     * `request` is the HTTP upgrade request `ws` hands to the `connection`
     * listener; the client's build stamp rides on its query string.
     */
    private onConnect(webSocket: NodeWebSocket,
        request?: http.IncomingMessage) {

        // THE VERSION GATE. Everything below this block admits the client:
        // it lands in `clientMap` and `clientConnect` fires, which is what
        // lets it join a room. A build-mismatched client must never get
        // that far -- once it is in a room with updated peers it steps a
        // different simulation and fails the desync hash, and the rollback
        // relay can then only report the damage after the fact. So the
        // refusal happens here, before any client state exists.
        if (this.buildVersion !== undefined) {
            const clientVersion = versionFromConnectUrl(request?.url);
            const decision = shouldAdmitClient(this.buildVersion, clientVersion);
            if (!decision.admit) {
                this.warn(`Refusing websocket connection: ${decision.reason}`);
                // The client reads this code and reloads itself to pick up
                // the current bundle. The reason carries the server's stamp
                // so a refusal is diagnosable from a browser console alone.
                webSocket.close(VERSION_MISMATCH_CLOSE_CODE,
                    truncateCloseReason(decision.reason));
                return;
            }
        }

        const clientUUID = v4();
        // This uuid is used only for communication and
        // has nothing to do with the game engine's uuids
        const client: Client = {
            socket: webSocket,
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

    // Handles messages received from clients. Forwards messages to their destination.
    private handleMessageFromClient(clientUUID: string, serialized: string) {
        this.resetClientTimeout(clientUUID);
        const client = this.clientMap.get(clientUUID);
        if (!client) {
            throw new Error(`Missing client object for ${clientUUID}`);
        }

        const maybeSocketMessage = SocketMessage.decode(JSON.parse(serialized) as unknown);

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
            throw new Error(
                `Tried to remove nonexistant client ${clientUUID}`);
        }

        if (client.keepaliveTimeout !== undefined) {
            clearTimeout(client.keepaliveTimeout);
        }

        client.socket.removeAllListeners();
        this.clientMap.delete(clientUUID);
        this.clientDisconnect.next(clientUUID);
    }
}
