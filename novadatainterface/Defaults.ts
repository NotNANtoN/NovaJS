import { getDefaultCicnData } from "./CicnData";
import { getDefaultCicnImageData } from "./CicnImage";
import { getDefaultDudeData } from "./DudeData";
import { getDefaultSpriteSheetImage } from "./DefaultSpriteSheetImage";
import { getDefaultExplosionData } from "./ExplosionData";
import { getDefaultGovtData } from "./GovtData";
import { getDefaultOutfitData } from "./OutiftData";
import { getDefaultPictData } from "./PictData";
import { getDefaultPictImageData } from "./PictImage";
import { getDefaultPlanetData } from "./PlanetData";
import { getDefaultMissionData } from "./MissionData";
import { getDefaultAsteroidData } from "./AsteroidData";
import { getDefaultNebulaData } from "./NebulaData";
import { getDefaultShipData } from "./ShipData";
import { getDefaultSoundFile } from "./SoundFile";
import { getDefaultSpriteSheetData, getDefaultSpriteSheetFrames } from "./SpriteSheetData";
import { getDefaultStatusBarData } from "./StatusBarData";
import { getDefaultSystemData } from "./SystemData";
import { getDefaultTargetCornersData } from "./TargetCornersData";
import { getDefaultProjectileWeaponData } from "./WeaponData";

// Should have one for every NovaDataType
export const Defaults = {
    get Ship() { return getDefaultShipData() },
    get Outfit() { return getDefaultOutfitData() },
    get Weapon() { return getDefaultProjectileWeaponData() },
    get Pict() { return getDefaultPictData() },
    get PictImage() { return getDefaultPictImageData() },
    get Cicn() { return getDefaultCicnData() },
    get CicnImage() { return getDefaultCicnImageData() },
    get Dude() { return getDefaultDudeData() },
    get Planet() { return getDefaultPlanetData() },
    get System() { return getDefaultSystemData() },
    get Mission() { return getDefaultMissionData() },
    get TargetCorners() { return getDefaultTargetCornersData() },
    get SpriteSheet() { return getDefaultSpriteSheetData() },
    get SpriteSheetImage() { return getDefaultSpriteSheetImage() },
    get SpriteSheetFrames() { return getDefaultSpriteSheetFrames() },
    get StatusBar() { return getDefaultStatusBarData() },
    get Explosion() { return getDefaultExplosionData() },
    get Govt() { return getDefaultGovtData() },
    get SoundFile() { return getDefaultSoundFile() },
    get Asteroid() { return getDefaultAsteroidData() },
    get Nebula() { return getDefaultNebulaData() },
}
