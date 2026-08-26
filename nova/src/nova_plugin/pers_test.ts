import "jasmine";
import { PersData, getDefaultPersData } from "novadatainterface/PersData";
import {
    PersFlags,
    canOfferPersMission,
    isPersEligible,
    persHoldsGrudge,
    recordPersAttack,
    recordPersDestruction,
    resolvePersCommQuote,
    resolvePersHailQuote,
    selectPers,
    shouldShowPersHailQuote,
} from "./pers";

function person(changes: Partial<PersData> = {}): PersData {
    return {
        ...getDefaultPersData(),
        id: "nova:131",
        name: "Jack Folstam",
        prefix: "nova",
        ...changes,
    };
}

describe("përs pure logic", () => {
    it("checks location, ActiveOn, and alive gates", () => {
        const jack = person({
            linkSyst: "nova:132",
            activeOn: "b42",
        });
        const context = {
            systemId: "nova:132",
            alive: new Set<string>(["nova:131"]),
            evaluateActiveOn: (expression: string) => expression === "b42",
        };

        expect(isPersEligible(jack, context)).toBeTrue();
        expect(isPersEligible(jack, {
            ...context,
            evaluateActiveOn: () => false,
        })).toBeFalse();
        expect(isPersEligible(jack, {
            ...context,
            alive: new Set(),
        })).toBeFalse();
        expect(isPersEligible(jack, {
            systemId: "nova:132",
            alive: new Set(["nova:131"]),
            ncbContext: { missionBits: new Set([42]) },
            state: {},
        })).toBeTrue();
    });

    it("matches encoded government selectors", () => {
        const governments = [
            { index: 0, allies: [1], enemies: [2] },
            { index: 1, allies: [0], enemies: [2] },
            { index: 2, allies: [], enemies: [0] },
        ];
        const context = {
            systemGovernment: 129,
            governments,
        };

        expect(isPersEligible(
            person({ linkSyst: 10001 }), context)).toBeTrue();
        expect(isPersEligible(
            person({ linkSyst: 15000 }), context)).toBeTrue();
        expect(isPersEligible(
            person({ linkSyst: 25000 }), context)).toBeFalse();
        expect(isPersEligible(
            person({ linkSyst: 20000 }), context)).toBeTrue();
    });

    it("applies the retail five-percent spawn roll", () => {
        const people = [
            person({ id: "nova:131" }),
            person({ id: "nova:132" }),
        ];

        expect(selectPers(people, {}, () => 0)?.id).toBe("nova:131");
        expect(selectPers(people, {}, () => 0.05)).toBeUndefined();
    });

    it("records grudges and removes killable people after destruction", () => {
        const grudge = person({ flags: PersFlags.holdsGrudge });
        expect(persHoldsGrudge(grudge, { grudge: false })).toBeFalse();
        const attacked = recordPersAttack(grudge, {});
        expect(attacked.grudge).toBeTrue();
        expect(persHoldsGrudge(grudge, attacked)).toBeTrue();
        expect(recordPersDestruction(grudge, attacked).alive).toBeFalse();
        expect(recordPersDestruction(
            person({ flags: PersFlags.escapePod }), attacked).alive)
            .toBeUndefined();
    });

    it("gates conditional hail quotes and linked missions", () => {
        const character = person({
            hailQuote: 4,
            linkMission: "nova:140",
            flags: PersFlags.quoteGrudge
                | PersFlags.hailOnce
                | PersFlags.linkQuote
                | PersFlags.linkNoWimpy,
        });
        expect(shouldShowPersHailQuote(character, {
            grudge: false,
            linkMissionAvailable: true,
        })).toBeFalse();
        expect(shouldShowPersHailQuote(character, {
            grudge: true,
            linkMissionAvailable: true,
            quoteShown: false,
        })).toBeTrue();
        expect(shouldShowPersHailQuote(character, {
            grudge: true,
            linkMissionAvailable: true,
            quoteShown: true,
        })).toBeFalse();
        expect(canOfferPersMission(character, {
            linkMissionAvailable: true,
            playerAiType: 1,
        })).toBeFalse();
        expect(canOfferPersMission(character, {
            linkMissionAvailable: true,
            playerAiType: 3,
        })).toBeTrue();
        expect(resolvePersCommQuote(person({ commQuote: 2 }))).toBe(2);
        expect(resolvePersHailQuote(character, {
            grudge: true,
            linkMissionAvailable: true,
        })).toBe(4);
    });
});
