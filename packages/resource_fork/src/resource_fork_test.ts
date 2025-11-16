import { isRez, readResourceFork, readRez, ResourceMap } from "./index.js";
import * as fs from 'fs';
import * as path from 'path';

const testdata = path.resolve(import.meta.dirname, '../testdata');
const rezPath = path.resolve(testdata, 'test.rez');
const ndatPath = path.resolve(testdata, 'test.ndat');


function testResourceFork(getResources: () => Promise<ResourceMap>) {
    describe('reading resource fork data', () => {
        let resources: ResourceMap
        beforeEach(async () => {
            resources = await getResources();
        });

        it('gets the types of resources', () => {
            expect(resources.hasOwnProperty('wëap')).toBeTrue();
        });

        it('gets the names of resources', () => {
            expect(resources['wëap'][128].name).toEqual('blaster');;
        });

        it("gets data from resources", () => {
            const data = 'ff ff 00 1e 00 ea 00 7b ff ff 00 01 ff ff ff ff 00 00 ff ff 01 59 ff ff 00 00 00 00 00 00 00 00 ff ff 00 00 ff ff ff ff ff ff ff ff 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ff ff 00 00 00 00 ff ff 00 00 00 00 ff ff ff ff ff ff 00 00 00 00 00 00 ff ff ff ff ff ff 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ff ff 00 00 ff ff 00 00 00 00 ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff';
            expect(resources['wëap'][128].hexString).toEqual(data);
        });
    });
}

describe("resourceFork", function() {
    describe("readResourceFork", () => {
        describe("reading .ndat", () => {
            testResourceFork(() => {
                // pretend data fork is resource fork for compatability with other OSes
                return readResourceFork(ndatPath, false);
            });
        })
        describe("reading .rez", () => {
            testResourceFork(() => {
                return readResourceFork(ndatPath, false);
            });
        });
    });

    describe("isRez", () => {
        it("returns true for rez files", async () => {
            const rezFile = await fs.promises.readFile(rezPath);
            const rezView = new DataView(rezFile.buffer);
            expect(isRez(rezView)).toBeTrue();
        });

        it("returns false for other files", async () => {
            const file = await fs.promises.readFile(ndatPath);
            const dataView = new DataView(file.buffer);
            expect(isRez(dataView)).toBeFalse();
        });
    });

    describe('readRez', () => {
        testResourceFork(async () => {
            const rezFile = await fs.promises.readFile(rezPath);
            const rezView = new DataView(rezFile.buffer);
            return readRez(rezView);
        });
    });
});
