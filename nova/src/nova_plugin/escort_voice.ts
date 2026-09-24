/**
 * Escort speech (EV Nova Bible, gövt/VoiceType).
 *
 * A voice type 0-7 owns three banks of snd resources:
 *   1000 + 100 * type + 0..9    acknowledgement
 *   1000 + 100 * type + 10..19  targeting
 *   1000 + 100 * type + 20..29  victory
 * When a bank has an even number of clips, each ship uses only its odd or only
 * its even clips (male/female voices). VoiceType + 1000 forces odd clips,
 * + 2000 forces even clips; -1 means no speech. Ships without an inherent
 * government use voice type 0.
 */

export type VoiceLine = 'acknowledge' | 'target' | 'victory';

const LINE_OFFSET: Record<VoiceLine, number> = {
    acknowledge: 0,
    target: 10,
    victory: 20,
};

export interface ResolvedVoice {
    type: number;
    parity?: 'odd' | 'even';
}

export function resolveVoice(voiceType: number | undefined): ResolvedVoice | undefined {
    const raw = voiceType ?? 0;
    if (raw < 0) return undefined;
    if (raw >= 2000) return { type: raw - 2000, parity: 'even' };
    if (raw >= 1000) return { type: raw - 1000, parity: 'odd' };
    return { type: raw };
}

/** Stable per-ship parity when the government lets each ship choose. */
export function shipParity(shipUuid: string): 'odd' | 'even' {
    let hash = 0;
    for (let i = 0; i < shipUuid.length; i++) {
        hash = (hash * 31 + shipUuid.charCodeAt(i)) | 0;
    }
    return (hash & 1) === 0 ? 'even' : 'odd';
}

/**
 * Pick a clip for `line`, or undefined when the voice has none. `available`
 * is the set of snd ids present in the data (as numbers).
 */
export function pickVoiceClip(
    voice: ResolvedVoice,
    line: VoiceLine,
    shipUuid: string,
    available: ReadonlySet<number>,
    random: () => number = Math.random,
): string | undefined {
    if (voice.type < 0 || voice.type > 7) return undefined;
    const base = 1000 + voice.type * 100 + LINE_OFFSET[line];
    let clips: number[] = [];
    for (let id = base; id < base + 10; id++) {
        if (available.has(id)) clips.push(id);
    }
    if (clips.length === 0) return undefined;
    if (clips.length % 2 === 0) {
        const parity = voice.parity ?? shipParity(shipUuid);
        const wanted = parity === 'even' ? 0 : 1;
        clips = clips.filter(id => id % 2 === wanted);
    }
    const clip = clips[Math.floor(random() * clips.length) % clips.length];
    return clip === undefined ? undefined : `nova:${clip}`;
}
