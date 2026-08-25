import { BaseResource } from "./NovaResourceBase";
import { NovaResources } from "./ResourceHolderBase";
import { Resource } from "resource_fork";


// https://developers.google.com/web/updates/2012/06/How-to-convert-ArrayBuffer-to-and-from-String

function ab2str(data: DataView) {
    var arr: Array<number> = [];

    for (var i = 0; i < data.byteLength; i += 1) {
        var num = data.getUint8(i);
        if (num == 0) {
            // Got a null, so no more string
            break;
        }
        arr.push(data.getUint8(i));
    }

    return String.fromCharCode.apply(null, arr);
}


class DescResource extends BaseResource {
    readonly graphic: number;
    readonly movieFile: string;
    readonly flags: number;

    constructor(resource: Resource, idSpace: NovaResources) {
        super(resource, idSpace);
        const textEnd = this.findTextEnd();
        this.graphic = textEnd + 3 <= this.data.byteLength
            ? this.data.getInt16(textEnd + 1)
            : 0;
        this.movieFile = '';
        this.flags = 0;
    }

    private findTextEnd(): number {
        for (let offset = 0; offset < this.data.byteLength; offset++) {
            if (this.data.getUint8(offset) === 0) {
                return offset;
            }
        }
        return this.data.byteLength;
    }

    get text() {
        return ab2str(this.data);
    }

}

export { DescResource };
