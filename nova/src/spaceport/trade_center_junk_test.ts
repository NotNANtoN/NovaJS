import "jasmine";
import { JunkData } from "novadatainterface/JunkData";
import {
    hasJunkTradeLocation,
    junkExpressionMatches,
    junkPrice,
    junkTradeOffersAt,
} from "./trade_center_junk";
import {
    cargoTons,
    createInitialPlayerState,
    getFreeSpace,
} from "../nova_plugin/player_state";
import {
    buyCommodity,
    heldCommodityTons,
} from "../nova_plugin/trade_model";

function junk(overrides: Partial<JunkData> = {}): JunkData {
    return {
        id: "nova:128",
        prefix: "nova",
        name: "Vrenna Ice Lizard Pelts",
        soldAt: ["nova:219", "nova:449"],
        boughtAt: [
            "nova:164", "nova:175", "nova:207",
            "nova:242", "nova:267", "nova:345",
        ],
        basePrice: 750,
        flags: 0,
        scanMask: 0x0800,
        lcName: "ice-lizard pelts",
        abbreviation: "Pelts",
        buyOn: "",
        sellOn: "",
        ...overrides,
    };
}

describe("junk trade offers", () => {
    it("uses SoldAt for buying and BoughtAt for selling", () => {
        expect(hasJunkTradeLocation([junk()], "nova:164")).toBeTrue();
        expect(hasJunkTradeLocation([junk()], "nova:128")).toBeFalse();
        expect(junkTradeOffersAt(
            [junk()], "nova:219", { missionBits: [] },
        )).toEqual([jasmine.objectContaining({
            commodity: "Vrenna Ice Lizard Pelts",
            price: 750,
            canBuy: true,
            canSell: false,
        })]);
        expect(junkTradeOffersAt(
            [junk()], "nova:164", { missionBits: [] },
        )).toEqual([jasmine.objectContaining({
            canBuy: false,
            canSell: true,
        })]);
    });

    it("applies BuyOn and SellOn independently", () => {
        const gated = junk({
            soldAt: ["nova:219"],
            boughtAt: ["nova:219"],
            buyOn: "b43",
            sellOn: "!b44",
        });
        expect(junkTradeOffersAt(
            [gated], "nova:219", { missionBits: [] },
        )[0]).toEqual(jasmine.objectContaining({
            canBuy: false,
            canSell: true,
        }));

        const bits: boolean[] = [];
        bits[43] = true;
        bits[44] = true;
        expect(junkTradeOffersAt(
            [gated], "nova:219", { missionBits: bits },
        )[0]).toEqual(jasmine.objectContaining({
            canBuy: true,
            canSell: false,
        }));
    });

    it("keeps the retail Durknen Girns sell market despite its BuyOn gate", () => {
        const girns = junk({
            id: "nova:149",
            name: "Durknen Girns",
            soldAt: [],
            boughtAt: ["nova:311", "nova:314", "nova:327", "nova:355"],
            basePrice: 3000,
            scanMask: 0,
            lcName: "durknen girns",
            abbreviation: "dk grns",
            buyOn: "b43",
        });

        expect(hasJunkTradeLocation([girns], "nova:311")).toBeTrue();
        expect(junkTradeOffersAt(
            [girns], "nova:311", { missionBits: [] },
        )).toEqual([jasmine.objectContaining({
            price: 3000,
            canBuy: false,
            canSell: true,
        })]);
    });

    it("uses BasePrice without an invented price tier", () => {
        expect(junkPrice(junk({ basePrice: 1200 }))).toBe(1200);
        expect(junkExpressionMatches(
            "not valid", { missionBits: [] })).toBeFalse();
    });

    it("stores junk beside standard commodities in the existing hold", () => {
        const state = createInitialPlayerState();
        state.cargoCapacity = 2;
        expect(buyCommodity(state, {
            commodity: "Food",
            priceLevel: "medium",
            price: 75,
        })).toEqual(jasmine.objectContaining({ success: true }));
        const offer = junkTradeOffersAt(
            [junk()], "nova:219", { missionBits: [] })[0]!;
        expect(buyCommodity(state, {
            ...offer,
            commodity: offer.cargoKey,
        } as any)).toEqual(jasmine.objectContaining({ success: true }));

        expect(heldCommodityTons(state, "Food")).toBe(1);
        expect(heldCommodityTons(
            state, "ice-lizard pelts")).toBe(1);
        expect(cargoTons(state)).toBe(2);
        expect(getFreeSpace(state)).toBe(0);
    });
});
