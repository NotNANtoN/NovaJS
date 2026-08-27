/**
 * Geometry for the retail landing dialog, PICT 8500 (618x517).
 *
 * Measured from the artwork itself: the opaque black regions are the
 * artwork slot (x=3 y=3 612x285), the stellar name slot (x=152 y=293
 * 311x29) and the description panel (x=141 y=325 322x192). The two metal
 * areas flanking the description panel carry no slot, because retail draws
 * the service buttons straight onto the metal.
 *
 * Coordinates below are centered on the dialog, matching Menu containers.
 *
 * Pixel-column measurements of the supplied retail renders, mapped back to
 * this 618px-wide PICT, put the left metal strip at x=3..141 (138px) and the
 * right strip at x=463..615 (152px). Button caps are 13px each, so the
 * renderer's 120px middle is 146px overall: it fits on the right, while the
 * left column uses a 112px middle for a 138px overall button.
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
    buttons: {
        /** The left button's full 138px span fits x=3..141. */
        left: {
            x: centered(3, 0).x,
            width: 112,
        },
        /** The right button's full 146px span fits x=469..615. */
        right: {
            x: centered(469, 0).x,
            width: 120,
        },
        firstY: centered(0, 300).y,
        /** Button art is 25px tall; 32px leaves a hairline of metal. */
        pitch: 32,
        height: 25,
        /** Leave sits at the foot of the strip, away from the services. */
        leaveY: centered(0, 476).y,
    },
} as const;

/** Landing services, in the order retail lists them. */
export const SPACEPORT_SERVICES = [
    'shipyard', 'outfitter', 'tradeCenter', 'bar', 'missionBBS', 'recharge',
] as const;

export type SpaceportService = typeof SPACEPORT_SERVICES[number];

/** Retail's fixed service-to-strip assignment. */
export const SPACEPORT_SERVICE_COLUMNS = {
    left: ['bar', 'missionBBS', 'tradeCenter'],
    right: ['shipyard', 'outfitter', 'recharge'],
} as const;

export type SpaceportButtonColumn = keyof typeof SPACEPORT_SERVICE_COLUMNS;

export const SERVICE_COLUMN: Record<
    SpaceportService, SpaceportButtonColumn
> = {
    shipyard: 'right',
    outfitter: 'right',
    tradeCenter: 'left',
    bar: 'left',
    missionBBS: 'left',
    recharge: 'right',
};

/** The spöb service flag backing each button, where one exists. */
export const SERVICE_FLAG = {
    shipyard: 'shipyard',
    outfitter: 'outfitter',
    tradeCenter: 'commodity',
    bar: 'bar',
    missionBBS: 'bar',
    // Refuelling is not a service flag: it follows whether anyone lives here.
    recharge: 'commodity',
} as const;

/**
 * Retail simply omits unavailable services, so the remaining buttons move up
 * rather than leaving a hole. Call this once for each metal-strip column so
 * a missing service only closes the gap in its own column.
 */
export function spaceportButtonColumn<T extends string>(
    visible: readonly T[],
): Map<T, number> {
    const { firstY, pitch, leaveY, height } = SPACEPORT_LAYOUT.buttons;
    // Retail's 32px pitch fits five services above Leave. A stellar offering
    // more than that closes the gaps just enough to stay on the strip rather
    // than running a button off the bottom.
    const available = leaveY - firstY - height;
    const fitted = visible.length > 1
        ? Math.min(pitch, Math.floor(available / (visible.length - 1)))
        : pitch;
    return new Map(visible.map(
        (name, index) => [name, firstY + index * fitted]));
}
