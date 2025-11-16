import { getDefaultCicnData } from "./CicnData.js";
import { getDefaultCicnImageData } from "./CicnImage.js";
import { getDefaultSpriteSheetImage } from "./DefaultSpriteSheetImage.js";
import { getDefaultExplosionData } from "./ExplosionData.js";
import { getDefaultOutfitData } from "./OutiftData.js";
import { getDefaultPictData } from "./PictData.js";
import { getDefaultPictImageData } from "./PictImage.js";
import { getDefaultPlanetData } from "./PlanetData.js";
import { getDefaultShipData } from "./ShipData.js";
import { getDefaultSoundFile } from "./SoundFile.js";
import { getDefaultSpriteSheetData, getDefaultSpriteSheetFrames } from "./SpriteSheetData.js";
import { getDefaultStatusBarData } from "./StatusBarData.js";
import { getDefaultSystemData } from "./SystemData.js";
import { getDefaultTargetCornersData } from "./TargetCornersData.js";
import { getDefaultProjectileWeaponData } from "./WeaponData.js";

// Should have one for every NovaDataType
export const Defaults = {
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
