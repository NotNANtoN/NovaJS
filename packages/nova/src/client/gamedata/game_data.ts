import { BaseData } from 'novadatainterface/base_data';
import { CicnData } from 'novadatainterface/cicn_data';
import { CicnImageData } from 'novadatainterface/cicn_image';
import { ExplosionData } from 'novadatainterface/explosion_data';
import { GameDataInterface, PreloadData } from 'novadatainterface/game_data_interface';
import { Gettable } from 'novadatainterface/gettable';
import { NovaDataInterface, NovaDataType } from 'novadatainterface/nova_data_interface';
import { NovaIDs } from 'novadatainterface/nova_ids';
import { OutfitData } from 'novadatainterface/outfit_data';
import { PictData } from 'novadatainterface/pict_data';
import { PictImageData } from 'novadatainterface/pict_image';
import { PlanetData } from 'novadatainterface/planet_data';
import { ShipData } from 'novadatainterface/ship_data';
import { SoundFile } from 'novadatainterface/sound_file';
import { SpriteSheetData, SpriteSheetFramesData, SpriteSheetImageData } from 'novadatainterface/sprite_sheet_data';
import { StatusBarData } from 'novadatainterface/status_bar_data';
import { SystemData } from 'novadatainterface/system_data';
import { TargetCornersData } from 'novadatainterface/target_corners_data';
import { WeaponData } from 'novadatainterface/weapon_data';
import * as PIXI from 'pixi.js';
import * as sound from '@pixi/sound';
import urlJoin from 'url-join';
import { dataPath, idsPath } from '../../common/game_data_paths.js';
import PQueue from 'p-queue';

class WeaponGettable extends Gettable<WeaponData> {
    override async get(id: string, priority = 0) {
        if (id in this.data) {
            return await super.get(id);
        }

        const weapon = await super.get(id, priority);
        if (weapon.type === 'ProjectileWeaponData') {
            await Promise.all(weapon.submunitions.map(s => this.get(s.id, priority)));
        }
        return weapon;
    }
}

/**
 * Retrieves game data from the server
 */
export class GameData implements GameDataInterface {
    public readonly data: NovaDataInterface & {
        Sound: Gettable<sound.Sound>,
    };
    public readonly ids: Promise<NovaIDs>;
    readonly preloadData: Promise<PreloadData>;
    public loaded = Promise.resolve();
    private loadQueue = new PQueue({
        autoStart: true,
        concurrency: 16,
    });

    constructor() {
        // There should be a better way to do this. I'm repeating myself here.
        this.data = {
            Ship: this.addGettable<ShipData>(NovaDataType.Ship),
            Outfit: this.addGettable<OutfitData>(NovaDataType.Outfit),
            Weapon: this.addWeaponGettable(),
            Pict: this.addGettable<PictData>(NovaDataType.Pict),
            PictImage: this.addPictGettable<PictImageData>(NovaDataType.PictImage),
            Cicn: this.addGettable<CicnData>(NovaDataType.Cicn),
            CicnImage: this.addPictGettable<CicnImageData>(NovaDataType.CicnImage),
            Planet: this.addGettable<PlanetData>(NovaDataType.Planet),
            System: this.addGettable<SystemData>(NovaDataType.System),
            TargetCorners: this.addGettable<TargetCornersData>(NovaDataType.TargetCorners),
            SpriteSheet: this.addGettable<SpriteSheetData>(NovaDataType.SpriteSheet),
            SpriteSheetImage: this.addPictGettable<SpriteSheetImageData>(NovaDataType.SpriteSheetImage),
            SpriteSheetFrames: this.addTextureGettable<SpriteSheetFramesData>(NovaDataType.SpriteSheetFrames),
            StatusBar: this.addGettable<StatusBarData>(NovaDataType.StatusBar),
            Explosion: this.addGettable<ExplosionData>(NovaDataType.Explosion),
            SoundFile: this.addSoundFileGettable(),
            Sound: this.addSoundGettable(),
        };

        this.preloadData = this.preload();
        this.loaded = this.preloadData.then(() => { });

        this.ids = this.getIds();
    }

    getSettings(file: string): Promise<unknown> {
        return this.getUrl(urlJoin("/settings", file));
    }

    private async preload() {
        const data = await (await fetch('/preloadData.json')).json() as PreloadData;
        for (const [uncastKey, val] of Object.entries(data)) {
            const key = uncastKey as keyof typeof data;
            this.data[key].gotten = val;
        }
        return data;
    }

    private async getUrl(url: string, priority = 0): Promise<unknown> {
        await this.preloadData;
        return PIXI.Assets.load(url);
    }

    private getDataPrefix(dataType: NovaDataType): string {
        return urlJoin(dataPath, dataType);
    }

    private addGettable<T extends BaseData | SpriteSheetFramesData>(dataType: NovaDataType): Gettable<T> {
        const dataPrefix = this.getDataPrefix(dataType);
        return new Gettable<T>(async (id: string, priority: number): Promise<T> => {
            return (await this.getUrl(urlJoin(dataPrefix, id + ".json"), priority)) as any;
        });
    }

    private addTextureGettable<T extends BaseData | SpriteSheetFramesData>(dataType: NovaDataType): Gettable<T> {
        const dataPrefix = this.getDataPrefix(dataType);
        return new Gettable<T>(async (id: string, priority: number): Promise<T> => {
            return (await this.getUrl(urlJoin(dataPrefix, id + ".json"), priority) as { data: any }).data as any;
        });
    }

    private addWeaponGettable(): WeaponGettable {
        const dataPrefix = this.getDataPrefix(NovaDataType.Weapon);
        return new WeaponGettable(async (id: string, priority: number): Promise<WeaponData> => {
            return (await this.getUrl(urlJoin(dataPrefix, id + ".json"), priority)) as any;
        });

    }

    private addPictGettable<T extends PictImageData | SpriteSheetImageData>(dataType: NovaDataType): Gettable<T> {
        var dataPrefix = this.getDataPrefix(dataType);
        return new Gettable<T>(async (id: string, priority: number): Promise<T> => {
            return <T>((await this.getUrl(urlJoin(dataPrefix, id) + ".png", priority)) as unknown as { buffer: ArrayBuffer }).buffer;
        });
    }

    private addSoundFileGettable() {
        const dataPrefix = this.getDataPrefix(NovaDataType.SoundFile);
        return new Gettable<SoundFile>(async (id: string, priority: number) => {
            //return await (await fetch(urlJoin(dataPrefix, id))).arrayBuffer();
            return ((await this.getUrl(urlJoin(dataPrefix, id) + '.mp3', priority)) as unknown as { buffer: ArrayBuffer }).buffer;
        });
    }

    private url(id: string): string {
        return urlJoin(dataPath, NovaDataType.PictImage, id + ".png");
    }

    textureFromPict(id: string): PIXI.Texture {
        return PIXI.Texture.from(this.url(id));
    }

    spriteFromPict(id: string) {
        return PIXI.Sprite.from(this.url(id));
    }

    async textureFromPictAsync(id: string, priority?: number) {
        const pictPath = this.url(id);
        await this.data.PictImage.get(id, priority);
        return PIXI.Texture.from(pictPath);
    }

    async spriteFromPictAsync(id: string, priority?: number) {
        // TODO: Use this.data
        var texture = await this.textureFromPictAsync(id, priority);
        return new PIXI.Sprite(texture);
    }

    async textureFromCicn(id: string): Promise<PIXI.Texture> {
        const cicnPath = urlJoin(dataPath, NovaDataType.CicnImage, id + ".png");
        await this.data.CicnImage.get(id);
        return PIXI.Texture.from(cicnPath);
    }

    private addSoundGettable() {
        const dataPrefix = this.getDataPrefix(NovaDataType.SoundFile);
        return new Gettable<sound.Sound>(async (id) => {
            const soundPath = urlJoin(dataPrefix, id) + '.mp3';
            return new Promise((fulfill, reject) => {
                sound.Sound.from({
                    url: soundPath,
                    preload: true,
                    loaded: (err, sound) => {
                        if (err || !sound) {
                            reject(err);
                            return;
                        }
                        fulfill(sound);
                    }
                });
            })
        });
    }

    private async getIds(): Promise<NovaIDs> {
        return (await fetch(idsPath + ".json")).json() as unknown as NovaIDs;
        //const res = await ((await this.getUrl(idsPath + ".json")) as unknown) as NovaIDs;

        //return res;
        //return JSON.parse(idsBuffer.toString('utf8'));
    }
}
