import { GameDataInterface, PreloadData } from "novadatainterface/GameDataInterface";
import {
    ALL_NOVA_DATA_TYPES,
    NovaDataInterface,
    NovaDataInterfaceWithMission,
    NovaDataType,
    NovaDataTypeMap,
    PRELOAD_NOVA_DATA_TYPES,
} from "novadatainterface/NovaDataInterface";
import { Gettable, GettableData } from "novadatainterface/Gettable";
import { BaseData } from "novadatainterface/BaseData";
import { SpriteSheetFramesData } from "novadatainterface/SpriteSheetData";
import { getDefaultNovaIDs, NovaIDs } from "novadatainterface/NovaIDs";
import { Defaults } from "novadatainterface/Defaults";

/**
 * Combines multiple GameDataInterface instances into a single GameDataInterface
 * with access to all of their data.
 */
class GameDataAggregator implements GameDataInterface {
    readonly data: NovaDataInterfaceWithMission;
    readonly ids: Promise<NovaIDs>;
    readonly preloadData: Promise<PreloadData>;
    private dataSources: Array<GameDataInterface>;
    private warningReporter: (w: string) => void;

    constructor(dataSources: Array<GameDataInterface>, warningReporter = console.log) {
        this.dataSources = dataSources;
        this.warningReporter = warningReporter;

        const aggregated = {} as { [K in NovaDataType]: Gettable<NovaDataTypeMap[K]> };
        for (const dataType of ALL_NOVA_DATA_TYPES) {
            (aggregated as Record<NovaDataType, Gettable<unknown>>)[dataType] =
                this.makeAggregator(dataType);
        }
        this.data = aggregated;

        this.ids = this.getAllIDs();

        this.preloadData = this.getPreloadData();
    }

    getDataSources() {
        return this.dataSources;
    }

    private makeAggregator<T extends (BaseData | ArrayBuffer | SpriteSheetFramesData)>(dataType: NovaDataType): Gettable<T> {
        // Arrow functions automatically bind this
        return new Gettable<T>(async (id: string): Promise<T> => {
            var errors: Array<string> = [];

            for (var i in this.getDataSources()) {
                var dataSource: GameDataInterface = this.dataSources[i];
                try {
                    return <T>await dataSource.data[dataType]!.get(id);
                }
                catch (e) {
                    if (e instanceof Error) {
                        if (e.stack) {
                            errors.push(e.stack);
                        }
                    }
                    else {
                        errors.push(String(e));
                    }
                }
            }

            this.warningReporter(id + " not found under " + dataType + ". Using default instead. "
                + "\nStacktraces:\n"
                + errors.join("\n"));

            return <T>Defaults[dataType];
        });
    }

    private async getAllIDs(): Promise<NovaIDs> {
        const IDs = getDefaultNovaIDs();

        for (let i in this.dataSources) {
            var dataSource = this.dataSources[i];
            var newIDs = await dataSource.ids;
            for (let dataType in newIDs) {
                const novaDataType = <NovaDataType>dataType;
                IDs[<NovaDataType>dataType] = [
                    ...(IDs[novaDataType] ?? []),
                    ...(newIDs[<NovaDataType>dataType] ?? [])
                ];
            }
        }
        return IDs;
    }

    private async getPreloadData() {
        const preloadDataList = (await Promise.all(this.dataSources.map(d => d.preloadData)))
            .filter((d: PreloadData | undefined): d is PreloadData => Boolean(d));

        const preloadData: PreloadData = {};
        for (const entry of preloadDataList) {
            for (const [uncastKey, dataMap] of Object.entries(entry)) {
                const key = uncastKey as keyof typeof entry;
                if (!preloadData[key]) {
                    preloadData[key] = {};
                }
                const fullMap = preloadData[key]!;
                for (const [id, val] of Object.entries(dataMap)) {
                    fullMap[id] = val;
                }
            }
        }

        for (const dataType of PRELOAD_NOVA_DATA_TYPES) {
            (preloadData as Record<NovaDataType, unknown>)[dataType] =
                await this.preloadResource(dataType);
        }
        return preloadData;
    }

    private async preloadResource<Data extends NovaDataType>(dataType: Data) {
        const allIds = await this.ids;
        const ids = allIds[dataType] ?? [];

        const CHUNK_SIZE = 32;
        const loaded: Array<[string, any]> = [];
        for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            const chunk = ids.slice(i, i + CHUNK_SIZE);
            const chunkResults = await Promise.all(chunk.map(async (id) => {
                const data = await this.data[dataType]!.get(id);
                return [id, data] as const;
            }));
            loaded.push(...(chunkResults as Array<[string, any]>));
        }

        return Object.fromEntries(loaded) as {
            [index: string]: GettableData<NovaDataInterface[Data]>
        };
    }
}

export { GameDataAggregator };

