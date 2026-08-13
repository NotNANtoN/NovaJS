/**
 * How many instances of the SAME sound may START in one display frame.
 *
 * Tell six identical escorts to attack and they fire on the same frame,
 * stacking six copies of one sample — identical waveforms starting
 * together sum to a single much louder sound rather than a busier one,
 * which is what makes a mass volley harsh. Three is Matthew's suggested
 * cap and keeps a volley audibly bigger than a single shot without the
 * pile-on.
 */
export const MAX_SAME_SOUND_STARTS_PER_FRAME = 3;

/**
 * A per-frame cap on how many instances of a given sound may start.
 *
 * This is the SECOND of two defenses against stacked audio, and the
 * general one:
 *
 *  - At the SOURCE, a submunition burst emits its firing sound once for
 *    the whole burst rather than once per child (fire_weapon_plugin's
 *    fireSubs). That case is pathological — one weapon effect, up to a
 *    dozen children — and wants exactly one instance, which a cap of
 *    three would not give.
 *  - Here, at the MIXER, coincidental pileups from unrelated sources —
 *    a fleet volley, a cluster of explosions — are capped. Nothing
 *    upstream can know about those, since they come from different
 *    entities that merely happen to land on the same frame.
 *
 * Display-only, so there are no determinism constraints: dropping a
 * sound start changes nothing any peer simulates. Deliberately keyed on
 * exact frame identity rather than a rolling time window — Matthew's
 * note allows same-frame-only, and it needs no timestamp bookkeeping
 * beyond the frame stamp the caller already has.
 *
 * PIXI-free so it can be specced headlessly.
 */
export class SoundStartLimiter {
    /** The frame stamp `starts` is counting for; undefined before use. */
    private frame?: number;
    private readonly starts = new Map<string, number>();

    constructor(
        private readonly maxPerFrame = MAX_SAME_SOUND_STARTS_PER_FRAME) { }

    /**
     * Whether a start of `id` on frame `frame` may proceed, counting it
     * against the cap when it may. `frame` is any value that is equal
     * within a frame and different between them (the display clock's
     * time.time); ANY change resets the counts, so a rollback that
     * rewinds the clock re-arms the limiter rather than wedging it.
     */
    allow(id: string, frame: number): boolean {
        if (frame !== this.frame) {
            this.frame = frame;
            this.starts.clear();
        }
        const started = this.starts.get(id) ?? 0;
        if (started >= this.maxPerFrame) {
            return false;
        }
        this.starts.set(id, started + 1);
        return true;
    }
}
