#!/usr/bin/env python3
"""Embed the wasm-pack binary in a small universal ES module."""

import base64
import pathlib
import sys


def make_commonjs_bindings(raw_js: str) -> str:
    for export in ("convex_hull", "convex_hull_rgba", "sat_batch"):
        raw_js = raw_js.replace(
            f"export function {export}(",
            f"function {export}(",
        )
    raw_js = raw_js.replace(
        "new URL('nova_wasm_bg.wasm', import.meta.url)",
        "undefined",
    )
    raw_js = raw_js.replace(
        "export { initSync, __wbg_init as default };",
        """module.exports = {
    convex_hull,
    convex_hull_rgba,
    sat_batch,
    initSync,
    default: __wbg_init,
};""",
    )
    if "export function " in raw_js or "export {" in raw_js or "import.meta" in raw_js:
        raise RuntimeError("unexpected wasm-bindgen ES module output")
    return raw_js


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit(
            "usage: embed_wasm.py RAW_JS RAW_WASM OUTPUT_JS OUTPUT_DTS"
        )

    raw_js_path, wasm_path, output_js_path, output_dts_path = map(
        pathlib.Path, sys.argv[1:]
    )
    output_js_path.parent.mkdir(parents=True, exist_ok=True)
    output_dts_path.parent.mkdir(parents=True, exist_ok=True)

    # Keep wasm-bindgen's generated bindings beside the embedded wrapper. The
    # wrapper supplies the bytes explicitly, so neither Node nor a browser
    # needs to resolve a .wasm URL at runtime.
    bindgen_path = output_js_path.with_name("nova_wasm_bindgen.js")
    bindgen_path.write_text(
        make_commonjs_bindings(raw_js_path.read_text(encoding="utf-8")),
        encoding="utf-8",
    )

    encoded = base64.b64encode(wasm_path.read_bytes()).decode("ascii")
    output_js_path.write_text(
        f"""const {{
    default: initWasm,
    convex_hull,
    convex_hull_rgba,
    sat_batch,
}} = require("./nova_wasm_bindgen.js");

const EMBEDDED_WASM_BASE64 = "{encoded}";
let initialization;
let initialized = false;

function decodeBase64(value) {{
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const bytes = new Uint8Array(Math.floor(value.length * 3 / 4));
    let buffer = 0;
    let bits = 0;
    let offset = 0;

    for (let i = 0; i < value.length; i++) {{
        const digit = alphabet.indexOf(value[i]);
        if (digit < 0) {{
            continue;
        }}
        buffer = (buffer << 6) | digit;
        bits += 6;
        if (bits >= 8) {{
            bits -= 8;
            bytes[offset++] = (buffer >> bits) & 0xff;
        }}
    }}

    return offset === bytes.length ? bytes : bytes.slice(0, offset);
}}

function init() {{
    if (!initialization) {{
        initialization = initWasm({{ module_or_path: decodeBase64(EMBEDDED_WASM_BASE64) }}).then(() => {{
            initialized = true;
        }});
    }}
    return initialization;
}}

function isInitialized() {{
    return initialized;
}}

function requireInitialized() {{
    if (!initialized) {{
        throw new Error("nova_wasm.init() must resolve before using the synchronous API");
    }}
}}

function convexHull(points) {{
    requireInitialized();
    return convex_hull(points);
}}

function convexHullRgba(rgba, width, height, alphaThreshold) {{
    requireInitialized();
    return convex_hull_rgba(rgba, width, height, alphaThreshold);
}}

function satBatch(
    aVertices,
    aOffsets,
    aPositions,
    aRotations,
    bVertices,
    bOffsets,
    bPositions,
    bRotations,
    pairs,
) {{
    requireInitialized();
    return sat_batch(
        aVertices,
        aOffsets,
        aPositions,
        aRotations,
        bVertices,
        bOffsets,
        bPositions,
        bRotations,
        pairs,
    );
}}

module.exports = {{
    convexHull,
    convexHullRgba,
    init,
    isInitialized,
    satBatch,
}};
""",
        encoding="utf-8",
    )
    output_dts_path.write_text(
        """export function init(): Promise<void>;

export function isInitialized(): boolean;

export function convexHull(points: Float32Array): Float32Array;

export function convexHullRgba(
    rgba: Uint8Array,
    width: number,
    height: number,
    alphaThreshold: number,
): Float32Array;

export function satBatch(
    aVertices: Float32Array,
    aOffsets: Uint32Array,
    aPositions: Float32Array,
    aRotations: Float32Array,
    bVertices: Float32Array,
    bOffsets: Uint32Array,
    bPositions: Float32Array,
    bRotations: Float32Array,
    pairs: Uint32Array,
): Uint8Array;
""",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
