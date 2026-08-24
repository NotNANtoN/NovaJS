import { Resource } from "resource_fork";
import { NovaResources } from "./ResourceHolderBase";
import { BaseResource } from "./NovaResourceBase";

class MisnResource extends BaseResource {
    availStel: number;
    availLoc: number;
    availRecord: number;
    availRating: number;
    availRandom: number;
    travelStel: number;
    returnStel: number;
    cargoType: number;
    cargoQty: number;
    pickupMode: number;
    dropOffMode: number;
    scanMask: number;
    payVal: number;
    shipCount: number;
    shipSyst: number;
    shipDude: number;
    shipGoal: number;
    shipBehav: number;
    shipNameID: number;
    shipStart: number;
    compGovt: number;
    compReward: number;
    shipSubtitle: number;
    briefText: number;
    quickBrief: number;
    loadCargText: number;
    dumpCargoText: number;
    compText: number;
    failText: number;
    timeLimit: number;
    canAbort: number;
    shipDoneText: number;
    auxShipCount: number;
    auxShipDude: number;
    auxShipSyst: number;
    flags: number;
    flags2: number;
    availShipType: number;
    refuseText: number;
    availBits: string;
    onAccept: string;
    onRefuse: string;
    onSuccess: string;
    onFailure: string;
    onAbort: string;
    onShipDone: string;
    require: number[];
    datePostInc: number;
    acceptButton: string;
    refuseButton: string;
    displayWeight: number;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        var d = this.data;

        // These offsets follow CMisnResource::Save in EVNEW. The two-byte
        // gaps are alignment/padding in the on-disk resource, not fields.
        this.availStel = d.getInt16(0);
        this.availLoc = d.getInt16(4);
        this.availRecord = d.getInt16(6);
        this.availRating = d.getInt16(8);
        this.availRandom = d.getInt16(10);
        this.travelStel = d.getInt16(12);
        this.returnStel = d.getInt16(14);
        this.cargoType = d.getInt16(16);
        this.cargoQty = d.getInt16(18);
        this.pickupMode = d.getInt16(20);
        this.dropOffMode = d.getInt16(22);
        this.scanMask = d.getUint16(24);
        this.payVal = d.getInt32(28);
        this.shipCount = d.getInt16(32);
        this.shipSyst = d.getInt16(34);
        this.shipDude = d.getInt16(36);
        this.shipGoal = d.getInt16(38);
        this.shipBehav = d.getInt16(40);
        this.shipNameID = d.getInt16(42);
        this.shipStart = d.getInt16(44);
        this.compGovt = d.getInt16(46);
        this.compReward = d.getInt16(48);
        this.shipSubtitle = d.getInt16(50);
        this.briefText = d.getInt16(52);
        this.quickBrief = d.getInt16(54);
        this.loadCargText = d.getInt16(56);
        this.dumpCargoText = d.getInt16(58);
        this.compText = d.getInt16(60);
        this.failText = d.getInt16(62);
        this.timeLimit = d.getInt16(64);
        this.canAbort = d.getInt16(66);
        this.shipDoneText = d.getInt16(68);
        this.auxShipCount = d.getInt16(72);
        this.auxShipDude = d.getInt16(74);
        this.auxShipSyst = d.getInt16(76);
        this.flags = d.getUint16(80);
        this.flags2 = d.getUint16(82);
        this.refuseText = d.getInt16(88);
        this.availShipType = d.getInt16(90);

        var getString = (start: number, length: number): string => {
            var s = "";
            var end = Math.min(start + length, d.byteLength);
            for (var i = start; i < end; i++) {
                var c = d.getUint8(i);
                if (c === 0) {
                    break;
                }
                s += String.fromCharCode(c);
            }
            return s;
        };

        // The first six NCB strings occupy 255 bytes each. Require and the
        // date field follow them; OnShipDone is stored after DatePostInc.
        this.availBits = getString(92, 255);
        this.onAccept = getString(347, 255);
        this.onRefuse = getString(602, 255);
        this.onSuccess = getString(857, 255);
        this.onFailure = getString(1112, 255);
        this.onAbort = getString(1367, 255);
        this.require = [];
        for (var i = 0; i < 8; i++) {
            this.require.push(d.getUint8(1622 + i));
        }
        this.datePostInc = d.getInt16(1630);
        this.onShipDone = getString(1632, 255);
        this.acceptButton = getString(1887, 32);
        this.refuseButton = getString(1919, 33);
        this.displayWeight = d.getInt16(1952);
    }
}

export { MisnResource }
