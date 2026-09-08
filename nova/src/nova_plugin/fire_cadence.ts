export interface FireCadenceWeapon {
    /** Trusted server weapon data; times are milliseconds. */
    reload: number;
    burstReload: number;
    burstCount: number;
    fireSimultaneously: boolean;
    /** Trusted installed copies. Zero disables the weapon without forgetting debt. */
    count: number;
}

export interface FireCadenceOptions {
    maxPendingPerWeapon?: number;
    maxWeapons?: number;
    maxCopies?: number;
    maxAgeMs?: number;
}

/** Per-copy burst metadata. Stable on a failed callback/retry; debit costs only on success. */
export interface FireCadenceShotContext {
    copy: number;
    /** Monotonic per weapon, not a client sequence. Scope payments by weapon + token + copy. */
    burstToken: number;
    /** First/last scheduled shot of this installed copy in the burst. */
    firstInBurst: boolean;
    lastInBurst: boolean;
}

interface WeaponQueue<T> {
    weapon: FireCadenceWeapon;
    pending: { intent: T; receivedAt: number }[];
    nextAt: number;
    burstProgress: number;
    salvoRemaining: number;
    salvoOpportunity: number;
    burstToken: number;
}

export type FireCadenceEnqueueResult = 'queued' | 'full' | 'unavailable';

/**
 * Server-local scheduler, one instance per stable shooter identity. Never replicate
 * it or supply a client clock. Intents are individual projectiles, NOT trigger
 * presses: a simultaneous salvo consumes up to `count` queued intents.
 *
 * Validate/deduplicate wire intents before enqueue (including rejected/expired
 * sequences in the caller's high-water mark). Only register trusted weapon IDs.
 * The generic payload is opaque: no payload timestamp affects scheduling.
 *
 * No catch-up credit: overdue fire occurs now, and its next deadline starts now.
 * Zero reload is conservatively limited to one opportunity per millisecond.
 */
export class FireCadence<T> {
    private readonly weapons = new Map<string, WeaponQueue<T>>();
    private readonly maxPending: number;
    private readonly maxWeapons: number;
    private readonly maxCopies: number;
    private readonly maxAgeMs: number;
    private lastNow = -Infinity;
    private draining = false;

    constructor(private readonly clock: () => number, options: FireCadenceOptions = {}) {
        this.maxPending = options.maxPendingPerWeapon ?? 16;
        this.maxWeapons = options.maxWeapons ?? 64;
        this.maxCopies = options.maxCopies ?? 256;
        this.maxAgeMs = options.maxAgeMs ?? 2000;
        for (const value of [this.maxPending, this.maxWeapons, this.maxCopies]) {
            if (!Number.isSafeInteger(value) || value < 1) {
                throw new RangeError('Fire cadence bounds must be positive safe integers');
            }
        }
        if (!Number.isFinite(this.maxAgeMs) || this.maxAgeMs <= 0) {
            throw new RangeError('Fire cadence maxAgeMs must be finite and positive');
        }
    }

    /**
     * Register/update from authoritative inventory. Changes clear pending work and
     * unused salvo slots, but retain the deadline and burst progress. In particular,
     * removing/reinstalling a weapon cannot refill its cooldown. Invalid data throws
     * without changing state. Disabled keys still occupy a bounded state slot.
     */
    setWeapon(key: string, weapon: FireCadenceWeapon): void {
        this.assertNotDraining();
        if (!Number.isSafeInteger(weapon.count) || weapon.count < 0
            || weapon.count > this.maxCopies
            || !Number.isSafeInteger(weapon.burstCount) || weapon.burstCount < 0
            || !Number.isFinite(weapon.reload) || weapon.reload < 0
            || !Number.isFinite(weapon.burstReload) || weapon.burstReload < 0
            || typeof weapon.fireSimultaneously !== 'boolean'
            || !Number.isSafeInteger(weapon.burstCount * Math.max(1, weapon.count))) {
            throw new RangeError('Invalid authoritative fire cadence weapon');
        }
        const state = this.weapons.get(key);
        if (state) {
            const old = state.weapon;
            if (old.count !== weapon.count || old.reload !== weapon.reload
                || old.burstReload !== weapon.burstReload
                || old.burstCount !== weapon.burstCount
                || old.fireSimultaneously !== weapon.fireSimultaneously) {
                state.pending.length = 0;
                state.salvoRemaining = 0;
                state.weapon = { ...weapon };
                state.burstToken++;
            }
            return;
        }
        if (this.weapons.size >= this.maxWeapons) {
            throw new RangeError('Fire cadence weapon capacity exceeded');
        }
        this.weapons.set(key, {
            weapon: { ...weapon }, pending: [], nextAt: -Infinity,
            burstProgress: 0, salvoRemaining: 0, salvoOpportunity: 0, burstToken: 0,
        });
    }

    /** FIFO tail-drop on overflow; later arrivals never refresh older expiry. */
    enqueue(key: string, intent: T): FireCadenceEnqueueResult {
        this.assertNotDraining();
        const now = this.now();
        const state = this.weapons.get(key);
        if (!state || state.weapon.count === 0) {
            return 'unavailable';
        }
        this.expire(state, now);
        if (state.pending.length >= this.maxPending) {
            return 'full';
        }
        state.pending.push({ intent, receivedAt: now });
        return 'queued';
    }

    /**
     * Call every server step, even without new network arrivals. `emit` must be
     * synchronous and return true ONLY after successful projectile creation/cost
     * payment/logging, using `at` as the authoritative shot time. False retains the
     * head for retry until expiry, stops this drain, and spends no cadence.
     *
     * At most one new opportunity opens per drain. A simultaneous opportunity may
     * emit several intents; split network arrivals may fill its remaining slots
     * before the next deadline. Unused slots never carry into a later opportunity.
     * Callbacks must not reenter/mutate this scheduler or throw after spawning.
     * Returns the number of successfully emitted individual projectiles.
     */
    drain(key: string, emit: (intent: T, at: number,
        context: FireCadenceShotContext) => boolean): number {
        this.assertNotDraining();
        const now = this.now();
        const state = this.weapons.get(key);
        if (!state || state.weapon.count === 0) {
            return 0;
        }
        this.expire(state, now);
        const weapon = state.weapon;
        let emitted = 0;
        this.draining = true;
        try {
            while (state.pending.length > 0) {
                const opensOpportunity = now >= state.nextAt;
                if (!opensOpportunity && state.salvoRemaining === 0) {
                    break;
                }
                const opportunity = opensOpportunity
                    ? state.burstProgress : state.salvoOpportunity;
                const burstToken = state.burstToken
                    + (opensOpportunity && opportunity === 0 ? 1 : 0);
                const burstLimit = weapon.burstCount * (
                    weapon.fireSimultaneously ? 1 : weapon.count);
                const context: FireCadenceShotContext = {
                    copy: weapon.fireSimultaneously
                        ? opensOpportunity ? 0 : weapon.count - state.salvoRemaining
                        : opportunity % weapon.count,
                    burstToken,
                    firstInBurst: burstLimit === 0 || (weapon.fireSimultaneously
                        ? opportunity === 0 : opportunity < weapon.count),
                    lastInBurst: burstLimit === 0 || (weapon.fireSimultaneously
                        ? opportunity >= burstLimit - 1
                        : opportunity >= burstLimit - weapon.count),
                };
                if (!emit(state.pending[0].intent, now, context)) {
                    break;
                }
                state.pending.shift();
                emitted++;
                if (opensOpportunity) {
                    state.salvoRemaining = weapon.fireSimultaneously ? weapon.count : 1;
                    state.salvoOpportunity = opportunity;
                    state.burstToken = burstToken;
                    state.burstProgress++;
                    const endsBurst = burstLimit > 0 && state.burstProgress >= burstLimit;
                    const interval = endsBurst ? weapon.burstReload
                        : weapon.reload / (weapon.fireSimultaneously ? 1 : weapon.count);
                    state.nextAt = now + Math.max(1, interval);
                    if (endsBurst || burstLimit === 0) {
                        state.burstProgress = 0;
                    }
                }
                state.salvoRemaining--;
            }
        } finally {
            this.draining = false;
        }
        return emitted;
    }

    /**
     * Landing/death/ownership transfer: cancel work, NOT cooldown or burst debt.
     * Omit key to cancel all weapons. Keep this instance across transient lifecycle
     * changes (and keep wire sequence dedup state). Only dispose it when the shooter
     * identity is permanently retired; reconnecting must not manufacture a new one.
     */
    clearPending(key?: string): void {
        this.assertNotDraining();
        const states = key === undefined ? this.weapons.values()
            : this.weapons.has(key) ? [this.weapons.get(key)!] : [];
        for (const state of states) {
            state.pending.length = 0;
            state.salvoRemaining = 0;
        }
    }

    pendingCount(key: string): number {
        this.assertNotDraining();
        const now = this.now();
        const state = this.weapons.get(key);
        if (!state) {
            return 0;
        }
        this.expire(state, now);
        return state.pending.length;
    }

    private expire(state: WeaponQueue<T>, now: number): void {
        while (state.pending.length > 0
            && now - state.pending[0].receivedAt >= this.maxAgeMs) {
            state.pending.shift();
        }
    }

    private now(): number {
        const now = this.clock();
        if (!Number.isFinite(now) || now < this.lastNow) {
            throw new RangeError('Fire cadence requires a finite monotonic server clock');
        }
        this.lastNow = now;
        return now;
    }

    private assertNotDraining(): void {
        if (this.draining) {
            throw new Error('Fire cadence callbacks must not reenter the scheduler');
        }
    }
}
