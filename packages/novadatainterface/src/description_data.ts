import { BaseData, getDefaultBaseData } from "./base_data.js";

/**
 * A block of descriptive text (a dësc resource): spaceport bar descriptions,
 * mission briefings, outfit and ship descriptions, and so on.
 */
export interface DescriptionData extends BaseData {
    /**
     * The description text. Line endings are normalized to "\n" by the parser
     * (the resource itself stores classic-Mac "\r").
     */
    text: string;
    /** 'PICT' id shown alongside the text; -1 = none. */
    graphic: number;
}

export function getDefaultDescriptionData(): DescriptionData {
    return {
        ...getDefaultBaseData(),
        text: "",
        graphic: -1,
    };
}
