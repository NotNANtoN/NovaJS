import { BehaviorSubject, Subject } from 'rxjs';
import { Communicator, Peers } from './multiplayer_plugin';

/** Test harness: a frame-stepped network with scripted latency and faults. */
export interface DelayedNetworkOptions {
    /** One-way delays in ms, cycled per message. */
    readonly delays?: number[];
    readonly duplicate?: (source: string, message: unknown, index: number) => boolean;
    readonly drop?: (source: string, message: unknown, index: number) => boolean;
    readonly reorder?: boolean;
    /** Frame length used to convert delays; defaults to 60 Hz. */
    readonly frameMs?: number;
}

export class DeterministicDelayedNetwork {
    private readonly communicators = new Map<string, DelayedCommunicator>();
    private readonly pending: Array<{
        deliverAt: number;
        destination: string;
        source: string;
        message: unknown;
    }> = [];
    private delayIndex = 0;
    private messageIndex = 0;
    frame = 0;
    readonly sentBytes = new Map<string, number>();
    onDeliver?: (destination: string, message: unknown) => void;

    constructor(private readonly options: DelayedNetworkOptions = {}) {}

    connect(uuid: string): DelayedCommunicator {
        const communicator = new DelayedCommunicator(uuid, this);
        this.communicators.set(uuid, communicator);
        const peers = new Set(this.communicators.keys());
        for (const connected of this.communicators.values()) {
            connected.peers.current.next(peers);
        }
        return communicator;
    }

    send(source: string, message: unknown, destination?: string | Set<string>) {
        const destinations = destination === undefined
            ? [...this.communicators.keys()].filter(uuid => uuid !== source)
            : typeof destination === 'string' ? [destination] : [...destination];
        const delays = this.options.delays ?? [50, 150, 83, 117, 67, 133, 100];
        const delay = delays[this.delayIndex++ % delays.length];
        const frames = Math.ceil(delay / (this.options.frameMs ?? 1000 / 60));
        const encoded = JSON.parse(JSON.stringify(message)) as unknown;
        const index = this.messageIndex++;
        if (this.options.drop?.(source, encoded, index)) {
            return;
        }
        for (const target of destinations) {
            const key = `${source}->${target}`;
            this.sentBytes.set(key, (this.sentBytes.get(key) ?? 0) + Buffer.byteLength(JSON.stringify(encoded)));
            this.pending.push({
                deliverAt: this.frame + frames,
                destination: target,
                source,
                message: encoded,
            });
            if (this.options.duplicate?.(source, encoded, index)) {
                this.pending.push({
                    deliverAt: this.frame + frames + 1,
                    destination: target,
                    source,
                    message: encoded,
                });
            }
        }
    }

    advance(): void {
        this.frame++;
        const due = this.pending
            .filter(message => message.deliverAt <= this.frame)
            .sort((a, b) => a.deliverAt - b.deliverAt);
        if (this.options.reorder) {
            due.reverse();
        }
        for (const message of due) {
            this.onDeliver?.(message.destination, message.message);
            this.communicators.get(message.destination)?.messages.next({
                source: message.source,
                message: message.message,
            });
        }
        for (const message of due) {
            this.pending.splice(this.pending.indexOf(message), 1);
        }
    }
}

export class DelayedCommunicator implements Communicator {
    readonly peers = new Peers(new BehaviorSubject(new Set<string>()));
    readonly servers = new BehaviorSubject(new Set(['server']));
    readonly messages =
        new Subject<{ source: string; message: unknown }>();
    readonly connected = new BehaviorSubject(true);

    constructor(
        readonly uuid: string,
        private readonly network: DeterministicDelayedNetwork,
    ) {}

    sendMessage(message: unknown, destination?: string | Set<string>): void {
        this.network.send(this.uuid, message, destination);
    }
}
