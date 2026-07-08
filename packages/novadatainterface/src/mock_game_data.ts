import { getDefaultCicnData } from "./cicn_data.js";
import { getDefaultExplosionData } from "./explosion_data.js";
import { GameDataInterface } from "./game_data_interface.js";
import { Gettable } from "./gettable.js";
import { NovaDataInterface } from "./nova_data_interface.js";
import { NovaIDs } from "./nova_ids.js";
import { getDefaultOutfitData } from "./outfit_data.js";
import { getDefaultPictData } from "./pict_data.js";
import { getDefaultPlanetData } from "./planet_data.js";
import { getDefaultShipData } from "./ship_data.js";
import { getDefaultSoundFile } from "./sound_file.js";
import { getDefaultSpriteSheetData, getDefaultSpriteSheetFrames } from "./sprite_sheet_data.js";
import { getDefaultStatusBarData } from "./status_bar_data.js";
import { getDefaultSystemData } from "./system_data.js";
import { getDefaultTargetCornersData } from "./target_corners_data.js";
import { getDefaultProjectileWeaponData } from "./weapon_data.js";

// TODO: Make gettable an interface so you
// don't have to do this awkward extension
class MockGettable<T> extends Gettable<T> {
    map = new Map<string, T>();
    getIds(): string[] {
        return [...this.map.keys()];
    }
    constructor(public defaultValue?: T) {
        super((_id: string) => null as any as Promise<T>);
    }

    override async get(id: string): Promise<T> {
        const val = this.map.get(id);
        if (val !== undefined) {
            // Populate the base class cache so getCached works.
            this.gotten[id] = val;
            return val;
        }
        else if (this.defaultValue !== undefined) {
            this.gotten[id] = this.defaultValue;
            return this.defaultValue;
        }
        else {
            throw new Error(`id ${id} not found`);
        }
    }
}

type ExtractGettableType<T> = T extends Gettable<infer T> ? T : never;

type MockNovaDataInterface = {
    [P in keyof NovaDataInterface]: MockGettable<ExtractGettableType<NovaDataInterface[P]>>
}

export class MockGameData implements GameDataInterface {
    data: MockNovaDataInterface = {
        Explosion: new MockGettable(getDefaultExplosionData()),
        Outfit: new MockGettable(getDefaultOutfitData()),
        Pict: new MockGettable(getDefaultPictData()),
        PictImage: new MockGettable(new Uint8Array(0).buffer),
        Cicn: new MockGettable(getDefaultCicnData()),
        CicnImage: new MockGettable(new Uint8Array(0).buffer),
        Planet: new MockGettable(getDefaultPlanetData()),
        Ship: new MockGettable(getDefaultShipData()),
        SpriteSheet: new MockGettable(getDefaultSpriteSheetData()),
        SpriteSheetFrames: new MockGettable(getDefaultSpriteSheetFrames()),
        SpriteSheetImage: new MockGettable(new Uint8Array(0).buffer),
        StatusBar: new MockGettable(getDefaultStatusBarData()),
        System: new MockGettable(getDefaultSystemData()),
        TargetCorners: new MockGettable(getDefaultTargetCornersData()),
        Weapon: new MockGettable(getDefaultProjectileWeaponData()),
        SoundFile: new MockGettable(getDefaultSoundFile()),
    };
    get ids(): Promise<NovaIDs> {
        const ids: NovaIDs = {} as NovaIDs;
        for (const [key, val] of Object.entries(this.data)) {
            ids[key as keyof NovaDataInterface] = (val as MockGettable<unknown>).getIds();
        }

        return Promise.resolve<NovaIDs>(ids);
    }
}
