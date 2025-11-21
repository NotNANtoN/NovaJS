import { getDefaultCicnData } from "./CicnData.js";
import { getDefaultExplosionData } from "./ExplosionData.js";
import { GameDataInterface } from "./GameDataInterface.js";
import { Gettable } from "./Gettable.js";
import { NovaDataInterface } from "./NovaDataInterface.js";
import { NovaIDs } from "./NovaIDs.js";
import { getDefaultOutfitData } from "./OutiftData.js";
import { getDefaultPictData } from "./PictData.js";
import { getDefaultPlanetData } from "./PlanetData.js";
import { getDefaultShipData } from "./ShipData.js";
import { getDefaultSoundFile } from "./SoundFile.js";
import { getDefaultSpriteSheetData, getDefaultSpriteSheetFrames } from "./SpriteSheetData.js";
import { getDefaultStatusBarData } from "./StatusBarData.js";
import { getDefaultSystemData } from "./SystemData.js";
import { getDefaultTargetCornersData } from "./TargetCornersData.js";
import { getDefaultProjectileWeaponData } from "./WeaponData.js";

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
            return val;
        }
        else if (this.defaultValue !== undefined) {
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
