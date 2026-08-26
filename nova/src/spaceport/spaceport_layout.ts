/**
 * Geometry for the retail landing dialog, PICT 8500 (618x517).
 *
 * Measured from the artwork itself: the opaque black regions are the
 * artwork slot (x=3 y=3 612x285), the stellar name slot (x=152 y=293
 * 311x29) and the description panel (x=141 y=325 322x192). The two metal
 * areas flanking the description panel carry no slot, because retail draws
 * the service buttons straight onto the metal. Only the right-hand strip
 * (x=463..615, y=293..517) is wide enough for a 120px button.
 *
 * Coordinates below are centered on the dialog, matching Menu containers.
 */
export const SPACEPORT_FRAME = {
    width: 618,
    height: 517,
} as const;

const CENTER_X = SPACEPORT_FRAME.width / 2;
const CENTER_Y = SPACEPORT_FRAME.height / 2;

function centered(x: number, y: number) {
    return { x: x - CENTER_X, y: y - CENTER_Y };
}

export const SPACEPORT_LAYOUT = {
    artwork: centered(3, 3),
    title: { ...centered(152 + 311 / 2, 297), width: 311 },
    description: { ...centered(141 + 10, 325 + 10), width: 301 },
    /** Top-left origin of the button column, on the right metal strip. */
    buttons: {
        x: centered(469, 0).x,
        firstY: centered(0, 300).y,
        /** Button art is 25px tall; 32px leaves a hairline of metal. */
        pitch: 32,
        /** Leave sits at the foot of the strip, away from the services. */
        leaveY: centered(0, 476).y,
    },
} as const;

/** Landing services, in the order retail lists them. */
export const SPACEPORT_SERVICES = [
    'shipyard', 'outfitter', 'tradeCenter', 'bar', 'missionBBS',
] as const;

export type SpaceportService = typeof SPACEPORT_SERVICES[number];

/** The spöb service flag backing each button, where one exists. */
export const SERVICE_FLAG = {
    shipyard: 'shipyard',
    outfitter: 'outfitter',
    tradeCenter: 'commodity',
    bar: 'bar',
    missionBBS: 'bar',
} as const;

/**
 * Retail lists the services top to bottom and simply omits the ones a
 * stellar does not offer, so the remaining buttons move up rather than
 * leaving a hole in the column.
 */
export function spaceportButtonColumn<T extends string>(
    visible: readonly T[],
): Map<T, number> {
    const { firstY, pitch } = SPACEPORT_LAYOUT.buttons;
    return new Map(visible.map(
        (name, index) => [name, firstY + index * pitch]));
}
