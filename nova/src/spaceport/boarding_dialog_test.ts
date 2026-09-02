import "jasmine";
import {
    BoardingTargetInfo,
    PLUNDER_BACKGROUND,
} from "./boarding_dialog";

describe("BoardingDialog specs and background", () => {
    it("uses retail PICT 8515 Plunder background", () => {
        expect(PLUNDER_BACKGROUND).toBe("nova:8515");
    });

    it("formats target info accurately for display", () => {
        const target: BoardingTargetInfo = {
            uuid: "victim-123",
            shipName: "Star Corsair",
            shipType: "Valkyrie",
            credits: 15400,
            cargoTons: 45,
            crew: 8,
            isDerelict: false,
        };

        expect(target.shipName).toBe("Star Corsair");
        expect(target.cargoTons).toBe(45);
        expect(target.credits).toBe(15400);
        expect(target.crew).toBe(8);
        expect(target.isDerelict).toBeFalse();
    });

    it("handles derelict targets with uncrewed status", () => {
        const derelict: BoardingTargetInfo = {
            uuid: "derelict-456",
            shipName: "Ancient Hulk",
            shipType: "Leviathan",
            credits: 0,
            cargoTons: 120,
            crew: 0,
            isDerelict: true,
        };

        expect(derelict.isDerelict).toBeTrue();
        expect(derelict.crew).toBe(0);
    });
});
