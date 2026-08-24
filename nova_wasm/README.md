# nova_wasm

This crate contains the numeric hot paths used by NovaJS:

- `convex_hull` computes a monotone-chain hull from an `x, y` `Float32Array`.
- `convex_hull_rgba` extracts visible boundary pixels from an RGBA image and
  computes their hull in image coordinates.
- `sat_batch` tests candidate pairs of transformed convex polygons. Polygon
  offsets index the flattened vertex arrays; positions are `x, y` pairs and
  rotations are radians.

Run `./build.sh` after changing Rust code. It runs `wasm-pack --target web`,
keeps the `.wasm` artifact, and generates a base64-embedded JavaScript module
plus complete TypeScript declarations in `pkg/`. The embedded module has an async
`init()` and synchronous APIs that are available after initialization.
