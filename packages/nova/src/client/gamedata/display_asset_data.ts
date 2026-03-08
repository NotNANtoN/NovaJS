import { CicnData } from 'novadatainterface/cicn_data';
import { CicnImageData } from 'novadatainterface/cicn_image';
import { ExplosionData } from 'novadatainterface/explosion_data';
import { Gettable } from 'novadatainterface/gettable';
import { NovaDataType, NovaDataInterface } from 'novadatainterface/nova_data_interface';
import { PictData } from 'novadatainterface/pict_data';
import { PictImageData } from 'novadatainterface/pict_image';
import { SoundFile } from 'novadatainterface/sound_file';
import { SpriteSheetFramesData, SpriteSheetImageData } from 'novadatainterface/sprite_sheet_data';
import { StatusBarData } from 'novadatainterface/status_bar_data';
import { TargetCornersData } from 'novadatainterface/target_corners_data';
import * as PIXI from 'pixi.js';
import * as sound from '@pixi/sound';
import urlJoin from 'url-join';
import { dataPath } from '../../common/game_data_paths.js';

export type DisplayAssetDataResources = Pick<NovaDataInterface,
    'Pict' | 'PictImage' | 'Cicn' | 'CicnImage' | 'TargetCorners' |
    'SpriteSheetImage' | 'SpriteSheetFrames' | 'StatusBar' |
    'Explosion' | 'SoundFile'
> & {
    Sound: Gettable<sound.Sound>,
};

export class DisplayAssetData {
    public readonly data: DisplayAssetDataResources;

    constructor() {
        this.data = {
            Pict: this.addStructuredGettable<PictData>(NovaDataType.Pict),
            PictImage: this.addBinaryGettable<PictImageData>(NovaDataType.PictImage, '.png'),
            Cicn: this.addStructuredGettable<CicnData>(NovaDataType.Cicn),
            CicnImage: this.addBinaryGettable<CicnImageData>(NovaDataType.CicnImage, '.png'),
            TargetCorners: this.addStructuredGettable<TargetCornersData>(NovaDataType.TargetCorners),
            SpriteSheetImage: this.addBinaryGettable<SpriteSheetImageData>(NovaDataType.SpriteSheetImage, '.png'),
            SpriteSheetFrames: this.addFramesGettable<SpriteSheetFramesData>(NovaDataType.SpriteSheetFrames),
            StatusBar: this.addStructuredGettable<StatusBarData>(NovaDataType.StatusBar),
            Explosion: this.addStructuredGettable<ExplosionData>(NovaDataType.Explosion),
            SoundFile: this.addBinaryGettable<SoundFile>(NovaDataType.SoundFile, '.mp3'),
            Sound: this.addSoundGettable(),
        };
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
        const texture = await this.textureFromPictAsync(id, priority);
        return new PIXI.Sprite(texture);
    }

    async textureFromCicn(id: string): Promise<PIXI.Texture> {
        const cicnPath = urlJoin(dataPath, NovaDataType.CicnImage, id + '.png');
        await this.data.CicnImage.get(id);
        return PIXI.Texture.from(cicnPath);
    }

    private async getUrl(url: string, _priority = 0): Promise<unknown> {
        return PIXI.Assets.load(url);
    }

    private getDataPrefix(dataType: NovaDataType): string {
        return urlJoin(dataPath, dataType);
    }

    private addStructuredGettable<T>(dataType: NovaDataType): Gettable<T> {
        const dataPrefix = this.getDataPrefix(dataType);
        return new Gettable<T>(async (id: string, priority: number): Promise<T> => {
            return await this.getUrl(urlJoin(dataPrefix, id + '.json'), priority) as T;
        });
    }

    private addFramesGettable<T>(dataType: NovaDataType): Gettable<T> {
        const dataPrefix = this.getDataPrefix(dataType);
        return new Gettable<T>(async (id: string, priority: number): Promise<T> => {
            return (await this.getUrl(urlJoin(dataPrefix, id + '.json'), priority) as { data: unknown }).data as T;
        });
    }

    private addBinaryGettable<T>(dataType: NovaDataType, extension: string): Gettable<T> {
        const dataPrefix = this.getDataPrefix(dataType);
        return new Gettable<T>(async (id: string, priority: number): Promise<T> => {
            return ((await this.getUrl(urlJoin(dataPrefix, id) + extension, priority)) as { buffer: ArrayBuffer }).buffer as T;
        });
    }

    private addSoundGettable() {
        const dataPrefix = this.getDataPrefix(NovaDataType.SoundFile);
        return new Gettable<sound.Sound>(async (id) => {
            const soundPath = urlJoin(dataPrefix, id) + '.mp3';
            return new Promise((fulfill, reject) => {
                sound.Sound.from({
                    url: soundPath,
                    preload: true,
                    loaded: (err, loadedSound) => {
                        if (err || !loadedSound) {
                            reject(err);
                            return;
                        }
                        fulfill(loadedSound);
                    }
                });
            });
        });
    }

    private url(id: string): string {
        return urlJoin(dataPath, NovaDataType.PictImage, id + '.png');
    }
}
