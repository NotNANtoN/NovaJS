export type Builder<T> = (id: string, priority: number) => Promise<T>;

export type GettableData<G> = G extends Gettable<infer T> ? T : never;

export class Gettable<T> {
    protected data: { [key: string]: Promise<T> } = {};
    gotten: { [key: string]: T } = {};

    constructor(protected getFunction: Builder<T>,
        protected warn: (message: unknown) => void = console.warn) { }

    async get(id: string, priority: number = 0) {
        if (id in this.gotten) {
            return this.gotten[id];
        }

        if (!(id in this.data)) {
            this.data[id] = this.getFunction(id, priority);
        }

        try {
            const val = await this.data[id];
            this.gotten[id] = val;
            return val;
        } catch (e) {
            delete this.data[id];
            throw e;
        }
    }

    /**
     * The cached value, or undefined — in which case a *background
     * load starts*, so a later call may succeed.
     *
     * DETERMINISM WARNING (rollback multiplayer): a getCached hit is a
     * property of *this world's* load timing, not of shared game
     * state. Simulation behavior or state creation gated on it
     * diverges peers whose caches warm at different ticks — two real
     * recorded desyncs came from exactly this. Sim code may only call
     * this for ids that staging (loadEntityGameData, spawnAsteroids)
     * provably loaded first, and a miss must never change what the
     * simulation does. See docs/rollback_multiplayer.md findings
     * (11) and (12).
     */
    getCached(id: string): T | undefined {
        const cached = this.gotten[id];
        if (!cached) {
            this.get(id).catch(error => this.warn(error));
            return undefined;
        } else {
            return cached;
        }
    }
}
