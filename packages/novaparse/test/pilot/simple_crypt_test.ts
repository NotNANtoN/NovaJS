import "jasmine";
import { simpleCrypt } from "../../src/pilot/simple_crypt.js";

function hex(bytes: Uint8Array): string {
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

describe("simpleCrypt", () => {
    it("is its own inverse", () => {
        const data = new Uint8Array(1001); // deliberately not word-aligned
        for (let i = 0; i < data.length; i++) {
            data[i] = (i * 37) & 0xff;
        }
        const roundTripped = simpleCrypt(simpleCrypt(data));
        expect(roundTripped).toEqual(data);
    });

    it("does not modify its input", () => {
        const data = new Uint8Array([1, 2, 3, 4, 5]);
        simpleCrypt(data);
        expect([...data]).toEqual([1, 2, 3, 4, 5]);
    });

    // Encrypting zeros reveals the key stream. The first word must be the
    // seed itself, and the rest pins the key schedule. The second word,
    // 0x4cba6111, is visible verbatim in real pilot files wherever the
    // plaintext word is zero (e.g. empty cargo slots at the start of NpïL
    // 128), which is how this vector was validated against EV Nova's own
    // output.
    it("matches the known EV Nova key stream", () => {
        expect(hex(simpleCrypt(new Uint8Array(10))))
            .toBe("b36a210f4cba6111f5c5");
    });

    it("handles a trailing partial word as a pure XOR", () => {
        const text = new TextEncoder().encode("Take Krane to Earth");
        expect(hex(simpleCrypt(text)))
            .toBe("e70b4a6a6cf113709ba0be9b65fea650455574");
        expect(simpleCrypt(simpleCrypt(text))).toEqual(text);
    });

    it("uses length-dependent tail bytes consistently", () => {
        // The tail is XORed with the *final* key, which depends on how many
        // whole words preceded it; two different-length buffers with the
        // same suffix therefore encrypt the suffix differently.
        const a = simpleCrypt(new Uint8Array(6));
        const b = simpleCrypt(new Uint8Array(10));
        expect(hex(a.subarray(4))).not.toBe(hex(b.subarray(8)));
    });
});
