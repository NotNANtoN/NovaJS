import 'jasmine';
import { ABOUT_TEXT, fillAboutPlaceholders } from './title_dialogs.js';

describe('about text', () => {
    it('substitutes the registration placeholder', () => {
        expect(fillAboutPlaceholders('Registered to:\n     <REG>\n'))
            .toBe('Registered to:\n     NovaJS (unregistered)\n');
    });

    it('substitutes every occurrence', () => {
        expect(fillAboutPlaceholders('<REG> and <REG>'))
            .not.toContain('<REG>');
    });

    it('leaves text without the placeholder untouched', () => {
        expect(fillAboutPlaceholders('Engine Programming:'))
            .toBe('Engine Programming:');
    });

    it('keeps a usable fallback for data sets with no About dësc', () => {
        expect(ABOUT_TEXT.join('\n')).toContain('Escape Velocity: Nova');
        expect(ABOUT_TEXT.join('\n')).toContain('Ambrosia Software');
    });
});
