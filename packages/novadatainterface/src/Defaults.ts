import { getDefaultAsteroidData } from "./asteroid_data.js";
import { getDefaultCicnData } from "./cicn_data.js";
import { getDefaultCicnImageData } from "./cicn_image.js";
import { getDefaultSpriteSheetImage } from "./default_sprite_sheet_image.js";
import { getDefaultExplosionData } from "./explosion_data.js";
import { getDefaultOutfitData } from "./outfit_data.js";
import { getDefaultPictData } from "./pict_data.js";
import { getDefaultPictImageData } from "./pict_image.js";
import { getDefaultPlanetData } from "./planet_data.js";
import { getDefaultShipData } from "./ship_data.js";
import { getDefaultSoundFile } from "./sound_file.js";
import { getDefaultSpriteSheetData, getDefaultSpriteSheetFrames } from "./sprite_sheet_data.js";
import { getDefaultStatusBarData } from "./status_bar_data.js";
import { getDefaultSystemData } from "./system_data.js";
import { getDefaultTargetCornersData } from "./target_corners_data.js";
import { getDefaultProjectileWeaponData } from "./weapon_data.js";

// Should have one for every NovaDataType
export const Defaults = {
    get Asteroid() { return getDefaultAsteroidData() },
    get Ship() { return getDefaultShipData() },
    get Outfit() { return getDefaultOutfitData() },
    get Weapon() { return getDefaultProjectileWeaponData() },
    get Pict() { return getDefaultPictData() },
    get PictImage() { return getDefaultPictImageData() },
    get Cicn() { return getDefaultCicnData() },
    get CicnImage() { return getDefaultCicnImageData() },
    get Planet() { return getDefaultPlanetData() },
    get System() { return getDefaultSystemData() },
    get TargetCorners() { return getDefaultTargetCornersData() },
    get SpriteSheet() { return getDefaultSpriteSheetData() },
    get SpriteSheetImage() { return getDefaultSpriteSheetImage() },
    get SpriteSheetFrames() { return getDefaultSpriteSheetFrames() },
    get StatusBar() { return getDefaultStatusBarData() },
    get Explosion() { return getDefaultExplosionData() },
    get SoundFile() { return getDefaultSoundFile() },
}
