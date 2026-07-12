import * as fs from "fs/promises";
import * as path from "path";
import { ArchiveBaseline, DesyncDump, InputRecord } from "../communication/rollback_protocol.js";
import { DesyncInfo } from "../communication/rollback_relay.js";

/** How many incident directories to retain before pruning the oldest. */
const DEFAULT_MAX_INCIDENTS = 50;

/** Room ids (nova:130) and peer uuids become filesystem-safe names. */
function sanitize(name: string): string {
    return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * The server's black-box recorder for desyncs: each conviction gets a
 * timestamped directory under `desyncs/` holding everything offline
 * analysis (analyze_desync.mjs) needs to name the diverged entity,
 * component, and tick:
 *
 * - desync.json: the verdict — tick, all reported hashes, canonical,
 *   who was convicted, whether the archive itself was outvoted.
 * - baselines.json: the archive's retained wire baselines. Replaying
 *   the oldest over log.json reproduces the server's view of the room
 *   at any tick in the incident window.
 * - log.json: the relay's input log (the room's ground truth).
 * - client_<peer>.json: the convicted peer's uploaded state history
 *   (checkpoint wire snapshots + rollback event log), written when it
 *   arrives — moments after desync.json, since diverged peers upload
 *   before resyncing.
 */
export class DesyncRecorder {
    /** Most recent incident directory per room, for filing uploads. */
    private latestIncident = new Map<string, string>();
    /** Serializes writes so pruning never races directory creation. */
    private queue: Promise<void> = Promise.resolve();

    constructor(
        private root = path.join(process.cwd(), 'desyncs'),
        private maxIncidents = DEFAULT_MAX_INCIDENTS,
    ) { }

    /** Chains async work, reporting rather than propagating errors. */
    private enqueue(work: () => Promise<void>) {
        this.queue = this.queue.then(work).catch(error => {
            console.error('DesyncRecorder failed:', error);
        });
    }

    recordDesync(roomId: string, info: DesyncInfo, context: {
        baselines: ArchiveBaseline[],
        log: readonly InputRecord[],
    }) {
        // Stringify synchronously: the log and baselines mutate as the
        // room runs, and the writes happen later on the queue.
        const files = new Map<string, string>([
            ['desync.json', JSON.stringify({
                roomId,
                wallTime: new Date().toISOString(),
                ...info,
            }, null, 2)],
            ['baselines.json', JSON.stringify(context.baselines)],
            ['log.json', JSON.stringify(context.log)],
        ]);
        const dir = path.join(this.root,
            `${new Date().toISOString().replace(/[:.]/g, '-')}_`
            + `${sanitize(roomId)}_tick${info.tick}`);
        this.latestIncident.set(roomId, dir);
        this.enqueue(async () => {
            await fs.mkdir(dir, { recursive: true });
            for (const [name, data] of files) {
                await fs.writeFile(path.join(dir, name), data);
            }
            console.log(`Recorded desync incident at ${dir}`);
            await this.prune();
        });
    }

    recordClientDump(roomId: string, peerId: string, dump: DesyncDump) {
        const data = JSON.stringify(dump);
        // An unsolicited dump (or one arriving after a restart) still
        // gets recorded, in its own directory.
        let dir = this.latestIncident.get(roomId);
        if (!dir) {
            dir = path.join(this.root,
                `${new Date().toISOString().replace(/[:.]/g, '-')}_`
                + `${sanitize(roomId)}_dump`);
            this.latestIncident.set(roomId, dir);
        }
        const file = path.join(dir, `client_${sanitize(peerId)}.json`);
        this.enqueue(async () => {
            await fs.mkdir(dir!, { recursive: true });
            await fs.writeFile(file, data);
            console.log(`Recorded desync dump from ${peerId} at ${file}`);
        });
    }

    /** Removes the oldest incident directories beyond the cap. The
     * timestamp prefix makes lexicographic order chronological. */
    private async prune() {
        const entries = (await fs.readdir(this.root, { withFileTypes: true }))
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort();
        for (const name of entries.slice(0,
            Math.max(0, entries.length - this.maxIncidents))) {
            await fs.rm(path.join(this.root, name),
                { recursive: true, force: true });
        }
    }

    /** Resolves when all queued writes have settled (for tests). */
    flush(): Promise<void> {
        return this.queue;
    }
}
