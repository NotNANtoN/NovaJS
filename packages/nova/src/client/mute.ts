/**
 * A `?mute` query parameter silences ALL client audio — the title
 * music and every snd played through the pixi sound layer. Meant for
 * preview panels, the visual-compare harness, tests, and any other
 * automated load where autoplaying the title theme (or battle sfx)
 * is unwanted. `?mute=0` / `?mute=false` are treated as unmuted.
 */
export function isMuted(): boolean {
    const value = new URLSearchParams(window.location.search).get('mute');
    return value !== null && value !== '0' && value !== 'false';
}
