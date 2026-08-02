/**
 * Draw order inside the `Space` container (which has
 * `sortableChildren = true`, so children sort by `zIndex`; equal zIndex
 * keeps insertion order).
 *
 * The rule the layers encode: **weapon effects draw ABOVE every ship,
 * including the player's own.** A beam or a shot leaving a big hull —
 * the Fed Carrier's ion cannons are the worst case — has its origin
 * inside the sprite's bounding box, so anything drawn below the ship
 * layer gets its first tens of pixels clipped away by the hull and the
 * beam appears to start in mid-space.
 *
 * Everything not listed keeps PIXI's default zIndex of 0 (`BACKDROP`):
 * the GPU particle mesh (engine trails, hit sparks, asteroid dust) and
 * explosion graphics. That leaves them below the ships, which is where
 * they have always been — trails belong under the hull that emits them,
 * and moving the shared particle mesh would reorder every effect at
 * once.
 */
export const ZIndex = {
    /** Planets and stellar objects, under everything. */
    PLANET: -10,
    /** Particle mesh, explosions, planet corners: PIXI's default. */
    BACKDROP: 0,
    DEBRIS: 6,
    ASTEROID: 7,
    SHIP: 8,
    /** The local player's ship, above other ships. */
    PLAYER_SHIP: 10,
    /** Projectiles: above every ship (see the module comment). */
    PROJECTILE: 20,
    /** Beams: above projectiles, since a beam is drawn as one long line
     * from the firing ship to whatever it hits. */
    BEAM: 25,
    /** Target/hitbox overlays that must sit on top of the whole scene. */
    OVERLAY: 1000,
} as const;
