import { RankData } from "./RankData";
import { OopsData } from "./OopsData";
import { CharData } from "./CharData";
import { CronData } from "./CronData";
import { AsteroidData } from "./AsteroidData";
import { NebulaData } from "./NebulaData";
import { StringListData } from "./StringListData";
import { CicnData } from "./CicnData";
import { CicnImageData } from "./CicnImage";
import { DudeData } from "./DudeData";
import { ExplosionData } from "./ExplosionData";
import { GovtData } from "./GovtData";
import { Gettable } from "./Gettable";
import { OutfitData } from "./OutfitData";
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
import { PersData } from "./PersData";


export enum NovaDataType {
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
    Pers = "Pers",
    Cron = "Cron",
    Rank = "Rank",
    Oops = "Oops",
    Char = "Char",
    SoundFile = "SoundFile",
}

export const ALL_NOVA_DATA_TYPES = Object.values(NovaDataType) as readonly NovaDataType[];

/**
 * Single source of truth mapping every NovaDataType to its runtime value type.
 */
export interface NovaDataTypeMap {
    [NovaDataType.Ship]: ShipData;
    [NovaDataType.Outfit]: OutfitData;
    [NovaDataType.Weapon]: WeaponData;
    [NovaDataType.Pict]: PictData;
    [NovaDataType.PictImage]: PictImageData;
    [NovaDataType.Cicn]: CicnData;
    [NovaDataType.CicnImage]: CicnImageData;
    [NovaDataType.Dude]: DudeData;
    [NovaDataType.Planet]: PlanetData;
    [NovaDataType.System]: SystemData;
    [NovaDataType.Mission]: MissionData;
    [NovaDataType.TargetCorners]: TargetCornersData;
    [NovaDataType.SpriteSheet]: SpriteSheetData;
    [NovaDataType.SpriteSheetImage]: SpriteSheetImageData;
    [NovaDataType.SpriteSheetFrames]: SpriteSheetFramesData;
    [NovaDataType.StatusBar]: StatusBarData;
    [NovaDataType.Explosion]: ExplosionData;
    [NovaDataType.Govt]: GovtData;
    [NovaDataType.Asteroid]: AsteroidData;
    [NovaDataType.Nebula]: NebulaData;
    [NovaDataType.StringList]: StringListData;
    [NovaDataType.Junk]: JunkData;
    [NovaDataType.Pers]: PersData;
    [NovaDataType.Cron]: CronData;
    [NovaDataType.Rank]: RankData;
    [NovaDataType.Oops]: OopsData;
    [NovaDataType.Char]: CharData;
    [NovaDataType.SoundFile]: SoundFile;
}

export type NovaAssetExtension = "json" | "png" | "mp3";
export type ClientLoaderKind = "json" | "weapon" | "pict" | "frames" | "soundFile";

export interface NovaDataTypeSpec<K extends NovaDataType = NovaDataType> {
    readonly type: K;
    readonly extension: NovaAssetExtension;
    readonly clientLoader: ClientLoaderKind;
    readonly preload: boolean;
}

/**
 * Canonical per-type metadata for filesystem storage, client loading, and
 * preload bundle generation. Adding a new NovaDataType here automatically
 * wires it across Aggregator, FilesystemData, Client GameData, IDs, and Mocks.
 */
export const NOVA_DATA_REGISTRY: { readonly [K in NovaDataType]: NovaDataTypeSpec<K> } = {
    [NovaDataType.Ship]: { type: NovaDataType.Ship, extension: "json", clientLoader: "json", preload: true },
    [NovaDataType.Outfit]: { type: NovaDataType.Outfit, extension: "json", clientLoader: "json", preload: true },
    [NovaDataType.Weapon]: { type: NovaDataType.Weapon, extension: "json", clientLoader: "weapon", preload: true },
    [NovaDataType.Pict]: { type: NovaDataType.Pict, extension: "json", clientLoader: "json", preload: false },
    [NovaDataType.PictImage]: { type: NovaDataType.PictImage, extension: "png", clientLoader: "pict", preload: false },
    [NovaDataType.Cicn]: { type: NovaDataType.Cicn, extension: "json", clientLoader: "json", preload: false },
    [NovaDataType.CicnImage]: { type: NovaDataType.CicnImage, extension: "png", clientLoader: "pict", preload: false },
    [NovaDataType.Dude]: { type: NovaDataType.Dude, extension: "json", clientLoader: "json", preload: false },
    [NovaDataType.Planet]: { type: NovaDataType.Planet, extension: "json", clientLoader: "json", preload: true },
    [NovaDataType.System]: { type: NovaDataType.System, extension: "json", clientLoader: "json", preload: true },
    [NovaDataType.Mission]: { type: NovaDataType.Mission, extension: "json", clientLoader: "json", preload: true },
    [NovaDataType.TargetCorners]: { type: NovaDataType.TargetCorners, extension: "json", clientLoader: "json", preload: true },
    [NovaDataType.SpriteSheet]: { type: NovaDataType.SpriteSheet, extension: "json", clientLoader: "json", preload: false },
    [NovaDataType.SpriteSheetImage]: { type: NovaDataType.SpriteSheetImage, extension: "png", clientLoader: "pict", preload: false },
    [NovaDataType.SpriteSheetFrames]: { type: NovaDataType.SpriteSheetFrames, extension: "json", clientLoader: "frames", preload: true },
    [NovaDataType.StatusBar]: { type: NovaDataType.StatusBar, extension: "json", clientLoader: "json", preload: false },
    [NovaDataType.Explosion]: { type: NovaDataType.Explosion, extension: "json", clientLoader: "json", preload: true },
    [NovaDataType.Govt]: { type: NovaDataType.Govt, extension: "json", clientLoader: "json", preload: true },
    [NovaDataType.Asteroid]: { type: NovaDataType.Asteroid, extension: "json", clientLoader: "json", preload: false },
    [NovaDataType.Nebula]: { type: NovaDataType.Nebula, extension: "json", clientLoader: "json", preload: false },
    [NovaDataType.StringList]: { type: NovaDataType.StringList, extension: "json", clientLoader: "json", preload: true },
    [NovaDataType.Junk]: { type: NovaDataType.Junk, extension: "json", clientLoader: "json", preload: true },
    [NovaDataType.Pers]: { type: NovaDataType.Pers, extension: "json", clientLoader: "json", preload: true },
    [NovaDataType.Cron]: { type: NovaDataType.Cron, extension: "json", clientLoader: "json", preload: true },
    [NovaDataType.Rank]: { type: NovaDataType.Rank, extension: "json", clientLoader: "json", preload: true },
    [NovaDataType.Oops]: { type: NovaDataType.Oops, extension: "json", clientLoader: "json", preload: true },
    [NovaDataType.Char]: { type: NovaDataType.Char, extension: "json", clientLoader: "json", preload: true },
    [NovaDataType.SoundFile]: { type: NovaDataType.SoundFile, extension: "mp3", clientLoader: "soundFile", preload: false },
};

export const PRELOAD_NOVA_DATA_TYPES: readonly NovaDataType[] = ALL_NOVA_DATA_TYPES.filter(
    type => NOVA_DATA_REGISTRY[type].preload,
);

type OptionalNovaDataTypes =
    | NovaDataType.Dude
    | NovaDataType.Mission
    | NovaDataType.Govt
    | NovaDataType.Asteroid
    | NovaDataType.Nebula
    | NovaDataType.StringList
    | NovaDataType.Junk
    | NovaDataType.Pers
    | NovaDataType.Cron
    | NovaDataType.Rank
    | NovaDataType.Oops
    | NovaDataType.Char;

export type FullNovaDataInterface = {
    [K in NovaDataType]: Gettable<NovaDataTypeMap[K]>;
};

export type NovaDataInterface = {
    [K in Exclude<NovaDataType, OptionalNovaDataTypes>]: Gettable<NovaDataTypeMap[K]>;
} & {
    [K in OptionalNovaDataTypes]?: Gettable<NovaDataTypeMap[K]>;
};

// Some legacy GameDataInterface implementations do not serve mission data.
// The parser, aggregator, and browser implementations do, so expose a
// required form for callers that use one of those implementations.
export type NovaDataInterfaceWithMission =
    Omit<NovaDataInterface, "Mission" | "Junk"> & {
        Mission: Gettable<MissionData>,
        Junk: Gettable<JunkData>,
    };

export class NovaIDNotFoundError extends Error { }
