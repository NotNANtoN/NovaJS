import "jasmine";
import { displayName } from "./displayName";

describe("displayName", () => {
    it("keeps a plain name", () => {
        expect(displayName("Shuttle")).toBe("Shuttle");
    });

    it("strips an annotation after a semicolon", () => {
        expect(displayName("Shuttle;economy at work"))
            .toBe("Shuttle");
        expect(displayName("Lightning; Wild Geese"))
            .toBe("Lightning");
    });

    it("falls back to the raw name when the parsed name is empty", () => {
        expect(displayName(";foo")).toBe(";foo");
    });

    it("strips everything after the first semicolon", () => {
        expect(displayName("Zephyr;Cloaking+fast jump;alternate"))
            .toBe("Zephyr");
    });
});
