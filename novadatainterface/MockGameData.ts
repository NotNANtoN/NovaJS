import { DEFAULT_FACTORIES } from "./Defaults";
import { GameDataInterface } from "./GameDataInterface";
import { Gettable } from "./Gettable";
import { ALL_NOVA_DATA_TYPES, NovaDataInterface, NovaDataType } from "./NovaDataInterface";
import { NovaIDs } from "./NovaIDs";

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

    override getCached(id: string): T | undefined {
        const val = this.map.get(id);
        if (val !== undefined) {
            return val;
        }
        return this.defaultValue;
    }
}

type ExtractGettableType<T> = T extends Gettable<infer T> ? T : never;

type MockNovaDataInterface = {
    [P in keyof NovaDataInterface]-?: MockGettable<ExtractGettableType<NovaDataInterface[P]>>
}

const IMAGE_DATA_TYPES = new Set<NovaDataType>([
    NovaDataType.PictImage,
    NovaDataType.CicnImage,
    NovaDataType.SpriteSheetImage,
]);

function buildMockData(): MockNovaDataInterface {
    const data = {} as Record<NovaDataType, MockGettable<unknown>>;
    for (const type of ALL_NOVA_DATA_TYPES) {
        const defaultVal = IMAGE_DATA_TYPES.has(type)
            ? (new Uint8Array(0).buffer as ArrayBuffer)
            : DEFAULT_FACTORIES[type]();
        data[type] = new MockGettable(defaultVal);
    }
    return data as MockNovaDataInterface;
}

export class MockGameData implements GameDataInterface {
    data: MockNovaDataInterface = buildMockData();
    get ids(): Promise<NovaIDs> {
        const ids: NovaIDs = {} as NovaIDs;
        for (const [key, val] of Object.entries(this.data)) {
            ids[key as keyof NovaDataInterface] = (val as MockGettable<unknown>).getIds();
        }

        return Promise.resolve<NovaIDs>(ids);
    }
}
