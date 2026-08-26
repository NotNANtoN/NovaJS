import { BaseData } from 'novadatainterface/BaseData';
import { DudeData } from 'novadatainterface/DudeData';
import { CicnData } from 'novadatainterface/CicnData';
import { CicnImageData } from 'novadatainterface/CicnImage';
import { ExplosionData } from 'novadatainterface/ExplosionData';
import { AsteroidData } from 'novadatainterface/AsteroidData';
import { NebulaData } from 'novadatainterface/NebulaData';
import { StringListData } from 'novadatainterface/StringListData';
import { GovtData } from 'novadatainterface/GovtData';
import { GameDataInterface, PreloadData } from 'novadatainterface/GameDataInterface';
import { Gettable } from 'novadatainterface/Gettable';
import { NovaDataInterfaceWithMission, NovaDataType } from 'novadatainterface/NovaDataInterface';
import { NovaIDs } from 'novadatainterface/NovaIDs';
import { OutfitData } from 'novadatainterface/OutiftData';
import { PictData } from 'novadatainterface/PictData';
import { PictImageData } from 'novadatainterface/PictImage';
import { PlanetData } from 'novadatainterface/PlanetData';
import { MissionData } from 'novadatainterface/MissionData';
import { ShipData } from 'novadatainterface/ShipData';
import { SoundFile } from 'novadatainterface/SoundFile';
import { SpriteSheetData, SpriteSheetFramesData, SpriteSheetImageData } from 'novadatainterface/SpriteSheetData';
import { StatusBarData } from 'novadatainterface/StatusBarData';
import { SystemData } from 'novadatainterface/SystemData';
import { TargetCornersData } from 'novadatainterface/TargetCornersData';
import { WeaponData } from 'novadatainterface/WeaponData';
import { JunkData } from 'novadatainterface/JunkData';
import { PersData } from 'novadatainterface/PersData';
import * as PIXI from 'pixi.js';
import * as sound from '@pixi/sound';
import urlJoin from 'url-join';
import { dataPath, idsPath } from '../../common/GameDataPaths';
import PQueue from 'p-queue';

const METADATA_SCHEMA_VERSION = '2';

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
    public readonly data: NovaDataInterfaceWithMission & {
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
            Dude: this.addGettable<DudeData>(NovaDataType.Dude),
            Planet: this.addGettable<PlanetData>(NovaDataType.Planet),
            System: this.addGettable<SystemData>(NovaDataType.System),
            Mission: this.addGettable<MissionData>(NovaDataType.Mission),
            TargetCorners: this.addGettable<TargetCornersData>(NovaDataType.TargetCorners),
            SpriteSheet: this.addGettable<SpriteSheetData>(NovaDataType.SpriteSheet),
            SpriteSheetImage: this.addPictGettable<SpriteSheetImageData>(NovaDataType.SpriteSheetImage),
            SpriteSheetFrames: this.addTextureGettable<SpriteSheetFramesData>(NovaDataType.SpriteSheetFrames),
            StatusBar: this.addGettable<StatusBarData>(NovaDataType.StatusBar),
            Explosion: this.addGettable<ExplosionData>(NovaDataType.Explosion),
            Govt: this.addGettable<GovtData>(NovaDataType.Govt),
            Asteroid: this.addGettable<AsteroidData>(NovaDataType.Asteroid),
            Nebula: this.addGettable<NebulaData>(NovaDataType.Nebula),
            StringList: this.addGettable<StringListData>(
                NovaDataType.StringList),
            Junk: this.addGettable<JunkData>(NovaDataType.Junk),
            Pers: this.addGettable<PersData>(NovaDataType.Pers),
            SoundFile: this.addSoundFileGettable(),
            Sound: this.addSoundGettable(),
        };

        this.preloadData = this.preload();
        this.loaded = this.preloadData.then(() => { });

        this.ids = this.getIds();
    }

    getSettings(file: string): Promise<unknown> {
        return this.getMetadataUrl(urlJoin("/settings", file));
    }

    private async preload() {
        const data = await this.fetchMetadata(
            '/preloadData.json') as PreloadData;
        for (const [uncastKey, val] of Object.entries(data)) {
            const key = uncastKey as keyof typeof data;
            const gettable = this.data[key];
            if (gettable) {
                gettable.gotten = val;
            }
        }
        return data;
    }

    private async getUrl(url: string, priority = 0): Promise<unknown> {
        await this.preloadData;
        return this.loadQueue.add(
            () => PIXI.Assets.load(url),
            { priority },
        );
    }

    private async fetchMetadata(url: string): Promise<unknown> {
        // Stable JSON URLs previously shipped with one-year immutable caching.
        // reload bypasses that stale response without invalidating large
        // browser-cached image and audio assets.
        const response = await fetch(url, { cache: 'reload' });
        if (!response.ok) {
            throw new Error(`Failed to load metadata ${url}: ${
                response.status} ${response.statusText}`);
        }
        return response.json() as Promise<unknown>;
    }

    private async getMetadataUrl(
        url: string,
        priority = 0,
    ): Promise<unknown> {
        await this.preloadData;
        // A versioned URL cannot hit the old unversioned immutable response.
        // PIXI may cache this new URL in memory, while HTTP no-cache headers
        // make future browser launches revalidate it normally.
        const versionedUrl = `${url}${
            url.includes('?') ? '&' : '?'}schema=${METADATA_SCHEMA_VERSION}`;
        return this.loadQueue.add(
            () => PIXI.Assets.load(versionedUrl),
            { priority },
        );
    }

    private getDataPrefix(dataType: NovaDataType): string {
        return urlJoin(dataPath, dataType);
    }

    private addGettable<T extends BaseData | SpriteSheetFramesData>(dataType: NovaDataType): Gettable<T> {
        const dataPrefix = this.getDataPrefix(dataType);
        return new Gettable<T>(async (id: string, priority: number): Promise<T> => {
            return (await this.getMetadataUrl(
                urlJoin(dataPrefix, id + ".json"), priority)) as T;
        });
    }

    private addTextureGettable<T extends BaseData | SpriteSheetFramesData>(dataType: NovaDataType): Gettable<T> {
        const dataPrefix = this.getDataPrefix(dataType);
        return new Gettable<T>(async (id: string, priority: number): Promise<T> => {
            const result = await this.getMetadataUrl(
                urlJoin(dataPrefix, id + ".json"), priority) as { data: T };
            return result.data;
        });
    }

    private addWeaponGettable(): WeaponGettable {
        const dataPrefix = this.getDataPrefix(NovaDataType.Weapon);
        return new WeaponGettable(async (id: string, priority: number): Promise<WeaponData> => {
            return (await this.getMetadataUrl(
                urlJoin(dataPrefix, id + ".json"), priority)) as WeaponData;
        });

    }

    private addPictGettable<T extends PictImageData | SpriteSheetImageData>(dataType: NovaDataType): Gettable<T> {
        var dataPrefix = this.getDataPrefix(dataType);
        return new Gettable<T>(async (id: string, priority: number): Promise<T> => {
            return <T>((await this.getUrl(urlJoin(dataPrefix, id) + ".png", priority)) as Buffer).buffer;
        });
    }

    private addSoundFileGettable() {
        const dataPrefix = this.getDataPrefix(NovaDataType.SoundFile);
        return new Gettable<SoundFile>(async (id: string, priority: number) => {
            //return await (await fetch(urlJoin(dataPrefix, id))).arrayBuffer();
            return ((await this.getUrl(urlJoin(dataPrefix, id) + '.mp3', priority)) as Buffer);
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
        return this.fetchMetadata(idsPath + ".json") as Promise<NovaIDs>;
        //const res = await ((await this.getUrl(idsPath + ".json")) as unknown) as NovaIDs;

        //return res;
        //return JSON.parse(idsBuffer.toString('utf8'));
    }
}
