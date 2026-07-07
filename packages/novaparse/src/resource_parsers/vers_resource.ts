import { Resource } from "resource_fork";
import { BaseResource } from "./nova_resource_base.js";
import { Reader } from "./reader.js";
import { NovaResources } from "./resource_holder_base.js";

/** Development stage of a 'vers' resource (the classic Mac release stage). */
enum VersStage {
    development = 0x20,
    alpha = 0x40,
    beta = 0x60,
    release = 0x80,
}

/**
 * Decode one binary-coded-decimal byte, e.g. 0x10 -> 10, 0x99 -> 99. Each
 * nibble holds a decimal digit, which is how the classic Mac 'vers' format
 * stores the major version number.
 */
function fromBcd(byte: number): number {
    return ((byte >> 4) & 0xf) * 10 + (byte & 0xf);
}

/**
 * A version resource (vers): the standard Mac 'vers' format holding a
 * program/plug-in version number plus human-readable version strings.
 *
 * Layout: uint8 major (BCD), uint8 minor/bugfix (one BCD nibble each), uint8
 * development stage, uint8 prerelease revision, uint16 region code, then two
 * Pascal strings (a short version string and a long version string).
 */
class VersResource extends BaseResource {
    /** Major version number, e.g. 1 for "1.0.10". */
    major: number;
    /** Minor version number (high nibble of the second byte). */
    minor: number;
    /** Bugfix / revision number (low nibble of the second byte). */
    bugfix: number;

    /** Raw development-stage byte: 0x20 dev, 0x40 alpha, 0x60 beta, 0x80 release. */
    stage: number;
    isDevelopment: boolean;
    isAlpha: boolean;
    isBeta: boolean;
    isRelease: boolean;

    /** Non-release build number; only meaningful when not a final release. */
    prerelease: number;
    /** Mac region code the strings are localized for; 0 is US/verbatim. */
    regionCode: number;

    /** Short version string shown in Get Info, e.g. "1.0.10". */
    shortVersion: string;
    /** Long version string, e.g. a copyright line. */
    longVersion: string;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const r = new Reader(this.data);

        this.major = fromBcd(r.uint8());

        const minorBugfix = r.uint8();
        this.minor = (minorBugfix >> 4) & 0xf;
        this.bugfix = minorBugfix & 0xf;

        this.stage = r.uint8();
        this.isDevelopment = this.stage === VersStage.development;
        this.isAlpha = this.stage === VersStage.alpha;
        this.isBeta = this.stage === VersStage.beta;
        this.isRelease = this.stage === VersStage.release;

        this.prerelease = r.uint8();
        this.regionCode = r.uint16();

        this.shortVersion = r.pstring();
        this.longVersion = r.pstring();
    }
}

export { VersResource, VersStage };
