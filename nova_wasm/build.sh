#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAW_PKG="$ROOT/pkg/raw"

source "$HOME/.cargo/env"

rm -rf "$RAW_PKG"
mkdir -p "$RAW_PKG"

wasm-pack build "$ROOT" \
    --mode normal \
    --target web \
    --release \
    --out-dir "$RAW_PKG" \
    --no-pack

python3 "$ROOT/scripts/embed_wasm.py" \
    "$RAW_PKG/nova_wasm.js" \
    "$RAW_PKG/nova_wasm_bg.wasm" \
    "$ROOT/pkg/nova_wasm.js" \
    "$ROOT/pkg/nova_wasm.d.ts"

cp "$RAW_PKG/nova_wasm_bg.wasm" "$ROOT/pkg/nova_wasm_bg.wasm"
rm -rf "$RAW_PKG"
