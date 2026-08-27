import 'jasmine';
import {
    SERVICE_COLUMN,
    SPACEPORT_LAYOUT,
    SPACEPORT_SERVICE_COLUMNS,
    SPACEPORT_SERVICES,
    SPACEPORT_FRAME,
    spaceportButtonColumn,
    SpaceportService,
} from './spaceport_layout';

// Button adds a 13px cap on either side of its tiled middle.
const BUTTON_CAPS = 2 * 13;

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
        const column = spaceportButtonColumn<SpaceportService>(
            ['bar', 'missionBBS']);
        expect(column.get('bar')).toEqual(SPACEPORT_LAYOUT.buttons.firstY);
        expect(column.get('missionBBS')).toEqual(
            SPACEPORT_LAYOUT.buttons.firstY + SPACEPORT_LAYOUT.buttons.pitch);
        expect(column.has('tradeCenter')).toBeFalse();
    });

    it('keeps a maximally stacked column and Leave within the frame', () => {
        const column = spaceportButtonColumn(SPACEPORT_SERVICES);
        const lowest = Math.max(...column.values()) + 25;
        expect(lowest).toBeLessThan(SPACEPORT_LAYOUT.buttons.leaveY);
        // The strip runs to y=517 in a frame centered on 258.5.
        expect(SPACEPORT_LAYOUT.buttons.leaveY + 25)
            .toBeLessThan(517 - 258.5);
    });

    it('assigns retail services to the correct strip in display order', () => {
        expect(SPACEPORT_SERVICE_COLUMNS.left).toEqual([
            'bar', 'missionBBS', 'tradeCenter']);
        expect(SPACEPORT_SERVICE_COLUMNS.right).toEqual([
            'shipyard', 'outfitter', 'recharge']);
        for (const service of SPACEPORT_SERVICE_COLUMNS.left) {
            expect(SERVICE_COLUMN[service]).toBe('left');
        }
        for (const service of SPACEPORT_SERVICE_COLUMNS.right) {
            expect(SERVICE_COLUMN[service]).toBe('right');
        }
    });

    it('compacts each strip independently when one service is absent', () => {
        const left = spaceportButtonColumn(SPACEPORT_SERVICE_COLUMNS.left);
        const right = spaceportButtonColumn(['outfitter', 'recharge']);

        expect(left.get('bar')).toEqual(SPACEPORT_LAYOUT.buttons.firstY);
        expect(left.get('missionBBS')).toEqual(
            SPACEPORT_LAYOUT.buttons.firstY + SPACEPORT_LAYOUT.buttons.pitch);
        expect(left.get('tradeCenter')).toEqual(
            SPACEPORT_LAYOUT.buttons.firstY
            + 2 * SPACEPORT_LAYOUT.buttons.pitch);
        expect(right.get('outfitter')).toEqual(
            SPACEPORT_LAYOUT.buttons.firstY);
        expect(right.get('recharge')).toEqual(
            SPACEPORT_LAYOUT.buttons.firstY + SPACEPORT_LAYOUT.buttons.pitch);
    });

    it('fits both complete service columns inside their measured strips', () => {
        for (const column of ['left', 'right'] as const) {
            const positions = spaceportButtonColumn(
                SPACEPORT_SERVICE_COLUMNS[column]);
            const layout = SPACEPORT_LAYOUT.buttons[column];
            const absoluteX = SPACEPORT_FRAME.width / 2 + layout.x;
            const lowest = Math.max(...positions.values())
                + SPACEPORT_LAYOUT.buttons.height;
            const stripStart = column === 'left' ? 3 : 463;
            const buttonStart = column === 'left' ? 3 : 469;
            const stripEnd = column === 'left' ? 141 : 615;

            expect(absoluteX).toEqual(buttonStart);
            expect(absoluteX).toBeGreaterThanOrEqual(stripStart);
            expect(absoluteX + layout.width + BUTTON_CAPS)
                .toEqual(stripEnd);
            expect(lowest).toBeLessThanOrEqual(
                SPACEPORT_LAYOUT.buttons.leaveY);
        }
    });

    it('keeps Leave separate from the complete service columns', () => {
        for (const column of ['left', 'right'] as const) {
            const positions = spaceportButtonColumn(
                SPACEPORT_SERVICE_COLUMNS[column]);
            const lowest = Math.max(...positions.values())
                + SPACEPORT_LAYOUT.buttons.height;

            expect(lowest).toBeLessThanOrEqual(
                SPACEPORT_LAYOUT.buttons.leaveY);
        }
        expect(
            SPACEPORT_LAYOUT.buttons.leaveY
            + SPACEPORT_LAYOUT.buttons.height)
            .toBeLessThan(SPACEPORT_FRAME.height - SPACEPORT_FRAME.height / 2);
        const rightStart = SPACEPORT_FRAME.width / 2
            + SPACEPORT_LAYOUT.buttons.right.x;
        expect(rightStart).toEqual(469);
        expect(rightStart + SPACEPORT_LAYOUT.buttons.right.width + BUTTON_CAPS)
            .toEqual(615);
    });

    it('uses three retail service slots in each column when all are present', () => {
        const left = spaceportButtonColumn(SPACEPORT_SERVICE_COLUMNS.left);
        const right = spaceportButtonColumn(SPACEPORT_SERVICE_COLUMNS.right);

        expect(left.size).toBe(3);
        expect(right.size).toBe(3);
        expect([...left.values()]).toEqual([
            SPACEPORT_LAYOUT.buttons.firstY,
            SPACEPORT_LAYOUT.buttons.firstY + SPACEPORT_LAYOUT.buttons.pitch,
            SPACEPORT_LAYOUT.buttons.firstY
            + 2 * SPACEPORT_LAYOUT.buttons.pitch,
        ]);
        expect([...right.values()]).toEqual([...left.values()]);
    });
});
