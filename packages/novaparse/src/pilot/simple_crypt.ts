/**
 * Andrew Welch's "SimpleCrypt", as used by EV Nova to scramble the resource
 * data inside pilot (saved-game) files.
 *
 * The cipher is a rotating XOR over big-endian 32-bit words. The key stream
 * depends only on the seed, and every output byte is `data ^ keyByte`, so the
 * same function both encrypts and decrypts.
 *
 * Key schedule (per 4-byte word, after XORing the word with the key):
 *   if (key >= 0x21524110) key -= 0x21524111; else key += 0xDEADBEEF;
 *   key ^= 0xDEADBEEF;
 * (Note 0x21524110 = ~0xDEADBEEF, so the branch is exactly the carry-free
 * version of `key += 0xDEADBEEF`.)
 *
 * A trailing partial word (pilot resources are 2 bytes short of a word
 * boundary) is XORed with the leading bytes of the final key value.
 *
 * Sources (the algorithm was reverse engineered by the EV community):
 * - https://andrews05.github.io/evstuff/guides/pilotformat.txt
 *   ("Resource data is encrypted using Andrew Welch's SimpleCrypt algorithm
 *   with key 0xB36A210F.")
 * - https://github.com/vasi/evnova-utils Scripts/lib/Nova/Old/pilot/read.pl
 *   (simpleCrypt: the key-rotation loop this implementation mirrors.)
 * - https://opennovablog.wordpress.com/2019/05/27/player-data-the-npil-resource/
 */

/** Seed for EV Nova pilot resources ('NpïL' and Windows .plt blobs). */
export const NOVA_PILOT_CRYPT_KEY = 0xB36A210F;

/**
 * En/decrypts `data` with SimpleCrypt, returning a new Uint8Array. The
 * transform is an XOR stream, so applying it twice round-trips.
 */
export function simpleCrypt(
    data: Uint8Array, key: number = NOVA_PILOT_CRYPT_KEY): Uint8Array {
    const out = new Uint8Array(data);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    key = key >>> 0;
    const wholeWords = data.length >>> 2;
    for (let i = 0; i < wholeWords; i++) {
        // Big-endian words regardless of the container's field endianness:
        // the Windows .plt format stores little-endian *fields* but uses the
        // same big-endian key stream over the raw bytes.
        view.setUint32(i * 4, (view.getUint32(i * 4) ^ key) >>> 0);
        key = key >= 0x21524110
            ? (key - 0x21524111) >>> 0
            : (key + 0xDEADBEEF) >>> 0;
        key = (key ^ 0xDEADBEEF) >>> 0;
    }
    // Trailing bytes are XORed with the high-order bytes of the final key.
    for (let i = wholeWords * 4, shift = 24; i < data.length; i++, shift -= 8) {
        out[i] = out[i] ^ ((key >>> shift) & 0xff);
    }
    return out;
}
