const assert = require("node:assert/strict");
const {
    convexHull,
    convexHullRgba,
    init,
    satBatch,
} = require("./pkg/nova_wasm.js");

async function main() {
    await init();

    assert.deepEqual(
        Array.from(convexHull(new Float32Array([
            1, 1,
            0, 0,
            2, 0,
            2, 2,
            0, 2,
        ]))),
        [0, 0, 2, 0, 2, 2, 0, 2],
    );

    const rgba = new Uint8Array(3 * 3 * 4);
    for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 3; x++) {
            rgba[(y * 3 + x) * 4 + 3] = 255;
        }
    }
    assert.deepEqual(
        Array.from(convexHullRgba(rgba, 3, 3, 255)),
        [0, 0, 2, 0, 2, 2, 0, 2],
    );

    const square = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
    const offsets = new Uint32Array([0, 8]);
    const positions = new Float32Array([0, 0]);
    const rotations = new Float32Array([0]);
    const pair = new Uint32Array([0, 0]);
    assert.deepEqual(
        Array.from(satBatch(
            square,
            offsets,
            positions,
            rotations,
            square,
            offsets,
            positions,
            rotations,
            pair,
        )),
        [1],
    );
    assert.deepEqual(
        Array.from(satBatch(
            square,
            offsets,
            positions,
            rotations,
            square,
            offsets,
            new Float32Array([3, 0]),
            new Float32Array([Math.PI / 4]),
            pair,
        )),
        [0],
    );

    console.log("nova_wasm Node smoke test passed");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
