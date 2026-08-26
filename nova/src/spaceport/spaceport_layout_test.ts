import 'jasmine';
import {
    SPACEPORT_LAYOUT,
    SPACEPORT_SERVICES,
    spaceportButtonColumn,
} from './spaceport_layout';

describe('spaceportButtonColumn', () => {
    it('stacks every offered service evenly', () => {
        const column = spaceportButtonColumn(SPACEPORT_SERVICES);
        const ys = SPACEPORT_SERVICES.map(service => column.get(service)!);
        expect(ys[0]).toEqual(SPACEPORT_LAYOUT.buttons.firstY);
        const gap = ys[1] - ys[0];
        for (let index = 1; index < ys.length; index++) {
            expect(ys[index] - ys[index - 1]).toEqual(gap);
        }
    });

    it("keeps retail's pitch for a stellar the strip has room for", () => {
        const column = spaceportButtonColumn(
            ['shipyard', 'outfitter', 'tradeCenter', 'bar', 'missionBBS']);
        expect(column.get('outfitter')! - column.get('shipyard')!)
            .toEqual(SPACEPORT_LAYOUT.buttons.pitch);
    });

    it('moves later services up when one is not offered', () => {
        const column = spaceportButtonColumn(['shipyard', 'missionBBS']);
        expect(column.get('shipyard')).toEqual(SPACEPORT_LAYOUT.buttons.firstY);
        expect(column.get('missionBBS')).toEqual(
            SPACEPORT_LAYOUT.buttons.firstY + SPACEPORT_LAYOUT.buttons.pitch);
        expect(column.has('bar' as 'shipyard')).toBeFalse();
    });

    it('keeps the whole column and Leave on the right metal strip', () => {
        const column = spaceportButtonColumn(SPACEPORT_SERVICES);
        const lowest = Math.max(...column.values()) + 25;
        expect(lowest).toBeLessThan(SPACEPORT_LAYOUT.buttons.leaveY);
        // The strip runs to y=517 in a frame centered on 258.5.
        expect(SPACEPORT_LAYOUT.buttons.leaveY + 25)
            .toBeLessThan(517 - 258.5);
    });
});
