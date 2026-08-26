import * as t from 'io-ts';
import { isLeft, right } from "fp-ts/Either";
import { immerable } from 'immer';


const SEND_INTERVAL = 1000;

class Box<T> {
    [immerable] = true;
    changed = false;
    constructor(public wrappedVal: T) { }

    set val(t: T) {
        this.wrappedVal = t;
        this.changed = true;
    }
    get val() {
        return this.wrappedVal;
    }
}

/**
 * How much of a stat's range has to change before it is worth interrupting the
 * send interval. A hit takes a visible bite out of a bar; recharge creeps.
 */
const SHARP_CHANGE_FRACTION = 0.01;

export class Stat {
    [immerable] = true;
    lastSent = 0;
    private lastSentCurrent: number;
    private wrappedCurrent: Box<number>;
    private wrappedRecharge: Box<number>;
    private wrappedMax: Box<number>;
    private wrappedMin: Box<number>;

    constructor({ current, recharge, max, min }: {
        current: number,
        recharge: number,
        max: number,
        min?: number,
    }) {
        this.wrappedCurrent = new Box(current);
        this.wrappedRecharge = new Box(recharge);
        this.wrappedMax = new Box(max);
        this.wrappedMin = new Box(min ?? 0);
        this.lastSentCurrent = current;
    }

    /**
     * Whether the value has moved far enough that waiting for the next send
     * interval would be visible to a player. Deliberately non-destructive:
     * `getDelta` clears the change flags, so it cannot be used to ask.
     */
    get changedSharply() {
        const range = this.max - this.min;
        return range > 0
            && Math.abs(this.current - this.lastSentCurrent)
                >= range * SHARP_CHANGE_FRACTION;
    }

    step(delta: number) {
        // Through the setter, so recharge is reported as a change and reaches
        // clients: they no longer compute health themselves. `getStatDelta`
        // throttles the result, so this does not put a stat on the wire per
        // frame.
        this.current = Math.max(this.min,
            Math.min(this.max, this.current + this.recharge * delta));
    }

    get percent() {
        return Math.ceil(this.current / this.max * 100);
    }

    getDelta(): PartialStat | undefined {
        const delta: PartialStat = {};

        let changed = false;
        if (this.wrappedCurrent.changed) {
            delta.current = this.current;
            this.lastSentCurrent = this.current;
            this.wrappedCurrent.changed = false;
            changed = true;
        }

        if (this.wrappedMax.changed) {
            delta.max = this.max;
            this.wrappedMax.changed = false;
            changed = true;
        }

        if (this.wrappedMin.changed) {
            delta.min = this.min;
            this.wrappedMin.changed = false;
            changed = true;
        }

        if (this.wrappedRecharge.changed) {
            delta.recharge = this.recharge;
            this.wrappedRecharge.changed = false;
            changed = true;
        }

        if (changed) {
            return delta;
        }
        return;
    }

    applyDelta(delta: PartialStat) {
        if (delta.current !== undefined) {
            this.wrappedCurrent.wrappedVal = delta.current;
        }

        if (delta.max !== undefined) {
            this.wrappedMax.wrappedVal = delta.max;
        }

        if (delta.min !== undefined) {
            this.wrappedMin.wrappedVal = delta.min;
        }

        if (delta.recharge !== undefined) {
            this.wrappedRecharge.wrappedVal = delta.recharge;
        }
    }

    get current() {
        return this.wrappedCurrent.val;
    }
    set current(val: number) {
        this.wrappedCurrent.val = val;
    }

    get recharge() {
        return this.wrappedRecharge.val;
    }
    set recharge(val: number) {
        this.wrappedRecharge.val = val;
    }

    get max() {
        return this.wrappedMax.val;
    }
    set max(val: number) {
        this.wrappedMax.val = val;
    }
    get min() {
        return this.wrappedMin.val;
    }
    set min(val: number) {
        this.wrappedMin.val = val;
    }
}

const StatContents = {
    current: t.number,
    recharge: t.number,
    max: t.number,
    min: t.number,
};

const statState = t.type(StatContents);
export const stat = new t.Type('Stat',
    (u): u is Stat => u instanceof Stat,
    (i, context) => {
        const decoded = statState.validate(i, context);
        if (isLeft(decoded)) {
            return decoded;
        }
        return right(new Stat(decoded.right));
    },
    (stat) => (statState.encode({
        current: stat.current,
        max: stat.max,
        min: stat.min,
        recharge: stat.recharge,
    }))
);

export const PartialStat = t.partial(StatContents);
export type PartialStat = t.TypeOf<typeof PartialStat>;

export function getStatDelta(_a: Stat, b: Stat): PartialStat | undefined {
    const now = new Date().getTime();
    // Health is server authority, so a client only learns it was hit when this
    // arrives. Waiting out the send interval would leave the bar a second
    // behind the fight, while recharge can wait: it is why the interval exists.
    if (b.lastSent + SEND_INTERVAL < now || b.changedSharply) {
        b.lastSent = now;
        return b.getDelta();
    }
    return undefined;
}

export function applyStatDelta(stat: Stat, delta: PartialStat) {
    stat.applyDelta(delta);
}
