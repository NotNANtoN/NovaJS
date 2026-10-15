import { getDefaultRankData } from "./RankData";
import { getDefaultCharData } from "./CharData";
import { getDefaultOopsData } from "./OopsData";
import { getDefaultCronData } from "./CronData";
import { getDefaultCicnData } from "./CicnData";
import { getDefaultCicnImageData } from "./CicnImage";
import { getDefaultDudeData } from "./DudeData";
import { getDefaultSpriteSheetImage } from "./DefaultSpriteSheetImage";
import { getDefaultExplosionData } from "./ExplosionData";
import { getDefaultGovtData } from "./GovtData";
import { getDefaultOutfitData } from "./OutfitData";
import { getDefaultPictData } from "./PictData";
import { getDefaultPictImageData } from "./PictImage";
import { getDefaultPlanetData } from "./PlanetData";
import { getDefaultMissionData } from "./MissionData";
import { getDefaultAsteroidData } from "./AsteroidData";
import { getDefaultNebulaData } from "./NebulaData";
import { getDefaultStringListData } from "./StringListData";
import { getDefaultShipData } from "./ShipData";
import { getDefaultSoundFile } from "./SoundFile";
import { getDefaultSpriteSheetData, getDefaultSpriteSheetFrames } from "./SpriteSheetData";
import { getDefaultStatusBarData } from "./StatusBarData";
import { getDefaultSystemData } from "./SystemData";
import { getDefaultTargetCornersData } from "./TargetCornersData";
import { getDefaultProjectileWeaponData } from "./WeaponData";
import { getDefaultJunkData } from "./JunkData";
import { getDefaultPersData } from "./PersData";
import { ALL_NOVA_DATA_TYPES, NovaDataType, NovaDataTypeMap } from "./NovaDataInterface";

export const DEFAULT_FACTORIES: { readonly [K in NovaDataType]: () => NovaDataTypeMap[K] } = {
    [NovaDataType.Ship]: getDefaultShipData,
    [NovaDataType.Outfit]: getDefaultOutfitData,
    [NovaDataType.Weapon]: getDefaultProjectileWeaponData,
    [NovaDataType.Pict]: getDefaultPictData,
    [NovaDataType.PictImage]: getDefaultPictImageData,
    [NovaDataType.Cicn]: getDefaultCicnData,
    [NovaDataType.CicnImage]: getDefaultCicnImageData,
    [NovaDataType.Dude]: getDefaultDudeData,
    [NovaDataType.Planet]: getDefaultPlanetData,
    [NovaDataType.System]: getDefaultSystemData,
    [NovaDataType.Mission]: getDefaultMissionData,
    [NovaDataType.TargetCorners]: getDefaultTargetCornersData,
    [NovaDataType.SpriteSheet]: getDefaultSpriteSheetData,
    [NovaDataType.SpriteSheetImage]: getDefaultSpriteSheetImage,
    [NovaDataType.SpriteSheetFrames]: getDefaultSpriteSheetFrames,
    [NovaDataType.StatusBar]: getDefaultStatusBarData,
    [NovaDataType.Explosion]: getDefaultExplosionData,
    [NovaDataType.Govt]: getDefaultGovtData,
    [NovaDataType.SoundFile]: getDefaultSoundFile,
    [NovaDataType.Asteroid]: getDefaultAsteroidData,
    [NovaDataType.Nebula]: getDefaultNebulaData,
    [NovaDataType.StringList]: getDefaultStringListData,
    [NovaDataType.Junk]: getDefaultJunkData,
    [NovaDataType.Pers]: getDefaultPersData,
    [NovaDataType.Cron]: getDefaultCronData,
    [NovaDataType.Rank]: getDefaultRankData,
    [NovaDataType.Oops]: getDefaultOopsData,
    [NovaDataType.Char]: getDefaultCharData,
};

function buildDefaults(): { readonly [K in NovaDataType]: NovaDataTypeMap[K] } {
    const obj = {} as { [K in NovaDataType]: NovaDataTypeMap[K] };
    for (const type of ALL_NOVA_DATA_TYPES) {
        Object.defineProperty(obj, type, {
            enumerable: true,
            get: DEFAULT_FACTORIES[type],
        });
    }
    return obj;
}

export const Defaults = buildDefaults();
