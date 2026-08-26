import { AsteroidData } from "./AsteroidData";
import { NebulaData } from "./NebulaData";
import { StringListData } from "./StringListData";
import { CicnData } from "./CicnData";
import { CicnImageData } from "./CicnImage";
import { DudeData } from "./DudeData";
import { ExplosionData } from "./ExplosionData";
import { GovtData } from "./GovtData";
import { Gettable } from "./Gettable";
import { OutfitData } from "./OutiftData";
import { PictData } from "./PictData";
import { PictImageData } from "./PictImage";
import { PlanetData } from "./PlanetData";
import { MissionData } from "./MissionData";
import { ShipData } from "./ShipData";
import { SoundFile } from "./SoundFile";
import { SpriteSheetData, SpriteSheetFramesData, SpriteSheetImageData } from "./SpriteSheetData";
import { StatusBarData } from "./StatusBarData";
import { SystemData } from "./SystemData";
import { TargetCornersData } from "./TargetCornersData";
import { WeaponData } from "./WeaponData";
import { JunkData } from "./JunkData";


enum NovaDataType {
    Ship = "Ship",
    Outfit = "Outfit",
    Weapon = "Weapon",
    Pict = "Pict",
    PictImage = "PictImage",
    Cicn = "Cicn",
    CicnImage = "CicnImage",
    Dude = "Dude",
    Planet = "Planet",
    System = "System",
    Mission = "Mission",
    TargetCorners = "TargetCorners",
    SpriteSheet = "SpriteSheet",
    SpriteSheetImage = "SpriteSheetImage",
    SpriteSheetFrames = "SpriteSheetFrames",
    StatusBar = "StatusBar",
    Explosion = "Explosion",
    Govt = "Govt",
    Asteroid = "Asteroid",
    Nebula = "Nebula",
    StringList = "StringList",
    Junk = "Junk",
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
    Dude?: Gettable<DudeData>,
    Planet: Gettable<PlanetData>,
    System: Gettable<SystemData>,
    Mission?: Gettable<MissionData>,
    TargetCorners: Gettable<TargetCornersData>,
    SpriteSheet: Gettable<SpriteSheetData>,
    SpriteSheetImage: Gettable<SpriteSheetImageData>,
    SpriteSheetFrames: Gettable<SpriteSheetFramesData>,
    StatusBar: Gettable<StatusBarData>,
    Explosion: Gettable<ExplosionData>,
    /** Optional for legacy generated-data providers. */
    Govt?: Gettable<GovtData>,
    /** Optional for legacy generated-data providers. */
    Asteroid?: Gettable<AsteroidData>,
    /** Optional for legacy generated-data providers. */
    Nebula?: Gettable<NebulaData>,
    /** Optional for legacy generated-data providers. */
    StringList?: Gettable<StringListData>,
    /** Optional for legacy generated-data providers. */
    Junk?: Gettable<JunkData>,
    SoundFile: Gettable<SoundFile>,
}

// Some legacy GameDataInterface implementations do not serve mission data.
// The parser, aggregator, and browser implementations do, so expose a
// required form for callers that use one of those implementations.
type NovaDataInterfaceWithMission =
    Omit<NovaDataInterface, "Mission" | "Junk"> & {
        Mission: Gettable<MissionData>,
        Junk: Gettable<JunkData>,
    };

class NovaIDNotFoundError extends Error { };

export { NovaDataInterface, NovaDataInterfaceWithMission, NovaDataType, NovaIDNotFoundError };
