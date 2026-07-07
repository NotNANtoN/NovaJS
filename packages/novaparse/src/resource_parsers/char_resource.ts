import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";
import { NovaResources } from "./resource_holder_base.js";

/** An initial legal status the player has with a government when starting. */
interface CharGovtStatus {
    /** 'gövt' resource id this status applies to. */
    govt: number;
    /**
     * Legal record the player is given in systems owned by this govt (or its
     * allies). The negative of this value is applied in enemy-owned systems.
     */
    status: number;
}

/** A PICT shown during the intro sequence, with how long to display it. */
interface CharIntroPict {
    /** 'PICT' resource id to show. */
    pict: number;
    /** Maximum time to display this picture, in seconds. */
    delay: number;
}

/**
 * A "character template": one of the entry points the player can pick from
 * when starting a new pilot. Selecting one sets the starting ship, credits,
 * systems, legal records, intro sequence and start date.
 *
 * Field layout follows the EVN Bible p. 18. Real Nova chär resources are 362
 * bytes. ResForge's TMPL reports 356 because its FCNT list collapses the four
 * Starting System entries (8 bytes) into a single 2-byte entry in the offset
 * table; the real resource stores all four systems inline, accounting for the
 * 6 "missing" bytes. The parser reads all four and consumes the full 362.
 */
class CharResource extends BaseResource {
    /** Credits the player starts with. */
    startingCredits: number;
    /** 'shïp' resource id of the starting ship type. */
    startingShip: number;
    /**
     * Up to four 'sÿst' ids the player may randomly start in; unused entries
     * (-1) are dropped. If empty, the player starts in system 128.
     */
    startingSystems: number[];
    /** Initial per-government legal statuses; unused (govt -1) entries dropped. */
    govtStatuses: CharGovtStatus[];
    /** Starting combat rating (kills). */
    combatRating: number;
    /** Up to four intro pictures shown in sequence; unused (pict -1) dropped. */
    introPicts: CharIntroPict[];
    /** 'dësc' resource id of the intro text shown at game start. */
    introText: number;
    /** Control bit set (NCB) evaluated when a new pilot of this type starts. */
    onStart: string;

    flags: number;
    /** The "default" chär, auto-selected in the new-pilot popup menu. */
    isDefault: boolean;

    /** Starting day of the month (1-31). */
    startingDay: number;
    /** Starting month (1-12). */
    startingMonth: number;
    /** Starting year. */
    startingYear: number;
    /** String prepended to the date whenever it is displayed. */
    datePrefix: string;
    /** String appended to the date whenever it is displayed. */
    dateSuffix: string;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        this.startingCredits = r.int32();
        this.startingShip = r.int16(-1);

        const systems = r.array(4, () => r.int16(-1));
        this.startingSystems = systems.filter(s => s !== -1);

        // Nova stores the govt ids and their statuses as parallel arrays.
        const govts = r.array(4, () => r.int16(-1));
        const statuses = r.array(4, () => r.int16());
        this.govtStatuses = govts
            .map((govt, i) => ({ govt, status: statuses[i] }))
            .filter(({ govt }) => govt !== -1);

        this.combatRating = r.int16();

        const picts = r.array(4, () => r.int16(-1));
        const delays = r.array(4, () => r.int16());
        this.introPicts = picts
            .map((pict, i) => ({ pict, delay: delays[i] }))
            .filter(({ pict }) => pict !== -1);

        this.introText = r.int16(-1);
        this.onStart = r.string(0x100);

        this.flags = r.uint16();
        this.isDefault = Boolean(this.flags & 0x0001);

        this.startingDay = r.int16();
        this.startingMonth = r.int16();
        this.startingYear = r.int16();
        this.datePrefix = r.string(0x10);
        this.dateSuffix = r.string(0x10);
        r.skip(0x10); // Unused.
    }
}

export { CharResource, CharGovtStatus, CharIntroPict };
