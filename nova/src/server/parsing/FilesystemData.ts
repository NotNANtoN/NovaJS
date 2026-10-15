import * as fs from "fs";
import { BaseData } from "novadatainterface/BaseData";
import { GameDataInterface } from "novadatainterface/GameDataInterface";
import { Gettable } from "novadatainterface/Gettable";
import {
    ALL_NOVA_DATA_TYPES,
    NOVA_DATA_REGISTRY,
    NovaDataInterface,
    NovaDataType,
} from "novadatainterface/NovaDataInterface";
import { getDefaultNovaIDs, NovaIDs } from "novadatainterface/NovaIDs";
import { PictImageData } from "novadatainterface/PictImage";
import { SpriteSheetFramesData } from "novadatainterface/SpriteSheetData";
import * as path from "path";


type PathInfo = {
    path: string,
    extension: string
};

/**
 * Resource ids map to file names through URI encoding, so namespaced ids such
 * as `debug:planetbuster` are stored as `debug%3Aplanetbuster.json` (a colon
 * is not a valid file name character everywhere). Encoding also keeps an id
 * taken from a request URL from escaping its directory (`../`).
 */
export function filenameForId(id: string): string {
    return encodeURIComponent(id);
}

export function idForFilename(name: string): string | undefined {
    try {
        return decodeURIComponent(name);
    } catch {
        return undefined;
    }
}

const Paths: { readonly [K in NovaDataType]: PathInfo } = Object.fromEntries(
    ALL_NOVA_DATA_TYPES.map(type => [
        type,
        { path: type, extension: NOVA_DATA_REGISTRY[type].extension },
    ]),
) as { readonly [K in NovaDataType]: PathInfo };

export interface FilesystemDataOptions {
    /**
     * Ids with these prefixes are neither listed nor served, as if their
     * files did not exist. Used to withhold debug-only content.
     */
    excludeIdPrefixes?: readonly string[];
}

class FilesystemData implements GameDataInterface {
    public ids: Promise<NovaIDs>;
    public data: NovaDataInterface;
    private readonly excludeIdPrefixes: readonly string[];

    constructor(private rootPath: string, options: FilesystemDataOptions = {}) {
        this.excludeIdPrefixes = options.excludeIdPrefixes ?? [];
        const data = {} as Record<NovaDataType, Gettable<unknown>>;
        for (const type of ALL_NOVA_DATA_TYPES) {
            data[type] = this.getFunction(Paths[type]);
        }
        this.data = data as NovaDataInterface;
        this.ids = this.buildIDs();
    }

    getFunction<T extends BaseData | PictImageData | SpriteSheetFramesData>(p: PathInfo): Gettable<T> {
        // Returns a gettable that loads the resource from a file
        return new Gettable<T>((id: string) => {
            return new Promise<T>((fulfill, reject) => {
                if (this.isExcluded(id)) {
                    reject(new Error(`${id} is not served`));
                    return;
                }
                fs.readFile(path.join(this.rootPath, p.path, filenameForId(id) + "." + p.extension),
                    function(err, contents) {
                        if (err) {
                            reject(err);
                        }
                        else {
                            if (p.extension == "json") {
                                fulfill(JSON.parse(contents.toString('utf8')) as T)
                            }
                            else if (p.extension == "png") {
                                fulfill(contents.buffer.slice(
                                    contents.byteOffset,
                                    contents.byteOffset + contents.byteLength,
                                ) as T);
                            }
                            else {
                                reject("Unsupported");
                            }
                        }
                    });
            });
        });
    }

    async buildIDs(): Promise<NovaIDs> {
        const ids = getDefaultNovaIDs();
        await Promise.all(ALL_NOVA_DATA_TYPES.map(async type => {
            ids[type] = await this.buildIDsForPath(Paths[type]);
        }));
        return ids;
    }

    private isExcluded(id: string): boolean {
        return this.excludeIdPrefixes.some(prefix => id.startsWith(prefix));
    }

    buildIDsForPath(p: PathInfo): Promise<string[]> {
        const isExcluded = this.isExcluded.bind(this);
        return new Promise((fulfill, reject) => {
            fs.readdir(path.join(this.rootPath, p.path), function(error, files) {
                if (error) {
                    if (error.code === "ENOENT") {
                        fulfill([]); // If the directory doesn't exist, then there are no IDs
                    }
                    else {
                        reject(error);
                    }
                }
                else {
                    fulfill(files.filter(function(name) {
                        return name.slice(name.length - (p.extension.length + 1), name.length) === ("." + p.extension);
                    }).map(function(name) {
                        return idForFilename(name.slice(0, name.length - (p.extension.length + 1)));
                    }).filter((id): id is string => id !== undefined && !isExcluded(id)));
                }
            });
        });
    }
};

export { FilesystemData };
