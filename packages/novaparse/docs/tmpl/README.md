# Nova resource templates (TMPL) reference

`tmpl_offsets.txt` is the authoritative byte-layout reference used by the
resource parsers in `src/resource_parsers/`. It lists, for every EV Nova
resource type, each field's byte offset, TMPL type, label, and size, along
with the `CASE` lines that document enumerated values and flag bits.

It is generated from ResForge's actively-maintained Nova templates
(`ResForge/Plugins/Sources/NovaTools/Templates.rsrc`,
https://github.com/andrews05/ResForge), which are more reliable than the EVN
Bible for field order and exact offsets. The Bible remains the best source
for field *semantics*.

- `dump_tmpl.mjs` extracts the raw TMPL resources into `tmpl_dump.json`
  (requires a ResForge checkout; adjust the path inside).
- `gen_offsets.mjs` computes offsets from the dump into `tmpl_offsets.txt`.

Notes on TMPL semantics that these scripts encode (learned from ResForge's
`TemplateParser.swift`):

- `Cnnn`/`Fnnn`/`Rnnn`/`Hnnn` lengths are hexadecimal; bit-field counts in
  `WB16`/`QB64`-style types are decimal.
- `nnnn` (e.g. `n0FF`) is NovaTools' custom NCB-expression element: a
  fixed-size null-terminated C string, same layout as `Cnnn`.
- `Rnnn` repeats the single immediately following element — including
  zero-byte elements like `PACK`, in which case it consumes no data.
- `PNT ` stores x before y; `RECT` stores top, left, bottom, right.
- Real resources may be shorter than their template; EV Nova treats missing
  trailing fields as defaults. Parsers use `Reader`'s fallbacks for this.
- The chär template uses an `FCNT`/`LSTC` list for the four starting
  systems, which this generator does not expand — the real resource stores
  all four int16s inline (356 + 6 = 362 bytes).
