import 'jasmine';
import { expandMissionText } from './mission_text.js';

/**
 * The <SN> wildcard, per the EVN Bible's mission-wildcard table:
 * "<SN>  Special ship name (Note: Nova will screw up if you use this
 * in the initial mission description, as it doesn't pick the special
 * ship names until you actually accept the mission.)"
 *
 * The texts below are the real stock dëscs of mïsn nova:258
 * ("25000 Credit Bounty;Bounty Hunter1a"), whose ShipNameID points at
 * STR# nova:25000 "Auroran Warships" — ["Dechanik", "Blood Honor",
 * "Frunch'eck", "Talons of Integrity", "Warrior's Pride", "Doomblade",
 * "Warrior's Path", "Gjinchar", "Swordsman's Song", "Ytrack"].
 */
describe('expandMissionText <SN>', () => {
    const BRIEF = 'In the last few weeks a rogue Auroran ship, the <SN>, '
        + 'has slipped past Federation border patrols and has been '
        + 'harassing ships in this and the surrounding systems.  Track it '
        + 'down and destroy it before heading back to Sol to collect your '
        + 'bounty (less the ten percent Guild fee) from the Guild offices '
        + 'on <RST>.';
    const QUICK_BRIEF = 'Locate and destroy the <SN> and then collect your '
        + 'bounty at the Guild offices on the Kane Band.';

    it('expands the accepted mission\'s special ship name', () => {
        expect(expandMissionText(QUICK_BRIEF,
            { specialShipName: 'Doomblade' }))
            .toBe('Locate and destroy the Doomblade and then collect your '
                + 'bounty at the Guild offices on the Kane Band.');
    });

    it('expands every occurrence, alongside the other wildcards', () => {
        const text = expandMissionText(BRIEF, {
            specialShipName: 'Blood Honor',
            returnStellar: 'Earth',
        });
        expect(text).toContain('a rogue Auroran ship, the Blood Honor,');
        expect(text).toContain('the Guild offices on Earth.');
        expect(text).not.toContain('<SN>');
    });

    it('falls back to a generic phrase before the mission is accepted '
        + '(the Bible\'s documented broken case)', () => {
        // No name has been picked yet — Nova "screws up" here; NovaJS
        // degrades gracefully instead of printing a raw tag.
        const text = expandMissionText(QUICK_BRIEF, {});
        expect(text).toBe('Locate and destroy the unknown ship and then '
            + 'collect your bounty at the Guild offices on the Kane Band.');
        expect(text).not.toContain('<SN>');
    });

    it('falls back the same way for an accepted mission with no '
        + 'ShipNameID list', () => {
        // mïsn nova:685 ("Assassinate Krane") uses <SN> in its QuickBrief
        // but sets ShipNameID -1 (only a ShipSubtitle STR#, nova:25024),
        // so the original has nothing to substitute either.
        expect(expandMissionText(
            'Assassinate Krane as she flies through the Wolf 359 system '
            + 'in the <SN>.', {}))
            .toBe('Assassinate Krane as she flies through the Wolf 359 '
                + 'system in the unknown ship.');
    });
});
