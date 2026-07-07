import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";
import { NovaResources } from "./resource_holder_base.js";

/**
 * A player rank: a sense of "belonging" to a government, granting privileges
 * whose name is shown in the player-info dialog while the rank is active.
 *
 * Field layout follows ResForge's ränk template (152 bytes), documented in the
 * EVN Bible pp. 50-51.
 */
class RankResource extends BaseResource {
    /**
     * Importance relative to other active ranks. Higher-weight ranks are shown
     * first, and the highest-weight active rank fills the <PRK>/<PSR> tags.
     */
    weight: number;
    /** Government affiliated with this rank. */
    affilGovt: number;
    /**
     * Percent modifier on item and ship prices at planets owned by the affiliated
     * government; 100 = unchanged.
     */
    priceMod: number;
    /** Credits per day the affiliated government pays the player. */
    salary: number;
    /** Player cash above which the salary stops; 0 (or -1) means uncapped. */
    salaryCap: number;
    /** 64 bits of Contribute values that apply while this rank is active. */
    contribute: bigint;

    flags: number;
    dropOtherRanksWhenActivated: boolean;
    dropOtherRanksWhenDeactivated: boolean;
    dropIfDestroyGovtOrAllyShip: boolean;
    permanent: boolean;
    dropLowerRanksWhenActivated: boolean;
    dropLowerRanksWhenDeactivated: boolean;
    dropIfCrimeAgainstGovt: boolean;
    govtShipsWontAttack: boolean;
    canAlwaysLandOnGovtStellars: boolean;
    canRequestBattleAssistance: boolean;
    freeRefuelAndRepair: boolean;

    /**
     * The rank name used in conversation, mission briefings, and the <PRK> tag.
     * Empty means the rank is never referenced in conversation.
     */
    convName: string;
    /** The short rank name used in conversation and the <PSR> tag. */
    convShortName: string;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        this.weight = r.int16();
        this.affilGovt = r.int16(-1);
        this.priceMod = r.int16();
        this.salary = r.int32();
        this.salaryCap = r.int32();
        this.contribute = r.uint64();

        this.flags = r.uint16();
        this.dropOtherRanksWhenActivated = Boolean(this.flags & 0x0001);
        this.dropOtherRanksWhenDeactivated = Boolean(this.flags & 0x0002);
        this.dropIfDestroyGovtOrAllyShip = Boolean(this.flags & 0x0004);
        this.permanent = Boolean(this.flags & 0x0008);
        this.dropLowerRanksWhenActivated = Boolean(this.flags & 0x0010);
        this.dropLowerRanksWhenDeactivated = Boolean(this.flags & 0x0020);
        this.dropIfCrimeAgainstGovt = Boolean(this.flags & 0x0040);
        this.govtShipsWontAttack = Boolean(this.flags & 0x0100);
        this.canAlwaysLandOnGovtStellars = Boolean(this.flags & 0x0200);
        this.canRequestBattleAssistance = Boolean(this.flags & 0x0400);
        this.freeRefuelAndRepair = Boolean(this.flags & 0x0800);

        this.convName = r.string(64);
        this.convShortName = r.string(64);
    }
}

export { RankResource };
