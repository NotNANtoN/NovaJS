import { AsteroidData } from "./asteroid_data.js";
import { CicnData } from "./cicn_data.js";
import { CicnImageData } from "./cicn_image.js";
import { CronData } from "./cron_data.js";
import { ExplosionData } from "./explosion_data.js";
import { DudeData } from "./dude_data.js";
import { FleetData } from "./fleet_data.js";
import { Gettable } from "./gettable.js";
import { GovtData } from "./govt_data.js";
import { MissionData } from "./mission_data.js";
import { OutfitData } from "./outfit_data.js";
import { PictData } from "./pict_data.js";
import { PictImageData } from "./pict_image.js";
import { PlanetData } from "./planet_data.js";
import { PlayerStartData } from "./player_start_data.js";
import { PpatImageData } from "./ppat_image.js";
import { ShipData } from "./ship_data.js";
import { SoundFile } from "./sound_file.js";
import { SpriteSheetData, SpriteSheetFramesData, SpriteSheetImageData } from "./sprite_sheet_data.js";
import { StatusBarData } from "./status_bar_data.js";
import { SystemData } from "./system_data.js";
import { TargetCornersData } from "./target_corners_data.js";
import { WeaponData } from "./weapon_data.js";


enum NovaDataType {
    Asteroid = "Asteroid",
    Ship = "Ship",
    Outfit = "Outfit",
    Weapon = "Weapon",
    Pict = "Pict",
    PictImage = "PictImage",
    Cicn = "Cicn",
    CicnImage = "CicnImage",
    PpatImage = "PpatImage",
    Planet = "Planet",
    System = "System",
    Govt = "Govt",
    Dude = "Dude",
    Fleet = "Fleet",
    Mission = "Mission",
    Cron = "Cron",
    PlayerStart = "PlayerStart",
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
    Asteroid: Gettable<AsteroidData>,
    Ship: Gettable<ShipData>,
    Outfit: Gettable<OutfitData>,
    Weapon: Gettable<WeaponData>,
    Pict: Gettable<PictData>,
    PictImage: Gettable<PictImageData>,
    Cicn: Gettable<CicnData>,
    CicnImage: Gettable<CicnImageData>,
    PpatImage: Gettable<PpatImageData>,
    Planet: Gettable<PlanetData>,
    System: Gettable<SystemData>,
    Govt: Gettable<GovtData>,
    Dude: Gettable<DudeData>,
    Fleet: Gettable<FleetData>,
    Mission: Gettable<MissionData>,
    Cron: Gettable<CronData>,
    PlayerStart: Gettable<PlayerStartData>,
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
