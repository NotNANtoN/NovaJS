import { CicnData } from "./CicnData.js";
import { CicnImageData } from "./CicnImage.js";
import { ExplosionData } from "./ExplosionData.js";
import { Gettable } from "./Gettable.js";
import { OutfitData } from "./OutiftData.js";
import { PictData } from "./PictData.js";
import { PictImageData } from "./PictImage.js";
import { PlanetData } from "./PlanetData.js";
import { ShipData } from "./ShipData.js";
import { SoundFile } from "./SoundFile.js";
import { SpriteSheetData, SpriteSheetFramesData, SpriteSheetImageData } from "./SpriteSheetData.js";
import { StatusBarData } from "./StatusBarData.js";
import { SystemData } from "./SystemData.js";
import { TargetCornersData } from "./TargetCornersData.js";
import { WeaponData } from "./WeaponData.js";


enum NovaDataType {
    Ship = "Ship",
    Outfit = "Outfit",
    Weapon = "Weapon",
    Pict = "Pict",
    PictImage = "PictImage",
    Cicn = "Cicn",
    CicnImage = "CicnImage",
    Planet = "Planet",
    System = "System",
    TargetCorners = "TargetCorners",
    SpriteSheet = "SpriteSheet",
    SpriteSheetImage = "SpriteSheetImage",
    SpriteSheetFrames = "SpriteSheetFrames",
    StatusBar = "StatusBar",
    Explosion = "Explosion",
    SoundFile = "SoundFile",
};

// index: NovaDataType
type NovaDataInterface = {
    Ship: Gettable<ShipData>,
    Outfit: Gettable<OutfitData>,
    Weapon: Gettable<WeaponData>,
    Pict: Gettable<PictData>,
    PictImage: Gettable<PictImageData>,
    Cicn: Gettable<CicnData>,
    CicnImage: Gettable<CicnImageData>,
    Planet: Gettable<PlanetData>,
    System: Gettable<SystemData>,
    TargetCorners: Gettable<TargetCornersData>,
    SpriteSheet: Gettable<SpriteSheetData>,
    SpriteSheetImage: Gettable<SpriteSheetImageData>,
    SpriteSheetFrames: Gettable<SpriteSheetFramesData>,
    StatusBar: Gettable<StatusBarData>,
    Explosion: Gettable<ExplosionData>,
    SoundFile: Gettable<SoundFile>,
}

class NovaIDNotFoundError extends Error { };

export { NovaDataInterface, NovaDataType, NovaIDNotFoundError };
