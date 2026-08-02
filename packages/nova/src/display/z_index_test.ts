import 'jasmine';
import { ZIndex } from './z_index.js';

// The layering rule Matthew's playtest asked for: a ship's weapon
// effects draw ABOVE the ship that fired them. A beam's origin is an
// exit point ON the hull, so anything at or below the ship layer has its
// first stretch clipped away by the sprite and looks like it starts in
// mid-space — worst on the biggest hulls (the Fed Carrier's ion cannons).
describe('Space container draw order', () => {
    it('draws beams above every ship, including the player s', () => {
        expect(ZIndex.BEAM).toBeGreaterThan(ZIndex.SHIP);
        expect(ZIndex.BEAM).toBeGreaterThan(ZIndex.PLAYER_SHIP);
    });

    it('draws projectiles above every ship, including the player s', () => {
        expect(ZIndex.PROJECTILE).toBeGreaterThan(ZIndex.SHIP);
        expect(ZIndex.PROJECTILE).toBeGreaterThan(ZIndex.PLAYER_SHIP);
    });

    it('keeps the player s ship above other ships', () => {
        expect(ZIndex.PLAYER_SHIP).toBeGreaterThan(ZIndex.SHIP);
    });

    it('keeps the world layers below ships and planets at the bottom', () => {
        expect(ZIndex.SHIP).toBeGreaterThan(ZIndex.ASTEROID);
        expect(ZIndex.ASTEROID).toBeGreaterThan(ZIndex.DEBRIS);
        expect(ZIndex.DEBRIS).toBeGreaterThan(ZIndex.BACKDROP);
        expect(ZIndex.PLANET).toBeLessThan(ZIndex.BACKDROP);
    });

    it('keeps the particle/explosion backdrop below ships, as before', () => {
        // Unchanged on purpose: engine trails belong under the hull that
        // emits them, and the particle system is one shared mesh, so it
        // cannot be split per effect.
        expect(ZIndex.BACKDROP).toEqual(0);
        expect(ZIndex.BACKDROP).toBeLessThan(ZIndex.SHIP);
    });

    it('keeps target/hitbox overlays on top of everything', () => {
        expect(ZIndex.OVERLAY).toBeGreaterThan(ZIndex.BEAM);
    });
});
