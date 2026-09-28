/**
 * Debug-only resources served from nova/objects (FilesystemData). The ids use
 * their own `debug:` prefix with a non-numeric name: `sameResourceId` compares
 * the part after the colon, so a numeric name such as `debug:128` would be
 * treated as the same resource as retail `nova:128`.
 */
export const PLANET_BUSTER_WEAPON_ID = 'debug:planetbuster';
export const PLANET_BUSTER_OUTFIT_ID = 'debug:planetbuster';
