import { Resource } from "resource_fork";

/**
 * Builds binary resource data for parser tests, mirroring Reader: tests
 * write fields in the same order the parser reads them, so a test reads
 * like the resource's template.
 */
export class ResourceBuilder {
    private bytes: number[] = [];

    int8(value: number): this {
        this.bytes.push(value & 0xff);
        return this;
    }

    uint8(value: number): this {
        return this.int8(value);
    }

    int16(value: number): this {
        this.bytes.push((value >> 8) & 0xff, value & 0xff);
        return this;
    }

    uint16(value: number): this {
        return this.int16(value);
    }

    int32(value: number): this {
        this.bytes.push((value >> 24) & 0xff, (value >> 16) & 0xff,
            (value >> 8) & 0xff, value & 0xff);
        return this;
    }

    uint32(value: number): this {
        return this.int32(value);
    }

    uint64(value: bigint): this {
        for (let shift = 56n; shift >= 0n; shift -= 8n) {
            this.bytes.push(Number((value >> shift) & 0xffn));
        }
        return this;
    }

    /**
     * A null-terminated string in a fixed-size field. Only ASCII is
     * supported here; MacRoman decoding is tested separately.
     */
    string(value: string, byteLength: number): this {
        if (value.length >= byteLength) {
            throw new Error(`"${value}" does not fit in ${byteLength} bytes`);
        }
        for (let i = 0; i < byteLength; i++) {
            const code = i < value.length ? value.charCodeAt(i) : 0;
            if (code > 0x7f) {
                throw new Error(`Non-ASCII character in "${value}"`);
            }
            this.bytes.push(code);
        }
        return this;
    }

    /** A Pascal string: a length byte followed by the (ASCII) text. */
    pstring(value: string): this {
        if (value.length > 255) {
            throw new Error(`"${value}" is too long for a Pascal string`);
        }
        this.uint8(value.length);
        for (let i = 0; i < value.length; i++) {
            const code = value.charCodeAt(i);
            if (code > 0x7f) {
                throw new Error(`Non-ASCII character in "${value}"`);
            }
            this.bytes.push(code);
        }
        return this;
    }

    /** Zeroed padding / unused bytes. */
    skip(byteCount: number): this {
        for (let i = 0; i < byteCount; i++) {
            this.bytes.push(0);
        }
        return this;
    }

    array(values: number[], write: (value: number) => unknown): this {
        for (const value of values) {
            write(value);
        }
        return this;
    }

    /** Drop everything from `byteLength` on, emulating a truncated resource. */
    truncate(byteLength: number): this {
        this.bytes.length = byteLength;
        return this;
    }

    get byteLength(): number {
        return this.bytes.length;
    }

    dataView(): DataView {
        return new DataView(new Uint8Array(this.bytes).buffer);
    }

    resource(type: string, id: number, name = ""): Resource {
        return new Resource(type, id, name, this.dataView());
    }
}
