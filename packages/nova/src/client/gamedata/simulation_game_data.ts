import { AsteroidData } from 'novadatainterface/asteroid_data';
import { BaseData } from 'novadatainterface/base_data';
import { GameDataInterface, PreloadData } from 'novadatainterface/game_data_interface';
import { Gettable } from 'novadatainterface/gettable';
import { NovaDataType } from 'novadatainterface/nova_data_interface';
import { NovaIDs } from 'novadatainterface/nova_ids';
import { OutfitData } from 'novadatainterface/outfit_data';
import { PlanetData } from 'novadatainterface/planet_data';
import { ShipData } from 'novadatainterface/ship_data';
import { SpriteSheetData } from 'novadatainterface/sprite_sheet_data';
import { SystemData } from 'novadatainterface/system_data';
import { WeaponData } from 'novadatainterface/weapon_data';
import urlJoin from 'url-join';
import { dataPath, idsPath } from '../../common/game_data_paths.js';

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

export type SimulationGameDataResources = Pick<GameDataInterface['data'],
    'Ship' | 'Outfit' | 'Weapon' | 'Planet' | 'System' | 'SpriteSheet'
    | 'Asteroid'>;

export interface SimulationGameDataInterface {
    readonly data: SimulationGameDataResources;
    readonly ids: Promise<NovaIDs>;
    readonly preloadData?: Promise<PreloadData>;
    readonly loaded?: Promise<void>;
    getSettings?(file: string): Promise<unknown>;
}

export class SimulationGameData implements SimulationGameDataInterface {
    public readonly data: SimulationGameDataResources;
    public readonly ids: Promise<NovaIDs>;
    readonly preloadData: Promise<PreloadData>;
    public loaded = Promise.resolve();

    constructor() {
        this.data = {
            Ship: this.addGettable<ShipData>(NovaDataType.Ship),
            Outfit: this.addGettable<OutfitData>(NovaDataType.Outfit),
            Weapon: this.addWeaponGettable(),
            Planet: this.addGettable<PlanetData>(NovaDataType.Planet),
            System: this.addGettable<SystemData>(NovaDataType.System),
            SpriteSheet: this.addGettable<SpriteSheetData>(NovaDataType.SpriteSheet),
            Asteroid: this.addGettable<AsteroidData>(NovaDataType.Asteroid),
        };

        this.preloadData = this.preload();
        this.loaded = this.preloadData.then(() => { });
        this.ids = this.getIds();
    }

    getSettings(file: string): Promise<unknown> {
        return this.getJson(urlJoin('/settings', file));
    }

    private async preload() {
        const data = await this.getJson('/preloadData.json') as PreloadData;
        for (const [uncastKey, val] of Object.entries(data)) {
            const key = uncastKey as keyof typeof data;
            const resource = this.data[key as keyof SimulationGameDataResources];
            if (resource) {
                resource.gotten = val as typeof resource.gotten;
            }
        }
        return data;
    }

    private async getJson(url: string): Promise<unknown> {
        return (await fetch(url)).json();
    }

    private getDataPrefix(dataType: NovaDataType): string {
        return urlJoin(dataPath, dataType);
    }

    private addGettable<T extends BaseData>(dataType: NovaDataType): Gettable<T> {
        const dataPrefix = this.getDataPrefix(dataType);
        return new Gettable<T>(async (id: string): Promise<T> => {
            return await this.getJson(urlJoin(dataPrefix, id + '.json')) as T;
        });
    }

    private addWeaponGettable(): WeaponGettable {
        const dataPrefix = this.getDataPrefix(NovaDataType.Weapon);
        return new WeaponGettable(async (id: string): Promise<WeaponData> => {
            return await this.getJson(urlJoin(dataPrefix, id + '.json')) as WeaponData;
        });
    }

    private async getIds(): Promise<NovaIDs> {
        return (await fetch(idsPath + '.json')).json() as unknown as NovaIDs;
    }
}
