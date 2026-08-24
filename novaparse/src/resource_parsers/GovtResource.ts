import { Resource } from "resource_fork";
import { NovaResources } from "./ResourceHolderBase";
import { BaseResource } from "./NovaResourceBase";

class GovtResource extends BaseResource {
    voiceType: number;
    flags: number;
    flags2: number;
    scanFine: number;
    crimeTolerance: number;
    smugglingPenalty: number;
    disablingPenalty: number;
    boardingPenalty: number;
    killingPenalty: number;
    shootingPenalty: number;
    initialRecord: number;
    maxOdds: number;
    classes: number[];
    allies: number[];
    enemies: number[];
    skillMultiplier: number;
    scanMask: number;
    commName: string;
    targetName: string;
    require: number[];
    inherentJamming: number[];
    mediumName: string;
    color: number;
    shipColor: number;
    interface: number;
    newsPicture: number;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        var d = this.data;

        // Offsets follow CGovtResource::Save. EVNEW reserves sixteen
        // trailing bytes after NewsPicture; those bytes are intentionally
        // not interpreted here.
        this.voiceType = d.getInt16(0);
        this.flags = d.getUint16(2);
        this.flags2 = d.getUint16(4);
        this.scanFine = d.getInt16(6);
        this.crimeTolerance = d.getInt16(8);
        this.smugglingPenalty = d.getInt16(10);
        this.disablingPenalty = d.getInt16(12);
        this.boardingPenalty = d.getInt16(14);
        this.killingPenalty = d.getInt16(16);
        this.shootingPenalty = d.getInt16(18);
        this.initialRecord = d.getInt16(20);
        this.maxOdds = d.getInt16(22);
        this.classes = [];
        this.allies = [];
        this.enemies = [];
        for (var i = 0; i < 4; i++) {
            this.classes.push(d.getInt16(24 + i * 2));
            this.allies.push(d.getInt16(32 + i * 2));
            this.enemies.push(d.getInt16(40 + i * 2));
        }
        this.skillMultiplier = d.getInt16(48);
        this.scanMask = d.getUint16(50);
        this.commName = this.getString(52, 16);
        this.targetName = this.getString(68, 16);
        this.require = [];
        for (var j = 0; j < 8; j++) {
            this.require.push(d.getUint8(84 + j));
        }
        this.inherentJamming = [];
        for (var k = 0; k < 4; k++) {
            this.inherentJamming.push(d.getInt16(92 + k * 2));
        }
        this.mediumName = this.getString(100, 64);
        this.color = d.getUint32(164);
        this.shipColor = d.getUint32(168);
        this.interface = d.getInt16(172);
        this.newsPicture = d.getInt16(174);
    }

    private getString(start: number, length: number): string {
        var s = "";
        var end = Math.min(start + length, this.data.byteLength);
        for (var i = start; i < end; i++) {
            var c = this.data.getUint8(i);
            if (c === 0) {
                break;
            }
            s += String.fromCharCode(c);
        }
        return s;
    }
}

export { GovtResource }
