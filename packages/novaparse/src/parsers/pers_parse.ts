import { PersData, PersLinkSyst, PersWeapon } from "novadatainterface/pers_data";
import { BaseData } from "novadatainterface/base_data";
import { PersResource } from "../resource_parsers/pers_resource.js";
import { NovaResources } from "../resource_parsers/resource_holder_base.js";
import { BaseParse } from "./base_parse.js";

/**
 * Resolves a përs LinkSystem value to the discriminated PersLinkSyst
 * union, mapping the govt-relative ranges (10000/15000/20000/25000 +
 * offset, offset = govt id - 128) to global govt ids — the same shape
 * as the flët LinkSyst resolution (fleet_parse.ts). See the EVN
 * Bible's përs section.
 */
function parseLinkSyst(linkSystem: number, idSpace: NovaResources,
    persId: string): PersLinkSyst {
    if (linkSystem >= 128 && linkSystem <= 2175) {
        const syst = idSpace.sÿst[linkSystem];
        if (!syst) {
            // Soft reference (see system_parse.ts): warn and degrade.
            console.warn("Missing sÿst id " + linkSystem
                + " for përs " + persId + " LinkSyst");
            return { type: 'any' };
        }
        return { type: 'system', id: syst.globalID };
    }
    if (linkSystem === 9999) {
        return { type: 'independentSystems' };
    }
    for (const [start, type] of [
        [10000, 'govtSystems'],
        [15000, 'allySystems'],
        [20000, 'notGovtSystems'],
        [25000, 'enemySystems'],
    ] as const) {
        if (linkSystem >= start && linkSystem <= start + 255) {
            const govtId = 128 + linkSystem - start;
            const govt = idSpace.gövt[govtId];
            if (!govt) {
                console.warn("Missing gövt id " + govtId
                    + " for përs " + persId + " LinkSyst");
                return { type: 'any' };
            }
            return { type, govt: govt.globalID };
        }
    }
    // -1 (and anything unrecognized) means any system.
    return { type: 'any' };
}

/** STR# ids holding përs comm/hail quotes, per the Bible. */
const COMM_QUOTE_STRN = 7100;
const HAIL_QUOTE_STRN = 7101;

/**
 * A quote from one of the përs STR# lists. The Bible's "index number
 * of an entry" is 1-based (matching ResEdit's display); "" if unset
 * or out of range.
 */
function quote(idSpace: NovaResources, strnId: number, index: number): string {
    if (index < 1) {
        return "";
    }
    return idSpace["STR#"][strnId]?.strings[index - 1] ?? "";
}

/**
 * Maps a parsed përs resource onto the PersData shape served through
 * the data interface: local shïp/gövt/sÿst/wëap/mïsn references
 * resolve to global ids, the LinkSystem ranges resolve to a
 * discriminated union, and the comm/hail quotes resolve to their
 * strings (STR# 7100/7101).
 */
export async function PersParse(pers: PersResource,
    notFoundFunction: (m: string) => void): Promise<PersData> {
    const base: BaseData = await BaseParse(pers, notFoundFunction);

    const ship = pers.idSpace.shïp[pers.shipType];
    if (!ship) {
        // A person without a ship class cannot spawn at all.
        throw new Error("Missing shïp id " + pers.shipType
            + " for përs " + base.id);
    }

    // Weapons, the govt, and the link mission are soft references:
    // drop/degrade with a warning instead of failing the whole përs.
    const weapons: PersWeapon[] = [];
    for (const { id, count, ammo } of pers.weapons) {
        const weap = pers.idSpace.wëap[id];
        if (!weap) {
            console.warn("Missing wëap id " + id + " for përs " + base.id);
            continue;
        }
        weapons.push({ id: weap.globalID, count, ammo });
    }

    let govt: string | null = null;
    if (pers.govt >= 128) {
        const govtResource = pers.idSpace.gövt[pers.govt];
        if (govtResource) {
            govt = govtResource.globalID;
        } else {
            console.warn("Missing gövt id " + pers.govt
                + " for përs " + base.id);
        }
    }

    let linkMission: string | null = null;
    if (pers.linkMission >= 128) {
        const misn = pers.idSpace.mïsn[pers.linkMission];
        if (misn) {
            linkMission = misn.globalID;
        } else {
            console.warn("Missing mïsn id " + pers.linkMission
                + " for përs " + base.id);
        }
    }

    let hailPict: string | null = null;
    if (pers.hailPict >= 128) {
        hailPict = pers.idSpace.PICT[pers.hailPict]?.globalID ?? null;
    }

    return {
        ...base,
        linkSyst: parseLinkSyst(pers.linkSystem, pers.idSpace, base.id),
        govt,
        aiType: pers.aiType,
        aggression: pers.aggression,
        cowardice: pers.cowardice,
        ship: ship.globalID,
        weapons,
        credits: pers.credits,
        shieldMod: pers.shieldMod,
        hailPict,
        commQuote: quote(pers.idSpace, COMM_QUOTE_STRN, pers.commQuote),
        hailQuote: quote(pers.idSpace, HAIL_QUOTE_STRN, pers.hailQuote),
        linkMission,
        flags: {
            keepsGrudge: pers.keepsGrudge,
            usesEscapePodAndAfterburner: pers.usesEscapePodAndAfterburner,
            hailOnlyWithGrudge: pers.hailOnlyWithGrudge,
            hailOnlyWhenLikesPlayer: pers.hailOnlyWhenLikesPlayer,
            hailOnlyWhenAttacking: pers.hailOnlyWhenAttacking,
            hailOnlyWhenDisabled: pers.hailOnlyWhenDisabled,
            replaceWithSpecialShip: pers.replaceWithSpecialShip,
            hailOnlyOnce: pers.hailOnlyOnce,
            deactivateAfterMission: pers.deactivateAfterMission,
            offerMissionOnBoarding: pers.offerMissionOnBoarding,
            hailOnlyWhenMissionAvailable: pers.hailOnlyWhenMissionAvailable,
            leavesAfterMissionAccepted: pers.leavesAfterMissionAccepted,
            noMissionIfWimpyTrader: pers.noMissionIfWimpyTrader,
            noMissionIfBeefyTrader: pers.noMissionIfBeefyTrader,
            noMissionIfWarship: pers.noMissionIfWarship,
            showDisasterInfoWhenHailing: pers.showDisasterInfoWhenHailing,
        },
        activeOn: pers.activeOn,
        grantClass: pers.grantClass,
        grantCount: pers.grantCount,
        grantChance: pers.grantChance,
        subtitle: pers.subtitle,
        color: pers.color,
        startsWithNoFuel: pers.startsWithNoFuel,
    };
}
