/**
 * The player-facing part of a resource name. Scenario authors append
 * "; developer note" annotations to many resource names — missions
 * ("Delivery to Earth; Vellos1"), ships, outfits, governments — that the
 * original game hides from players: everything from the first ';' onward,
 * plus any surrounding whitespace, is dropped for display.
 *
 * The full string is kept in the data layer (ids, lookups, save state);
 * this is applied only at DISPLAY sites (list rows, target box, tiles).
 */
export function displayName(name: string): string {
    const semicolon = name.indexOf(';');
    return (semicolon === -1 ? name : name.slice(0, semicolon)).trim();
}
