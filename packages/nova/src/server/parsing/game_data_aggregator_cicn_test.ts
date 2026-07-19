import "jasmine";
import { GameDataInterface } from "novadatainterface/game_data_interface";
import { Gettable } from "novadatainterface/gettable";
import { MockGameData } from "novadatainterface/mock_game_data";
import { NovaIDNotFoundError } from "novadatainterface/nova_data_interface";
import { GameDataAggregator } from "./game_data_aggregator.js";

/**
 * The server layers the manually-exported assets in packages/nova/objects
 * (a FilesystemData source) OVER the parsed Nova data. That overlay is wired
 * as `new GameDataAggregator([filesystemData, novaFileData])`, and the
 * aggregator returns the first source that resolves an id. This test pins
 * that precedence for CicnImage specifically, since novaparse now produces
 * cicn PNGs that must remain overridable by the objects overlay.
 */
describe("GameDataAggregator CicnImage precedence", () => {
    function pngLike(marker: number): ArrayBuffer {
        return new Uint8Array([marker]).buffer;
    }

    it("returns the overlay (first) source's CicnImage over a later source", async () => {
        const overlay = new MockGameData();
        const parsed = new MockGameData();
        overlay.data.CicnImage.map.set("targetHostile", pngLike(1));
        parsed.data.CicnImage.map.set("targetHostile", pngLike(2));

        const aggregator = new GameDataAggregator([overlay, parsed],
            () => { });
        const result = new Uint8Array(
            await aggregator.data.CicnImage.get("targetHostile"));
        expect([...result]).toEqual([1]);
    });

    it("falls through to the later source when the overlay lacks the id", async () => {
        // A source whose CicnImage throws NovaIDNotFoundError for every id,
        // like FilesystemData does when an object file is absent. (MockGameData
        // returns a default buffer instead of throwing, which would never fall
        // through, so use a bespoke throwing source here.)
        const overlayMock = new MockGameData();
        const overlay: GameDataInterface = {
            ids: overlayMock.ids,
            data: {
                ...overlayMock.data,
                CicnImage: new Gettable(async (id: string) => {
                    throw new NovaIDNotFoundError(id);
                }),
            },
        };
        const parsed = new MockGameData();
        // Only the parsed source has cicn 10008.
        parsed.data.CicnImage.map.set("10008", pngLike(9));

        const aggregator = new GameDataAggregator([overlay, parsed],
            () => { });
        const result = new Uint8Array(
            await aggregator.data.CicnImage.get("10008"));
        expect([...result]).toEqual([9]);
    });
});
