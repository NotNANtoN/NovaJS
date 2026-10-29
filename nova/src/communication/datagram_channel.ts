/**
 * Unordered, unreliable datagram side-channel for high-frequency ephemeral
 * packets (movement snapshots, input commands, input acknowledgements, and
 * clock probes).
 *
 * When open, `SocketChannelClient` and `SocketChannelServer` route packets
 * classified by `isUnreliableDatagramCandidate` over this channel as compact
 * binary frames, bypassing TCP head-of-line blocking while keeping reliable
 * entity state, chat, and combat logs on the ordered WebSocket stream.
 */
export interface UnreliableDatagramClient {
    readonly isOpen: boolean;
    send(payload: Uint8Array): boolean;
    onDatagram?: (payload: ArrayBuffer | ArrayBufferView) => void;
    close(): void;
}

export interface UnreliableDatagramServer {
    isOpen(clientId: string): boolean;
    send(clientId: string, payload: Uint8Array): boolean;
    onDatagram?: (clientId: string, payload: ArrayBuffer | ArrayBufferView) => void;
    removeClient?(clientId: string): void;
}

export interface RtcDataChannelLike {
    readonly readyState: 'connecting' | 'open' | 'closing' | 'closed' | string;
    binaryType?: string;
    send(data: Uint8Array | ArrayBuffer): void;
    close(): void;
    addEventListener(type: string, listener: (event: any) => void): void;
    removeEventListener(type: string, listener: (event: any) => void): void;
}

/**
 * Wraps a WebRTC `RTCDataChannel` (created with `{ ordered: false, maxRetransmits: 0 }`)
 * as an `UnreliableDatagramClient`.
 */
export class RtcDatagramClient implements UnreliableDatagramClient {
    onDatagram?: (payload: ArrayBuffer | ArrayBufferView) => void;
    private readonly messageListener = (event: { data?: unknown }) => {
        if (event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data)) {
            this.onDatagram?.(event.data);
        }
    };

    constructor(private readonly channel: RtcDataChannelLike) {
        this.channel.binaryType = 'arraybuffer';
        this.channel.addEventListener('message', this.messageListener);
    }

    get isOpen(): boolean {
        return this.channel.readyState === 'open';
    }

    send(payload: Uint8Array): boolean {
        if (!this.isOpen) return false;
        try {
            this.channel.send(payload);
            return true;
        } catch {
            return false;
        }
    }

    close(): void {
        this.channel.removeEventListener('message', this.messageListener);
        try {
            this.channel.close();
        } catch {}
    }
}
