import { decodeCloakModVal, getDefaultCloakData } from 'novadatainterface/cloak_data';
import { getDefaultOutfitData, OutfitData } from 'novadatainterface/outfit_data';
import {
    applyCloakDrain,
    applyCloakToggle,
    applyDecloakOnHit,
    CloakCapability,
    deriveCloak,
    isCloaked,
    isTargetable,
    ShieldLike,
} from './cloak_plugin.js';
import { getValidTargets } from './npc_plugin.js';
import { OutfitsState } from './outfit_plugin.js';

/** A gameData stub exposing only the Outfit.getCached the deriver uses. */
function mockGameData(outfits: { [id: string]: OutfitData | undefined }) {
    return {
        data: {
            Outfit: {
                getCached: (id: string) => outfits[id],
            },
        },
    } as any;
}

function cloakOutfit(id: string, modVal: number): OutfitData {
    return {
        ...getDefaultOutfitData(),
        id,
        cloak: decodeCloakModVal(modVal),
    };
}

function plainOutfit(id: string): OutfitData {
    return { ...getDefaultOutfitData(), id, cloak: getDefaultCloakData() };
}

function capability(over: Partial<CloakCapability> = {}): CloakCapability {
    return { ...getDefaultCloakData(), canCloak: true, isCloak: true, ...over };
}

describe('deriveCloak', () => {
    it('reports canCloak false when the ship owns no cloak outfits', () => {
        const outfits: OutfitsState = new Map([['nova:1', { count: 1 }]]);
        const result = deriveCloak(outfits,
            mockGameData({ 'nova:1': plainOutfit('nova:1') }));
        expect(result?.canCloak).toBe(false);
    });

    it('derives the capability from a cloak outfit (Polaris v1.1 0x0409)', () => {
        const outfits: OutfitsState = new Map([['nova:269', { count: 1 }]]);
        const result = deriveCloak(outfits,
            mockGameData({ 'nova:269': cloakOutfit('nova:269', 0x0409) }));
        expect(result?.canCloak).toBe(true);
        expect(result?.shieldPerSecond).toBe(4);
        expect(result?.deactivatesWhenHit).toBe(true);
        expect(result?.hidesFromRadar).toBe(true);
    });

    it('ignores cloak outfits with zero count', () => {
        const outfits: OutfitsState = new Map([['nova:269', { count: 0 }]]);
        const result = deriveCloak(outfits,
            mockGameData({ 'nova:269': cloakOutfit('nova:269', 0x0409) }));
        expect(result?.canCloak).toBe(false);
    });

    it('merges multiple cloaks: OR booleans, min-nonzero drain', () => {
        const outfits: OutfitsState = new Map([
            ['a', { count: 1 }], // 0x0409: 4 shield/sec, decloak-on-hit, faster fade
            ['b', { count: 1 }], // 0x0006: drops shields + visible on radar
        ]);
        const result = deriveCloak(outfits, mockGameData({
            a: cloakOutfit('a', 0x0409),
            b: cloakOutfit('b', 0x0006),
        }));
        expect(result?.canCloak).toBe(true);
        // b sets visible-on-radar, so merged is NOT radar-hiding (OR of
        // hidesFromRadar: a hides=true, b hides=false -> true).
        expect(result?.hidesFromRadar).toBe(true);
        expect(result?.dropsShieldsOnActivate).toBe(true); // from b
        expect(result?.deactivatesWhenHit).toBe(true);     // from a
        // a drains 4 shield/sec, b drains 0 -> min nonzero is 4.
        expect(result?.shieldPerSecond).toBe(4);
    });

    it('returns undefined when outfit data is not cached yet', () => {
        const outfits: OutfitsState = new Map([['missing', { count: 1 }]]);
        const result = deriveCloak(outfits, mockGameData({ missing: undefined }));
        expect(result).toBeUndefined();
    });
});

describe('applyCloakToggle', () => {
    it('turns a cloak on and off', () => {
        const cloak = capability();
        expect(applyCloakToggle(false, cloak).next).toBe(true);
        expect(applyCloakToggle(true, cloak).next).toBe(false);
    });

    it('is a no-op when the ship cannot cloak', () => {
        const cloak = capability({ canCloak: false });
        expect(applyCloakToggle(false, cloak).next).toBe(false);
    });

    it('requests a shield drop only when activating a drops-shields cloak', () => {
        const cloak = capability({ dropsShieldsOnActivate: true });
        expect(applyCloakToggle(false, cloak).dropShields).toBe(true);  // on
        expect(applyCloakToggle(true, cloak).dropShields).toBe(false);  // off
        const noDrop = capability({ dropsShieldsOnActivate: false });
        expect(applyCloakToggle(false, noDrop).dropShields).toBe(false);
    });
});

describe('applyCloakDrain', () => {
    it('drains shields per second while cloaked', () => {
        const shield: ShieldLike = { current: 100, min: -5 };
        const cloak = capability({ shieldPerSecond: 4 });
        const active = applyCloakDrain(true, cloak, 0.5, shield);
        expect(shield.current).toBe(98); // 100 - 4 * 0.5
        expect(active).toBe(true);
    });

    it('does nothing when not cloaked', () => {
        const shield: ShieldLike = { current: 100, min: 0 };
        const cloak = capability({ shieldPerSecond: 4 });
        expect(applyCloakDrain(false, cloak, 1, shield)).toBe(false);
        expect(shield.current).toBe(100);
    });

    it('decloaks and clamps when shields hit the floor', () => {
        const shield: ShieldLike = { current: 1, min: 0 };
        const cloak = capability({ shieldPerSecond: 8 });
        const active = applyCloakDrain(true, cloak, 1, shield); // 1 - 8 -> floor
        expect(active).toBe(false);
        expect(shield.current).toBe(0);
    });

    it('stays cloaked with no drain bits set', () => {
        const shield: ShieldLike = { current: 100, min: 0 };
        const cloak = capability({ shieldPerSecond: 0, fuelPerSecond: 0 });
        expect(applyCloakDrain(true, cloak, 10, shield)).toBe(true);
        expect(shield.current).toBe(100);
    });

    it('does not decloak on fuel drain while the fuel stub is a no-op', () => {
        // TODO(fuel): once a fuel stat exists this should decloak on
        // exhaustion. For now fuel is unlimited, so the ship stays cloaked.
        const cloak = capability({ fuelPerSecond: 8 });
        expect(applyCloakDrain(true, cloak, 100)).toBe(true);
    });
});

describe('applyDecloakOnHit', () => {
    it('decloaks on hit when the deactivates-when-hit bit is set', () => {
        const cloak = capability({ deactivatesWhenHit: true });
        expect(applyDecloakOnHit(true, cloak)).toBe(false);
    });

    it('stays cloaked on hit when the bit is clear', () => {
        const cloak = capability({ deactivatesWhenHit: false });
        expect(applyDecloakOnHit(true, cloak)).toBe(true);
    });

    it('leaves an already-decloaked ship decloaked', () => {
        const cloak = capability({ deactivatesWhenHit: true });
        expect(applyDecloakOnHit(false, cloak)).toBe(false);
    });
});

describe('cloak targeting exclusion', () => {
    it('isCloaked/isTargetable reflect the active flag', () => {
        expect(isCloaked(undefined)).toBe(false);
        expect(isCloaked({ active: false })).toBe(false);
        expect(isCloaked({ active: true })).toBe(true);
        expect(isTargetable(undefined)).toBe(true);
        expect(isTargetable({ active: true })).toBe(false);
    });

    it('getValidTargets drops cloaked ships and yourself', () => {
        const self = 'me';
        const targets: Array<readonly [string, unknown, { active: boolean } | undefined]> = [
            ['me', {}, undefined],                 // self: excluded
            ['visible', {}, undefined],            // uncloaked: included
            ['also-visible', {}, { active: false }], // has state, not cloaked
            ['ghost', {}, { active: true }],       // cloaked: excluded
        ];
        expect(getValidTargets(targets, self)).toEqual(['visible', 'also-visible']);
    });
});
