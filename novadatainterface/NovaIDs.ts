import { NovaDataType } from "./NovaDataInterface";

export type NovaIDs = {
    [index in Exclude<NovaDataType, NovaDataType.Mission | NovaDataType.Govt
    | NovaDataType.Asteroid | NovaDataType.Nebula
    | NovaDataType.StringList | NovaDataType.Junk>]: Array<string>
} & {
    // Kept optional so legacy FilesystemData providers remain source
    // compatible while they do not serve mission JSON yet.
    Mission?: Array<string>
    Govt?: Array<string>
    Asteroid?: Array<string>
    Nebula?: Array<string>
    StringList?: Array<string>
    Junk?: Array<string>
}

export function getDefaultNovaIDs(): NovaIDs {
    return {
        Explosion: [],
        Outfit: [],
        Pict: [],
        PictImage: [],
        Cicn: [],
        CicnImage: [],
        Dude: [],
        Planet: [],
        Ship: [],
        SpriteSheet: [],
        SpriteSheetFrames: [],
        SpriteSheetImage: [],
        StatusBar: [],
        System: [],
        Mission: [],
        TargetCorners: [],
        Weapon: [],
        SoundFile: [],
        Govt: [],
        Asteroid: [],
        Nebula: [],
        StringList: [],
        Junk: [],
    }
}
