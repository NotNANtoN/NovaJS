import { NovaDataType } from "./nova_data_interface.js";

export type NovaIDs = {
    [index in NovaDataType]: Array<string>
}

export function getDefaultNovaIDs(): NovaIDs {
    return {
        Asteroid: [],
        Explosion: [],
        Outfit: [],
        Pict: [],
        PictImage: [],
        Cicn: [],
        CicnImage: [],
        PpatImage: [],
        Planet: [],
        Ship: [],
        SpriteSheet: [],
        SpriteSheetFrames: [],
        SpriteSheetImage: [],
        StatusBar: [],
        System: [],
        Govt: [],
        TargetCorners: [],
        Weapon: [],
        SoundFile: [],
    }
}
