import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";
import { NovaResources } from "./resource_holder_base.js";

/**
 * A weapon added to (or removed from) a përs ship's stock loadout. A negative
 * `count` removes that many of the ship's standard weapons.
 */
type PersWeap = {
    /** 'wëap' resource id. */
    id: number;
    count: number;
    /** Rounds of ammunition, or -1/0 for weapons that need none. */
    ammo: number;
};

/**
 * A unique person: a named AI personality the player can encounter, whose name
 * is shown on the target-info display in place of the ship class name. When a
 * ship is created there is a 5% chance a specific pers is created too.
 *
 * Field layout follows ResForge's përs template (400 bytes), documented in the
 * EVN Bible pp. 47-49.
 */
class PersResource extends BaseResource {
    /**
     * Which systems the person may be created in. -1 = any system;
     * 128-2175 = a specific sÿst; 9999 = independent systems;
     * 10000-10255 = a govt's systems; 15000-15255 = a govt's allies;
     * 20000-20255 = non-govt systems; 25000-25255 = a govt's enemies.
     */
    linkSystem: number;
    /** Governmental affiliation; -1 means the person is independent. */
    govt: number;

    /** AI behaviour: 1 wimpy trader, 2 brave trader, 3 warship, 4 interceptor. */
    aiType: number;
    /** How close ships must be before this person attacks: 1 close .. 3 far. */
    aggression: number;
    /** Percent of total shield capacity at which the person flees a fight. */
    cowardice: number;

    /** 'shïp' class id this person flies. */
    shipType: number;
    /**
     * Weapons added to / removed from the ship's stock loadout. Entries whose
     * weapon id is below 128 (no weapon) are dropped.
     */
    weapons: PersWeap[];

    /** Credits carried, +/-25%; 0 means none. */
    credits: number;
    /**
     * Percent shield capacity relative to a stock ship (100 = standard,
     * 130 = 30% stronger). A value below zero makes the person invincible.
     */
    shieldMod: number;

    /** PICT id shown in the comms dialog instead of the ship's standard image. */
    hailPict: number;
    /** Index into STR# 7100 shown in the communications dialog. */
    commQuote: number;
    /** Index into STR# 7101 shown over the radio at the bottom of the screen. */
    hailQuote: number;
    /** mïsn activated when this ship is boarded or hailed. */
    linkMission: number;

    flags: number;
    keepsGrudge: boolean;
    usesEscapePodAndAfterburner: boolean;
    hailOnlyWithGrudge: boolean;
    hailOnlyWhenLikesPlayer: boolean;
    hailOnlyWhenAttacking: boolean;
    hailOnlyWhenDisabled: boolean;
    replaceWithSpecialShip: boolean;
    hailOnlyOnce: boolean;
    deactivateAfterMission: boolean;
    offerMissionOnBoarding: boolean;
    hailOnlyWhenMissionAvailable: boolean;
    leavesAfterMissionAccepted: boolean;
    noMissionIfWimpyTrader: boolean;
    noMissionIfBeefyTrader: boolean;
    noMissionIfWarship: boolean;
    showDisasterInfoWhenHailing: boolean;

    /** Control-bit test expression; empty if unused. Stored raw, not parsed. */
    activeOn: string;

    /** ItemClass of outfit granted when boarded; 0/-1 if unused. */
    grantClass: number;
    /** Max outfits granted when boarded; actual is between grantCount/2 and it. */
    grantCount: number;
    /** Percent chance the person grants outfits when boarded; 0 if unused. */
    grantChance: number;

    /** Subtitle shown under the person's name. */
    subtitle: string;
    /** Ship paint colour as 00RRGGBB; 0 (== 00FFFFFF) means unpainted. */
    color: number;

    flags2: number;
    startsWithNoFuel: boolean;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        this.linkSystem = r.int16(-1);
        this.govt = r.int16(-1);
        this.aiType = r.int16();
        this.aggression = r.int16();
        this.cowardice = r.int16();
        this.shipType = r.int16(-1);

        const weapIds = r.array(4, () => r.int16(-1));
        const counts = r.array(4, () => r.int16());
        const ammo = r.array(4, () => r.int16());
        this.weapons = [];
        for (let i = 0; i < 4; i++) {
            if (weapIds[i] >= 128) {
                this.weapons.push({
                    id: weapIds[i],
                    count: counts[i],
                    ammo: ammo[i],
                });
            }
        }

        this.credits = r.int32();
        this.shieldMod = r.int16();

        this.hailPict = r.int16(-1);
        this.commQuote = r.int16(-1);
        this.hailQuote = r.int16(-1);
        this.linkMission = r.int16(-1);

        this.flags = r.uint16();
        this.keepsGrudge = Boolean(this.flags & 0x0001);
        this.usesEscapePodAndAfterburner = Boolean(this.flags & 0x0002);
        this.hailOnlyWithGrudge = Boolean(this.flags & 0x0004);
        this.hailOnlyWhenLikesPlayer = Boolean(this.flags & 0x0008);
        this.hailOnlyWhenAttacking = Boolean(this.flags & 0x0010);
        this.hailOnlyWhenDisabled = Boolean(this.flags & 0x0020);
        this.replaceWithSpecialShip = Boolean(this.flags & 0x0040);
        this.hailOnlyOnce = Boolean(this.flags & 0x0080);
        this.deactivateAfterMission = Boolean(this.flags & 0x0100);
        this.offerMissionOnBoarding = Boolean(this.flags & 0x0200);
        this.hailOnlyWhenMissionAvailable = Boolean(this.flags & 0x0400);
        this.leavesAfterMissionAccepted = Boolean(this.flags & 0x0800);
        this.noMissionIfWimpyTrader = Boolean(this.flags & 0x1000);
        this.noMissionIfBeefyTrader = Boolean(this.flags & 0x2000);
        this.noMissionIfWarship = Boolean(this.flags & 0x4000);
        this.showDisasterInfoWhenHailing = Boolean(this.flags & 0x8000);

        this.activeOn = r.string(256);

        this.grantClass = r.int16();
        this.grantCount = r.int16();
        this.grantChance = r.int16();

        this.subtitle = r.string(64);
        this.color = r.uint32();

        this.flags2 = r.uint16();
        this.startsWithNoFuel = Boolean(this.flags2 & 0x0001);
    }
}

export { PersResource };
