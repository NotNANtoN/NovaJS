import 'jasmine';
import { hotkeyActionFor } from './title_screen.js';

describe('title screen hotkeys', () => {
    it('maps each command letter to its action', () => {
        expect(hotkeyActionFor({ key: 'n' })).toBe('newPilot');
        expect(hotkeyActionFor({ key: 'o' })).toBe('openPilot');
        expect(hotkeyActionFor({ key: 'q' })).toBe('quit');
        expect(hotkeyActionFor({ key: 'e' })).toBe('enterShip');
        expect(hotkeyActionFor({ key: 'p' })).toBe('setPrefs');
        expect(hotkeyActionFor({ key: 'a' })).toBe('about');
    });

    it('is case-insensitive (a capitalized letter still maps)', () => {
        expect(hotkeyActionFor({ key: 'N' })).toBe('newPilot');
        expect(hotkeyActionFor({ key: 'A' })).toBe('about');
    });

    it('ignores non-hotkey keys', () => {
        expect(hotkeyActionFor({ key: 'x' })).toBeUndefined();
        expect(hotkeyActionFor({ key: 'Enter' })).toBeUndefined();
        expect(hotkeyActionFor({ key: 'ArrowUp' })).toBeUndefined();
        expect(hotkeyActionFor({ key: ' ' })).toBeUndefined();
    });

    it('ignores hotkeys while a modifier is held (Cmd/Ctrl/Alt)', () => {
        // e.g. Cmd+Q must remain the browser's quit, not "quit Nova".
        expect(hotkeyActionFor({ key: 'q', metaKey: true })).toBeUndefined();
        expect(hotkeyActionFor({ key: 'n', ctrlKey: true })).toBeUndefined();
        expect(hotkeyActionFor({ key: 'a', altKey: true })).toBeUndefined();
    });
});
