/**
 * Typed contents of an EV Nova pilot (saved-game) file.
 *
 * Byte layout authority: "EV Nova Pilot File Format" by the EV community
 * (https://andrews05.github.io/evstuff/guides/pilotformat.txt), cross-checked
 * against vasi's evnova-utils pilot reader
 * (https://github.com/vasi/evnova-utils, Scripts/lib/Nova/Old/pilot/read.pl).
 * See packages/novaparse/docs/pilot_file_format.md for a summary.
 *
 * Index-to-resource-id convention: most arrays here are indexed by
 * `resourceId - 128`, mirroring the game's fixed-capacity tables. E.g.
 * `exploration[i]` describes sÿst `128 + i`, `outfitCount[i]` describes
 * oütf `128 + i`, and `player.shipClass + 128` is the pilot's shïp id.
 * {@link PILOT_RESOURCE_INDEX_OFFSET} names that constant.
 *
 * Fields the community format doc marks as unknown/unused are preserved as
 * documented `raw*`/`unknown*` ranges instead of being interpreted.
 */

/** Arrays in a pilot file are indexed by `resourceId - 128`. */
export const PILOT_RESOURCE_INDEX_OFFSET = 128;

/** A calendar date as stored in the pilot file. */
export interface PilotDate {
    year: number;
    /** 1-12. */
    month: number;
    /** 1-31. */
    day: number;
}

/** Per-mission objective status (MissionObjectives, 20 bytes). */
export interface PilotMissionObjectives {
    /** This mission slot holds a running mission. */
    active: boolean;
    /** Player has visited the assigned destination. */
    travelObjComplete: boolean;
    /** Player has completed the special-ship assignment. */
    shipObjComplete: boolean;
    /** The mission was failed. */
    missionFailed: boolean;
    /** Unused here according to the format doc (also stored in flags). */
    flags: number;
    /** Mission completion deadline (unused by the game; it uses timeLeft). */
    deadline: PilotDate;
}

/**
 * Per-mission parameters (MissionData; 2284 bytes on Mac, 2278 in the
 * Windows .plt format, which drops three unused padding runs).
 *
 * These mirror the fields of the 'mïsn' resource the mission was
 * instantiated from, with runtime state mixed in.
 */
export interface PilotMissionData {
    /**
     * 'mïsn' index this slot was instantiated from (resource id = index +
     * 128; verified against stock data: a pilot running "Take Krane to
     * Earth" stores 346, and mïsn 474 is that mission).
     */
    missionId: number;
    /** Destination stellar (spöb index; id = index + 128). */
    travelStellar: number;
    /** Return stellar (spöb index). */
    returnStellar: number;
    /** Remaining special ships. */
    specialShipCount: number;
    specialShipDude: number;
    specialShipGoal: number;
    specialShipBehavior: number;
    specialShipStart: number;
    specialShipSyst: number;
    cargoType: number;
    cargoQty: number;
    pickupMode: number;
    dropoffMode: number;
    scanMask: number;
    compGovt: number;
    compReward: number;
    datePostInc: number;
    /** Payment on completion, in credits. */
    pay: number;
    specialShipsKilled: number;
    specialShipsBoarded: number;
    specialShipsDisabled: number;
    specialShipsJumpedIn: number;
    specialShipsJumpedOut: number;
    /** Special-ship count at mission start. */
    initialShipCount: number;
    canAbort: boolean;
    /** Mission cargo is aboard the player's ship. */
    cargoLoaded: boolean;
    /** 'dësc' ids of the mission's text blurbs. */
    briefText: number;
    quickBriefText: number;
    loadCargoText: number;
    dropOffCargoText: number;
    compText: number;
    failText: number;
    refuseText: number;
    shipDoneText: number;
    /** Days remaining to complete the mission. */
    timeLeft: number;
    /** 'STR#' resource used to name the special ships, and index within. */
    specialShipNameResId: number;
    specialShipNameIndex: number;
    specialShipSubtitleResId: number;
    specialShipSubtitleIndex: number;
    /** Index of the pre-selected ship slot within the dude resource. */
    specialShipPreselectType: number;
    flags: number;
    flags2: number;
    auxShipCount: number;
    auxShipDude: number;
    auxShipSyst: number;
    auxShipsJumpedIn: number;
    auxShipDelay: number;
    auxShipsLeft: number;
    specialShipName: string;
    specialShipSubtitle: string;
    /** Control-bit set strings evaluated on the corresponding events. */
    onAccept: string;
    onRefuse: string;
    onSuccess: string;
    onFailure: string;
    onAbort: string;
    onShipDone: string;
    missionName: string;
    /** short unknown[64] at MissionData offset 0x869; meaning undocumented. */
    unknownShorts: number[];
}

/** One of the 16 mission slots. */
export interface PilotMission {
    objectives: PilotMissionObjectives;
    data: PilotMissionData;
}

/** An escort slot that is in use. */
export interface PilotEscort {
    /** Slot index, 0-63. */
    slot: number;
    /** shïp class index (id = index + 128). */
    shipClass: number;
    /** Hired (true) vs captured (false). */
    hired: boolean;
    /** Escort is scheduled for upgrade. */
    scheduledUpgrade: boolean;
    /** Escort is scheduled for sale. */
    scheduledSale: boolean;
    /** 0 = even-numbered voice sounds, 1 = odd; -1 when not applicable. */
    voiceMode: number;
}

/** A deployed fighter slot that is in use. */
export interface PilotFighter {
    /** Slot index, 0-63. */
    slot: number;
    /** shïp class index (id = index + 128). */
    shipClass: number;
}

/**
 * NpïL resource 128, "Pilot Data" (PlayerFileDataStruct, 59826 bytes on
 * Mac / 59730 in .plt): the player's own state.
 */
export interface PilotPlayerData {
    /** Last stellar landed on (spöb index; id = index + 128). */
    lastStellar: number;
    /** Player's ship class (shïp index; id = index + 128). */
    shipClass: number;
    /** Quantity of each of the six basic cargo types aboard. */
    cargo: number[];
    /** Unused by the game (shield is recomputed on load). */
    unusedShield: number;
    /** Current fuel, 100 units per jump. */
    fuel: number;
    /** Current game date. */
    date: PilotDate;
    /**
     * Exploration state of each of the 2048 systems (sÿst id = index + 128):
     * <= 0 unexplored, 1 visited, 2 visited and landed within.
     */
    exploration: number[];
    /** Owned count of each of the 512 outfits (oütf id = index + 128). */
    outfitCount: number[];
    /** Legal status in each of the 2048 systems (0 = neutral). */
    legalStatus: number[];
    /** Count of each of the 256 weapons aboard (wëap id = index + 128). */
    weaponCount: number[];
    /** Ammo count for each of the 256 weapons. */
    ammo: number[];
    /** Credits. */
    cash: number;
    /** The 16 mission slots (both active and inactive; check .objectives.active). */
    missions: PilotMission[];
    /** The 10000 mission bits (NCBs). */
    missionBits: boolean[];
    /** Whether each of the 2048 stellars is dominated (spöb id = index + 128). */
    dominated: boolean[];
    /** Escorts currently in service. */
    escorts: PilotEscort[];
    /** Fighters currently deployed from the player's bays. */
    fighters: PilotFighter[];
    /** Combat rating (kill count). */
    rating: number;
}

/**
 * NpïL resource 129 (AltPlayerFileDataStruct, 26366 bytes): universe state.
 * The *name* of this resource is the name of the player's ship.
 */
export interface PilotGlobalsData {
    /** Save format version; 300 in EV Nova 1.0.10/1.1.1 saves. */
    versionInfo: number;
    /** Strict play is enabled. */
    strictPlay: boolean;
    /** 1 = male. */
    gender: number;
    /** Defense ships remaining at each of the 2048 stellars. */
    stellarShipCount: number[];
    /** Whether each of the 1024 'përs's is alive. */
    personAlive: boolean[];
    /** Whether each 'përs' holds a grudge against the player. */
    personGrudge: boolean[];
    /** short unused[64] at 0x2006; ignored by the game. */
    rawUnused0x2006: number[];
    /** Each stellar's propensity to overthrow the player's rule. */
    stellarAnnoyance: number[];
    /** The player has seen the game intro screen. */
    seenIntroScreen: boolean;
    /** Unknown byte at 0x3087 (0 in practice). */
    unknown0x3087: number;
    /** Time left on each of the 256 disasters (< 0 = inactive). */
    disasterTime: number[];
    /** Stellar where each disaster is active. */
    disasterStellar: number[];
    /** Amount of each of the 128 'jünk' commodities aboard. */
    junkQty: number[];
    /** Global price fluctuations (short[2][2], flattened). */
    priceFlux: number[];
    /** Remaining duration of each of the 512 'crön' events. */
    cronDurations: number[];
    /** Holdoff of each 'crön' event. */
    cronHoldoffs: number[];
    /** Days until each system's defense reinforcements regenerate. */
    reinforcements: number[];
    /** Days until each destroyed stellar regenerates (-1 = alive). */
    stellarDestroyed: number[];
    /**
     * Orders given to each of the 4 escort categories:
     * 0 formation, 1 defend, 2 attack, 3 return to hangar, 4 hold position.
     */
    escortOrders: number[];
    /** The player's nickname. */
    nickname: string;
    /** Ship color components, each 0-32. */
    shipColor: { red: number, green: number, blue: number };
    /** Whether each of the 128 'ränk's is active. */
    rankActive: number[];
    /** String shown before the date (from the chär resource). */
    datePrefix: string;
    /** String shown after the date, e.g. " NC". */
    dateSuffix: string;
    /** short unknown[1024] at 0x5efe; zero in practice. */
    rawUnknownTail: number[];
}

/** A fully parsed pilot file. */
export interface PilotData {
    /**
     * Container the pilot came from: 'mac' = resource fork with 'NpïL' 128 &
     * 129, 'plt' = the flat Windows format (little-endian fields).
     */
    format: 'mac' | 'plt';
    /**
     * Name of the player's ship (the name of NpïL resource 129 on Mac; the
     * trailing string of a .plt file).
     */
    shipName: string;
    /** Contents of NpïL 128: the player's own state. */
    player: PilotPlayerData;
    /** Contents of NpïL 129: universe state. */
    globals: PilotGlobalsData;
}
