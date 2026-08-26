import 'jasmine';
import { getEmptyNovaResources } from '../resource_parsers/ResourceHolderBase';
import { SystResource } from '../resource_parsers/SystResource';
import { SystemParse } from './SystemParse';

describe('SystemParse fleet entries', () => {
    it('preserves a flët leader and independent escort ranges', async () => {
        const idSpace = getEmptyNovaResources();
        const shipIds = [140, 141, 142, 143];
        for (const id of shipIds) {
            idSpace.shïp[id] = {
                globalID: `nova:${id}`,
            } as never;
        }
        idSpace.flët[129] = {
            globalID: 'nova:129',
            leadShipType: 140,
            escortTypes: [141, 142, 143, -1],
            minEscorts: [1, 0, 2, 0],
            maxEscorts: [3, 0, 4, 0],
            government: 5,
            linkSyst: -1,
        } as never;

        const syst = Object.create(SystResource.prototype) as SystResource;
        syst.id = 200;
        syst.name = 'Test system';
        syst.globalID = 'nova:200';
        syst.prefix = 'nova';
        syst.idSpace = idSpace;
        syst.position = [0, 0];
        syst.links = new Set();
        syst.spobs = [];
        syst.dudeTypes = [-129, 0, 0, 0, 0, 0, 0, 0];
        syst.dudeProbabilities = [7, 0, 0, 0, 0, 0, 0, 0];
        syst.avgShips = 4;
        syst.government = -1;
        syst.asteroids = 0;

        const parsed = await SystemParse(syst, message => {
            throw new Error(message);
        });

        expect(parsed.npcs).toEqual([{
            id: 'nova:129',
            weight: 7,
            government: 5,
            combatRole: 'military',
            kind: 'fleet',
            fleet: {
                leader: { id: 'nova:140', weight: 1 },
                escorts: [
                    { id: 'nova:141', weight: 1, min: 1, max: 3 },
                    { id: 'nova:143', weight: 1, min: 2, max: 4 },
                ],
            },
            // Compatibility data retains one entry per ship class; it does
            // not change the grouped fleet definition above.
            ships: [
                { id: 'nova:140', weight: 1 },
                { id: 'nova:141', weight: 1 },
                { id: 'nova:143', weight: 1 },
            ],
        }]);
    });
});
