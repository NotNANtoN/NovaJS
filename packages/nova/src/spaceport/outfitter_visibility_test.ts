import 'jasmine';
import { getDefaultOutfitData, OutfitData } from 'novadatainterface/outfit_data';
import { getDefaultShipData, ShipData } from 'novadatainterface/ship_data';
import {
    availableForSale,
    buysBackOutfit,
    canBuyOutfit,
    canSellOutfit,
    compareOutfitIds,
    meetsTechLevel,
    OutfitterContext,
    OutfitterStellar,
    visibleOutfits,
} from './outfitter_rules.js';

/**
 * Specs for the outfitter's VISIBILITY rules (what the grid shows), as
 * distinct from its purchasability rules (which of those render greyed).
 * The EVN Bible treats these as separate gates: some outfits appear but
 * cannot be bought, others never appear at all.
 *
 * Rules covered: the tech level / SpecialTech stock test (~:1794, ~:2765),
 * the Availability default of "shown but unpurchasable" (~:1999), the
 * 0x4000 and 0x0100 hide-flags with their "already has at least one"
 * carve-outs (~:1988, ~:1974), the 0x0800 sell-anywhere flag (~:1980), the
 * 0x1000 equal-DispWeight exclusion (~:1983), and the spöb Flags2 0x0400
 * buys-anything flag (~:2862).
 */

function makeOutfit(id: string, outfit: Partial<OutfitData> = {}): OutfitData {
    return {
        ...getDefaultOutfitData(), id, ...outfit,
        physics: { freeMass: 0 },
    };
}

function makeShip(): ShipData {
    const ship = getDefaultShipData();
    ship.physics = { ...ship.physics, freeMass: 1000 };
    return ship;
}

function stellar(tech: number, special: number[] = [],
    buysAnyOutfit = false): OutfitterStellar {
    return { techLevel: tech, specialTech: special, buysAnyOutfit };
}

function makeContext({ outfits, owned, bits, deployed, planet }: {
    outfits?: OutfitData[],
    owned?: [string, number][],
    bits?: number[],
    deployed?: [string, number][],
    planet?: OutfitterStellar,
} = {}): OutfitterContext {
    const outfitMap = new Map((outfits ?? []).map(o => [o.id, o]));
    return {
        shipData: makeShip(),
        outfits: new Map(owned ?? []),
        getOutfit: id => outfitMap.get(id),
        getWeapon: () => undefined,
        bits: new Set(bits ?? []),
        credits: Infinity,
        ...(deployed ? { deployedCounts: new Map(deployed) } : {}),
        ...(planet ? { planet } : {}),
    };
}

/** The ids visibleOutfits admits, in the order it returns them. */
function visibleIds(outfits: OutfitData[],
    context: OutfitterContext): string[] {
    return visibleOutfits(outfits, context).map(o => o.id);
}

describe('meetsTechLevel', () => {
    it('stocks anything at or below the stellar tech level', () => {
        expect(meetsTechLevel(5, stellar(7))).toBeTrue();
        expect(meetsTechLevel(7, stellar(7))).toBeTrue();
    });

    it('does not stock anything above it', () => {
        expect(meetsTechLevel(8, stellar(7))).toBeFalse();
    });

    it('stocks an EXACT SpecialTech match, however far above', () => {
        // The low-tech-world-with-exotica case: Snowmelt is tech 2 but its
        // SpecialTech 81 carries the tech-81 "Map; Fed/Pol".
        expect(meetsTechLevel(81, stellar(2, [81]))).toBeTrue();
    });

    it('does NOT treat SpecialTech as a second at-or-below threshold', () => {
        // Only exact matches: 80 is below the SpecialTech 81 but is not it.
        expect(meetsTechLevel(80, stellar(2, [81]))).toBeFalse();
        expect(meetsTechLevel(82, stellar(2, [81]))).toBeFalse();
    });

    it('honors the absurd-TechLevel idiom the Bible describes', () => {
        // An item flagged 15000 appears only where a stellar names 15000.
        expect(meetsTechLevel(15000, stellar(7))).toBeFalse();
        expect(meetsTechLevel(15000, stellar(0, [15000]))).toBeTrue();
    });

    it('matches any of the eight slots', () => {
        const eight = stellar(1, [32, 55, 56, 57, 58, 81, 100, 111]);
        expect(meetsTechLevel(111, eight)).toBeTrue();
        expect(meetsTechLevel(58, eight)).toBeTrue();
        expect(meetsTechLevel(59, eight)).toBeFalse();
    });
});

describe('visibleOutfits tech gate', () => {
    it('shows only what the stellar stocks', () => {
        const outfits = [
            makeOutfit('nova:128', { techLevel: 1 }),
            makeOutfit('nova:129', { techLevel: 5 }),
            makeOutfit('nova:130', { techLevel: 9 }),
        ];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5),
        }))).toEqual(['nova:128', 'nova:129']);
    });

    it('adds exact SpecialTech matches to the stocked set', () => {
        const outfits = [
            makeOutfit('nova:128', { techLevel: 1 }),
            makeOutfit('nova:129', { techLevel: 81 }),
            makeOutfit('nova:130', { techLevel: 80 }),
        ];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(2, [81]),
        }))).toEqual(['nova:128', 'nova:129']);
    });

    it('shows everything when there is no stellar context', () => {
        const outfits = [
            makeOutfit('nova:128', { techLevel: 1 }),
            makeOutfit('nova:129', { techLevel: 9999 }),
        ];
        expect(visibleIds(outfits, makeContext({ outfits })))
            .toEqual(['nova:128', 'nova:129']);
    });
});

describe('visibleOutfits Availability handling', () => {
    // Bible ~:1999: without 0x4000 an unavailable item still APPEARS; it
    // just can't be bought. That greying is canBuyOutfit's job.
    const unavailable = { availability: 'b100' };

    it('shows an unavailable item by default (greyed, not hidden)', () => {
        const outfits = [makeOutfit('nova:128',
            { techLevel: 1, ...unavailable })];
        const context = makeContext({ outfits, planet: stellar(5) });
        expect(visibleIds(outfits, context)).toEqual(['nova:128']);

        const check = canBuyOutfit(outfits[0], context);
        expect(check.allowed).toBeFalse();
        expect(check.allowed === false && check.reason).toBe('availability');
    });

    it('hides an unavailable 0x4000 item', () => {
        const outfits = [makeOutfit('nova:128', {
            techLevel: 1, hideUnlessAvailable: true, ...unavailable,
        })];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5),
        }))).toEqual([]);
    });

    it('shows a 0x4000 item once its Availability passes', () => {
        const outfits = [makeOutfit('nova:128', {
            techLevel: 1, hideUnlessAvailable: true, ...unavailable,
        })];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5), bits: [100],
        }))).toEqual(['nova:128']);
    });

    it('shows an unavailable 0x4000 item the player already has one of',
        () => {
            const outfits = [makeOutfit('nova:128', {
                techLevel: 1, hideUnlessAvailable: true, ...unavailable,
            })];
            expect(visibleIds(outfits, makeContext({
                outfits, planet: stellar(5), owned: [['nova:128', 1]],
            }))).toEqual(['nova:128']);
        });

    it('counts DEPLOYED units towards the already-has-one carve-out', () => {
        // A carrier that landed with its whole fighter complement out still
        // owns those fighters; the bay must not vanish from the outfitter.
        const outfits = [makeOutfit('nova:128', {
            techLevel: 1, hideUnlessAvailable: true, ...unavailable,
        })];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5), deployed: [['nova:128', 2]],
        }))).toEqual(['nova:128']);
    });
});

describe('visibleOutfits 0x0100 requirements gate', () => {
    const gated = {
        techLevel: 1, hideUnlessRequirementsMet: true, require: '0x4',
    };

    it('hides the item when the Require bits are unmet', () => {
        const outfits = [makeOutfit('nova:128', gated)];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5),
        }))).toEqual([]);
    });

    it('shows it once another owned outfit Contributes the bits', () => {
        const outfits = [
            makeOutfit('nova:128', gated),
            makeOutfit('nova:129', { techLevel: 1, contribute: '0x4' }),
        ];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5), owned: [['nova:129', 1]],
        }))).toEqual(['nova:128', 'nova:129']);
    });

    it('shows it when the player already has one despite unmet bits', () => {
        const outfits = [makeOutfit('nova:128', gated)];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5), owned: [['nova:128', 1]],
        }))).toEqual(['nova:128']);
    });

    it('still refuses to SELL it a second one (visible != purchasable)',
        () => {
            const outfits = [makeOutfit('nova:128', gated)];
            const context = makeContext({
                outfits, planet: stellar(5), owned: [['nova:128', 1]],
            });
            const check = canBuyOutfit(outfits[0], context);
            expect(check.allowed).toBeFalse();
            expect(check.allowed === false && check.reason).toBe('require');
        });

    it('without the flag, unmet requirements only grey the item', () => {
        const outfits = [makeOutfit('nova:128',
            { techLevel: 1, require: '0x4' })];
        const context = makeContext({ outfits, planet: stellar(5) });
        expect(visibleIds(outfits, context)).toEqual(['nova:128']);
        expect(canBuyOutfit(outfits[0], context).allowed).toBeFalse();
    });

    it('the tech gate still applies to an otherwise-qualifying item', () => {
        // Owning one carves out the 0x0100 hide, but not the stock rule:
        // a world that doesn't deal in it still won't display it for sale.
        const outfits = [makeOutfit('nova:128',
            { ...gated, techLevel: 9, cantSell: true })];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5), owned: [['nova:128', 1]],
        }))).toEqual([]);
    });
});

describe('compareOutfitIds', () => {
    it('orders by the numeric resource id, not lexically', () => {
        // "nova:9" would sort after "nova:10" under a string compare.
        expect(compareOutfitIds('nova:9', 'nova:10')).toBeLessThan(0);
        expect(compareOutfitIds('nova:130', 'nova:129')).toBeGreaterThan(0);
        expect(compareOutfitIds('nova:128', 'nova:128')).toBe(0);
    });

    it('compares across prefixes by number first (one flat id space)', () => {
        expect(compareOutfitIds('plugin:130', 'nova:200')).toBeLessThan(0);
    });

    it('breaks numeric ties with the prefix, for a total order', () => {
        expect(compareOutfitIds('a:128', 'b:128')).toBeLessThan(0);
    });
});

describe('visibleOutfits 0x1000 equal-DispWeight exclusion', () => {
    const excluder = (id: string, rest: Partial<OutfitData> = {}) =>
        makeOutfit(id, {
            techLevel: 1, displayWeight: 24,
            excludesEqualDisplayWeight: true, ...rest,
        });

    it('suppresses higher-numbered items of equal DispWeight', () => {
        const outfits = [
            excluder('nova:128'),
            makeOutfit('nova:129', { techLevel: 1, displayWeight: 24 }),
            makeOutfit('nova:130', { techLevel: 1, displayWeight: 24 }),
        ];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5),
        }))).toEqual(['nova:128']);
    });

    it('leaves LOWER-numbered items of equal DispWeight alone', () => {
        // This is the stock configuration: every stock 0x1000 outfit is the
        // highest-numbered at its DispWeight, so it suppresses nothing.
        const outfits = [
            makeOutfit('nova:128', { techLevel: 1, displayWeight: 24 }),
            excluder('nova:130'),
        ];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5),
        }))).toEqual(['nova:128', 'nova:130']);
    });

    it('leaves items with a DIFFERENT DispWeight alone', () => {
        const outfits = [
            excluder('nova:128'),
            makeOutfit('nova:129', { techLevel: 1, displayWeight: 23 }),
        ];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5),
        }))).toEqual(['nova:128', 'nova:129']);
    });

    it('does not suppress when the excluder is not itself for sale', () => {
        // "When this item is available for sale, it prevents..." — an
        // excluder whose own Availability fails offers nothing, so the
        // items behind it must remain.
        const outfits = [
            excluder('nova:128', { availability: 'b100' }),
            makeOutfit('nova:129', { techLevel: 1, displayWeight: 24 }),
        ];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5),
        }))).toEqual(['nova:128', 'nova:129']);
    });

    it('does not suppress when the excluder is out of the stellar stock',
        () => {
            const outfits = [
                excluder('nova:128', { techLevel: 9 }),
                makeOutfit('nova:129', { techLevel: 1, displayWeight: 24 }),
            ];
            expect(visibleIds(outfits, makeContext({
                outfits, planet: stellar(5),
            }))).toEqual(['nova:129']);
        });

    it('does not let a merely-OWNED excluder suppress anything', () => {
        // Visible only through the already-has-one carve-out, so it is not
        // being offered for sale and must not exclude.
        const outfits = [
            excluder('nova:128', {
                hideUnlessAvailable: true, availability: 'b100',
            }),
            makeOutfit('nova:129', { techLevel: 1, displayWeight: 24 }),
        ];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5), owned: [['nova:128', 1]],
        }))).toEqual(['nova:128', 'nova:129']);
    });

    it('still shows a suppressed item the player OWNS, so it can be sold',
        () => {
            const outfits = [
                excluder('nova:128'),
                makeOutfit('nova:129', { techLevel: 1, displayWeight: 24 }),
            ];
            const context = makeContext({
                outfits, planet: stellar(5), owned: [['nova:129', 1]],
            });
            expect(visibleIds(outfits, context))
                .toEqual(['nova:128', 'nova:129']);
            expect(canSellOutfit(outfits[1], context).allowed).toBeTrue();
        });

    it('applies transitively from several excluders', () => {
        const outfits = [
            excluder('nova:128'),
            excluder('nova:129', { displayWeight: 10 }),
            makeOutfit('nova:130', { techLevel: 1, displayWeight: 24 }),
            makeOutfit('nova:131', { techLevel: 1, displayWeight: 10 }),
        ];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5),
        }))).toEqual(['nova:128', 'nova:129']);
    });

    it('lets an excluder suppress another excluder', () => {
        const outfits = [excluder('nova:128'), excluder('nova:129')];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5),
        }))).toEqual(['nova:128']);
    });
});

describe('availableForSale', () => {
    it('is false for an item the stellar does not stock', () => {
        const outfit = makeOutfit('nova:128', { techLevel: 9 });
        expect(availableForSale(outfit, makeContext({
            outfits: [outfit], planet: stellar(5),
        }))).toBeFalse();
    });

    it('is false when Availability fails, flag or no flag', () => {
        const outfit = makeOutfit('nova:128',
            { techLevel: 1, availability: 'b100' });
        expect(availableForSale(outfit, makeContext({
            outfits: [outfit], planet: stellar(5),
        }))).toBeFalse();
    });

    it('ignores the player\'s wallet and free mass', () => {
        // Stock is a property of the shop, not of the customer: a full hold
        // must not change WHICH items the outfitter displays.
        const outfit = makeOutfit('nova:128', { techLevel: 1, price: 10 });
        const context = { ...makeContext({ outfits: [outfit],
            planet: stellar(5) }), credits: 0 };
        expect(availableForSale(outfit, context)).toBeTrue();
        expect(canBuyOutfit(outfit, context).allowed).toBeFalse();
    });
});

describe('buysBackOutfit and the sell gate', () => {
    it('buys back what it stocks', () => {
        const outfit = makeOutfit('nova:128', { techLevel: 1 });
        expect(buysBackOutfit(outfit, stellar(5))).toBeTrue();
    });

    it('refuses what it does not stock', () => {
        const outfit = makeOutfit('nova:128', { techLevel: 9 });
        expect(buysBackOutfit(outfit, stellar(5))).toBeFalse();
    });

    it('buys a 0x0800 sell-anywhere item regardless of tech level', () => {
        const outfit = makeOutfit('nova:128',
            { techLevel: 9999, sellAnywhere: true });
        expect(buysBackOutfit(outfit, stellar(0))).toBeTrue();
    });

    it('buys anything at a 0x0400 stellar', () => {
        const outfit = makeOutfit('nova:128', { techLevel: 9999 });
        expect(buysBackOutfit(outfit, stellar(0, [], true))).toBeTrue();
    });

    it('never buys a cantSell item, even at a 0x0400 stellar', () => {
        // "nonpermanent" is read as "not flagged can't-sell (0x0008)".
        const outfit = makeOutfit('nova:128',
            { techLevel: 1, cantSell: true });
        expect(buysBackOutfit(outfit, stellar(5))).toBeFalse();
        expect(buysBackOutfit(outfit, stellar(5, [], true))).toBeFalse();
    });

    it('never buys a cantSell item even with 0x0800 set', () => {
        const outfit = makeOutfit('nova:128',
            { techLevel: 1, cantSell: true, sellAnywhere: true });
        expect(buysBackOutfit(outfit, stellar(5))).toBeFalse();
    });

    it('denies the sale of an out-of-stock owned outfit', () => {
        const outfit = makeOutfit('nova:128', { techLevel: 9 });
        const check = canSellOutfit(outfit, makeContext({
            outfits: [outfit], planet: stellar(5), owned: [['nova:128', 1]],
        }));
        expect(check.allowed).toBeFalse();
        expect(check.allowed === false && check.reason).toBe('notStocked');
    });

    it('allows it once the outfit is 0x0800', () => {
        const outfit = makeOutfit('nova:128',
            { techLevel: 9, sellAnywhere: true });
        expect(canSellOutfit(outfit, makeContext({
            outfits: [outfit], planet: stellar(5), owned: [['nova:128', 1]],
        })).allowed).toBeTrue();
    });

    it('allows it at a 0x0400 stellar', () => {
        const outfit = makeOutfit('nova:128', { techLevel: 9 });
        expect(canSellOutfit(outfit, makeContext({
            outfits: [outfit], planet: stellar(5, [], true),
            owned: [['nova:128', 1]],
        })).allowed).toBeTrue();
    });

    it('keeps the old behaviour when there is no stellar context', () => {
        const outfit = makeOutfit('nova:128', { techLevel: 9999 });
        expect(canSellOutfit(outfit, makeContext({
            outfits: [outfit], owned: [['nova:128', 1]],
        })).allowed).toBeTrue();
    });

    it('will not sell a DEPLOYED unit (it is not aboard to hand over)', () => {
        const outfit = makeOutfit('nova:128', { techLevel: 1 });
        const check = canSellOutfit(outfit, makeContext({
            outfits: [outfit], planet: stellar(5),
            deployed: [['nova:128', 2]],
        }));
        expect(check.allowed).toBeFalse();
        expect(check.allowed === false && check.reason).toBe('notOwned');
    });
});

describe('canBuyOutfit stocking gate', () => {
    it('refuses to sell an item this stellar does not stock', () => {
        // Reachable in the UI only for an owned item shown so it can be
        // sold: without this check the Buy button would happily sell a
        // tech-9999 outfit at a tech-0 world that merely buys anything.
        const outfit = makeOutfit('nova:128', { techLevel: 9999 });
        const check = canBuyOutfit(outfit, makeContext({
            outfits: [outfit], planet: stellar(0, [], true),
            owned: [['nova:128', 1]],
        }));
        expect(check.allowed).toBeFalse();
        expect(check.allowed === false && check.reason).toBe('notStocked');
    });

    it('allows a stocked item through to the other checks', () => {
        const outfit = makeOutfit('nova:128', { techLevel: 1 });
        expect(canBuyOutfit(outfit, makeContext({
            outfits: [outfit], planet: stellar(5),
        })).allowed).toBeTrue();
    });

    it('allows a SpecialTech item to be bought', () => {
        const outfit = makeOutfit('nova:128', { techLevel: 81 });
        expect(canBuyOutfit(outfit, makeContext({
            outfits: [outfit], planet: stellar(2, [81]),
        })).allowed).toBeTrue();
    });

    it('does not gate on stock when there is no stellar context', () => {
        const outfit = makeOutfit('nova:128', { techLevel: 9999 });
        expect(canBuyOutfit(outfit, makeContext({ outfits: [outfit] }))
            .allowed).toBeTrue();
    });
});

describe('0x0800 sells anywhere, regardless of anything', () => {
    /**
     * The Bible-literal guarantee (~:1980): a 0x0800 item can be sold
     * "regardless of tech level, requirements, or mission bits". This is
     * what makes mission-granted junk (used-up carbon fiber and friends)
     * dumpable — it is handed to the player to be sold, often long after
     * the bit that granted it cleared, at a world that would never stock
     * it.
     */
    const junk = makeOutfit('nova:128', {
        techLevel: 9999,        // no stellar in the game stocks this
        sellAnywhere: true,
        availability: 'b100',   // mission bit, never set below
        require: '0x4',         // Require bits the player cannot meet
        hideUnlessAvailable: true,
        hideUnlessRequirementsMet: true,
    });

    /** Every shape of stellar an outfitter can have. */
    const everyStellar: [string, OutfitterStellar][] = [
        ['a tech-0 backwater', stellar(0)],
        ['the highest-tech stock world', stellar(7)],
        ['a SpecialTech world', stellar(2, [81])],
        ['a buys-anything world', stellar(0, [], true)],
    ];

    for (const [label, planet] of everyStellar) {
        it(`is sellable at ${label}`, () => {
            const context = makeContext({
                outfits: [junk], planet, owned: [['nova:128', 1]],
            });
            expect(canSellOutfit(junk, context).allowed).toBeTrue();
        });

        it(`is visible at ${label}`, () => {
            const context = makeContext({
                outfits: [junk], planet, owned: [['nova:128', 1]],
            });
            expect(visibleIds([junk], context)).toEqual(['nova:128']);
        });
    }

    it('still cannot be BOUGHT there (selling is the only affordance)', () => {
        const context = makeContext({
            outfits: [junk], planet: stellar(0), owned: [['nova:128', 1]],
        });
        expect(canBuyOutfit(junk, context).allowed).toBeFalse();
    });

    it('is hidden and unsellable without the flag, all else equal', () => {
        // The contrast case: identical item minus 0x0800 is stuck aboard.
        const stuck = makeOutfit('nova:129',
            { ...junk, id: 'nova:129', sellAnywhere: false });
        const context = makeContext({
            outfits: [stuck], planet: stellar(0), owned: [['nova:129', 1]],
        });
        const check = canSellOutfit(stuck, context);
        expect(check.allowed).toBeFalse();
        // Specifically because the shop won't take it — not because the
        // test forgot to give the player one.
        expect(check.allowed === false && check.reason).toBe('notStocked');
        expect(visibleIds([stuck], context)).toEqual([]);
    });

    it('does not let 0x0800 override cantSell', () => {
        const unsellable = makeOutfit('nova:130',
            { ...junk, id: 'nova:130', cantSell: true });
        const context = makeContext({
            outfits: [unsellable], planet: stellar(0),
            owned: [['nova:130', 1]],
        });
        const check = canSellOutfit(unsellable, context);
        expect(check.allowed).toBeFalse();
        expect(check.allowed === false && check.reason).toBe('cantSell');
    });
});

describe('visibleOutfits owned-item visibility', () => {
    it('shows an owned out-of-stock item when the stellar buys anything',
        () => {
            const outfits = [makeOutfit('nova:128', { techLevel: 9999 })];
            expect(visibleIds(outfits, makeContext({
                outfits, planet: stellar(2, [], true),
                owned: [['nova:128', 1]],
            }))).toEqual(['nova:128']);
        });

    it('shows an owned out-of-stock 0x0800 item anywhere', () => {
        const outfits = [makeOutfit('nova:128',
            { techLevel: 9999, sellAnywhere: true })];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(2), owned: [['nova:128', 1]],
        }))).toEqual(['nova:128']);
    });

    it('hides an owned item this shop will neither sell nor buy', () => {
        // Nothing the player could do with it here, so it is left out.
        const outfits = [makeOutfit('nova:128', { techLevel: 9999 })];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(2), owned: [['nova:128', 1]],
        }))).toEqual([]);
    });

    it('hides an owned cantSell item the stellar does not stock', () => {
        const outfits = [makeOutfit('nova:128',
            { techLevel: 9999, cantSell: true })];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(2, [], true),
            owned: [['nova:128', 1]],
        }))).toEqual([]);
    });

    it('shows an owned in-stock cantSell item (it is stocked here)', () => {
        const outfits = [makeOutfit('nova:128',
            { techLevel: 1, cantSell: true })];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5), owned: [['nova:128', 1]],
        }))).toEqual(['nova:128']);
    });
});

describe('visibleOutfits ordering', () => {
    it('sorts by DispWeight descending (higher weights nearer the top)', () => {
        const outfits = [
            makeOutfit('nova:128', { techLevel: 1, displayWeight: 5 }),
            makeOutfit('nova:129', { techLevel: 1, displayWeight: 99 }),
            makeOutfit('nova:130', { techLevel: 1, displayWeight: 50 }),
        ];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5),
        }))).toEqual(['nova:129', 'nova:130', 'nova:128']);
    });

    it('breaks DispWeight ties by ascending resource id', () => {
        const outfits = [
            makeOutfit('nova:130', { techLevel: 1, displayWeight: 16 }),
            makeOutfit('nova:9', { techLevel: 1, displayWeight: 16 }),
            makeOutfit('nova:128', { techLevel: 1, displayWeight: 16 }),
        ];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5),
        }))).toEqual(['nova:9', 'nova:128', 'nova:130']);
    });

    it('is independent of the input order', () => {
        const build = () => [
            makeOutfit('nova:128', { techLevel: 1, displayWeight: 16 }),
            makeOutfit('nova:129', { techLevel: 1, displayWeight: 20 }),
        ];
        const forward = build();
        const backward = build().reverse();
        expect(visibleIds(forward, makeContext({
            outfits: forward, planet: stellar(5),
        }))).toEqual(visibleIds(backward, makeContext({
            outfits: backward, planet: stellar(5),
        })));
    });
});

describe('visibleOutfits rule interactions', () => {
    it('applies the tech gate before the hide-flag carve-outs', () => {
        const outfits = [
            makeOutfit('nova:128', {
                techLevel: 9, hideUnlessAvailable: true,
                availability: 'b100', cantSell: true,
            }),
        ];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5), owned: [['nova:128', 1]],
        }))).toEqual([]);
    });

    it('hides an item failing 0x0100 even when 0x4000 would pass', () => {
        const outfits = [makeOutfit('nova:128', {
            techLevel: 1, hideUnlessRequirementsMet: true, require: '0x4',
            hideUnlessAvailable: true,
        })];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(5),
        }))).toEqual([]);
    });

    it('lets a SpecialTech item be hidden by 0x4000 all the same', () => {
        const outfits = [makeOutfit('nova:128', {
            techLevel: 81, hideUnlessAvailable: true, availability: 'b100',
        })];
        expect(visibleIds(outfits, makeContext({
            outfits, planet: stellar(2, [81]),
        }))).toEqual([]);
    });

    it('handles the Sirrusa shape: stocks nothing, buys everything', () => {
        // spöb 156 Sirrusa: techLevel 0, no SpecialTech, Flags2 0x0400.
        const sirrusa = stellar(0, [], true);
        const outfits = [
            makeOutfit('nova:128', { techLevel: 5 }),
            makeOutfit('nova:129', { techLevel: 5 }),
        ];
        // Owning one of them makes exactly that one appear, to be sold.
        expect(visibleIds(outfits, makeContext({
            outfits, planet: sirrusa, owned: [['nova:129', 1]],
        }))).toEqual(['nova:129']);
        // And with an empty hold the shop is bare.
        expect(visibleIds(outfits, makeContext({
            outfits, planet: sirrusa,
        }))).toEqual([]);
    });
});
