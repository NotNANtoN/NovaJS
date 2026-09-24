import 'jasmine';
import { pickVoiceClip, resolveVoice } from './escort_voice';

const retail = new Set<number>([
    // Civ/Ind (type 0): 7 acknowledge, 5 target, 3 victory
    1000, 1001, 1002, 1003, 1004, 1005, 1006, 1010, 1011, 1012, 1013, 1014, 1020, 1021, 1022,
    // Pirate (type 5): 8 clips per bank
    1500, 1501, 1502, 1503, 1504, 1505, 1506, 1507,
    1510, 1511, 1512, 1513, 1514, 1515, 1516, 1517,
]);

describe('escort voices (govt VoiceType)', () => {
    it('resolves voice type and forced parity', () => {
        expect(resolveVoice(undefined)).toEqual({ type: 0 });
        expect(resolveVoice(-1)).toBeUndefined();
        expect(resolveVoice(1005)).toEqual({ type: 5, parity: 'odd' });
        expect(resolveVoice(2005)).toEqual({ type: 5, parity: 'even' });
    });

    it('picks from the right bank', () => {
        expect(pickVoiceClip({ type: 0 }, 'acknowledge', 's', retail, () => 0)).toBe('nova:1000');
        expect(pickVoiceClip({ type: 0 }, 'target', 's', retail, () => 0.99)).toBe('nova:1014');
        expect(pickVoiceClip({ type: 0 }, 'victory', 's', retail, () => 0.5)).toBe('nova:1021');
        expect(pickVoiceClip({ type: 3 }, 'victory', 's', retail)).toBeUndefined();
    });

    it('keeps one voice (odd or even clips) per ship for even banks', () => {
        const odd = new Set<string>();
        for (let i = 0; i < 20; i++) {
            odd.add(pickVoiceClip({ type: 5, parity: 'odd' }, 'target', 's', retail, () => i / 20)!);
        }
        expect([...odd].every(id => Number(id.slice(5)) % 2 === 1)).toBeTrue();
        expect(odd.size).toBe(4);
    });
});
