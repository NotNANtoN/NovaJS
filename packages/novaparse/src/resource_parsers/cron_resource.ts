import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";
import { NovaResources } from "./resource_holder_base.js";

/** One government's "local news" for a cron event. */
type CronGovtNews = {
    /** 'gövt' resource id whose planets/stations (and allies') show this news. */
    govt: number,
    /** STR# resource id a news string is randomly picked from while active. */
    newsStr: number,
};

/**
 * A crön: a timed, invisible event that manipulates control bits (and shows
 * news) at random or fixed points during the game.
 *
 * Field layout follows ResForge's crön template (822 bytes, matching Nova's
 * own data exactly), documented in the EVN Bible pp. 20-21.
 */
class CronResource extends BaseResource {
    /** First day of the month (1-31) the event can activate; 0/-1 = any. */
    firstDay: number;
    /** First month (1-12) the event can activate; 0/-1 = any. */
    firstMonth: number;
    /** First year the event can activate; 0/-1 = any. */
    firstYear: number;
    /** Last day of the month (1-31) the event can activate; 0/-1 = any. */
    lastDay: number;
    /** Last month (1-12) the event can activate; 0/-1 = any. */
    lastMonth: number;
    /** Last year the event can activate; 0/-1 = any. */
    lastYear: number;
    /** Percent chance the event activates during its date range; 100 = ASAP. */
    random: number;
    /** How long the event stays active, in days; 0 = OnStart and OnEnd together. */
    duration: number;
    /** Days to hold after activation before the event starts. */
    preHoldoff: number;
    /** Days to hold after the event ends before it can activate again. */
    postHoldoff: number;
    /** STR# id for independent news shown while active; -1 = none. */
    indNewsStr: number;

    flags: number;
    /** Loop OnStart until its conditions are false (bit 0x0001). */
    loopOnStart: boolean;
    /** Loop OnEnd until its conditions are false (bit 0x0002). */
    loopOnEnd: boolean;

    /** NCB test expression gating whether the event is eligible to activate. */
    enableOn: string;
    /** NCB set expression run when the event starts (after PreHoldoff). */
    onStart: string;
    /** NCB set expression run when the event ends. */
    onEnd: string;

    /** 64-bit flag set combined with the player's Contribute bits while active. */
    contribute: bigint;
    /** 64-bit flag set and'ed against the player's Contribute bits to activate. */
    require: bigint;

    /** Up to four govt/STR# "local news" pairs; unused entries omitted. */
    govtNews: Array<CronGovtNews>;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        this.firstDay = r.int16();
        this.firstMonth = r.int16();
        this.firstYear = r.int16();
        this.lastDay = r.int16();
        this.lastMonth = r.int16();
        this.lastYear = r.int16();
        this.random = r.int16();
        this.duration = r.int16();
        this.preHoldoff = r.int16();
        this.postHoldoff = r.int16();
        this.indNewsStr = r.int16(-1);

        this.flags = r.uint16();
        this.loopOnStart = Boolean(this.flags & 0x0001);
        this.loopOnEnd = Boolean(this.flags & 0x0002);

        this.enableOn = r.string(0xff);
        this.onStart = r.string(0xff);
        this.onEnd = r.string(0x100);

        this.contribute = r.uint64();
        this.require = r.uint64();

        // Parallel arrays: 4 govt ids then 4 STR# ids.
        const govts = r.array(4, () => r.int16(-1));
        const newsStrs = r.array(4, () => r.int16(-1));
        this.govtNews = [];
        for (let i = 0; i < 4; i++) {
            if (govts[i] >= 128) {
                this.govtNews.push({ govt: govts[i], newsStr: newsStrs[i] });
            }
        }
    }
}

export { CronResource };
