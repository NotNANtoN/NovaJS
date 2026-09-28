import { Resource } from "resource_fork";
import { NovaResources } from "./ResourceHolderBase";
import { BaseResource } from "./NovaResourceBase";

/**
 * EV Nova Bible, chär resource (verified against retail data, 362 bytes):
 * Cash i32@0, ShipType i16@4, System1-4 i16@6, Govt1-4 i16@14,
 * Status1-4 i16@22, Kills i16@30, IntroPictID1-4 i16@32,
 * IntroPictDelay1-4 i16@40, IntroTextID i16@48, OnStart string@50 (256),
 * Flags i16@306, StartDay/Month/Year i16@308/310/312,
 * DatePrefix string@314 (16), DateSuffix string@330 (16).
 */
export class CharResource extends BaseResource {
    readonly cash: number;
    readonly shipType: number;
    readonly systems: number[];
    readonly governments: number[];
    readonly status: number[];
    readonly kills: number;
    readonly introPicts: number[];
    readonly introPictDelays: number[];
    readonly introText: number;
    readonly onStart: string;
    readonly flags: number;
    readonly startDay: number;
    readonly startMonth: number;
    readonly startYear: number;
    readonly datePrefix: string;
    readonly dateSuffix: string;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const d = this.data;
        const int16s = (start: number, count: number) =>
            Array.from({ length: count }, (_, i) => d.getInt16(start + 2 * i));
        const getString = (start: number, length: number): string => {
            let s = "";
            for (let i = start; i < Math.min(start + length, d.byteLength); i++) {
                const value = d.getUint8(i);
                if (value === 0) break;
                s += String.fromCharCode(value);
            }
            return s;
        };

        this.cash = d.getInt32(0);
        this.shipType = d.getInt16(4);
        this.systems = int16s(6, 4);
        this.governments = int16s(14, 4);
        this.status = int16s(22, 4);
        this.kills = d.getInt16(30);
        this.introPicts = int16s(32, 4);
        this.introPictDelays = int16s(40, 4);
        this.introText = d.getInt16(48);
        this.onStart = getString(50, 256);
        this.flags = d.getInt16(306);
        this.startDay = d.getInt16(308);
        this.startMonth = d.getInt16(310);
        this.startYear = d.getInt16(312);
        this.datePrefix = getString(314, 16);
        this.dateSuffix = getString(330, 16);
    }
}
