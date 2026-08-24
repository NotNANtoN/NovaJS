#!/usr/bin/env python3
"""Convert EV Nova REZ (BRGR) files to .ndat (Mac resource fork format in data fork).

REZ format (community spec from the Ambrosia forums):
  Header (little-endian): 'BRGR', u32=1, u32 header_end, u32=1,
    u32 first_index, u32 entry_count, then entry_count * (u32 offset,
    u32 length, u32 unknown), then 'resource.map\0'.
  The LAST index entry is the resource map (big-endian): u32 unknown,
    u32 type_count, per type (4cc, u32 offset_from_map, u32 count), then
    per resource (u32 index, 4cc type, u16 id, 256-byte name buffer).

Resource fork format per Inside Macintosh: More Macintosh Toolbox.
"""
import struct
import sys
from pathlib import Path


def parse_rez(data: bytes):
    if data[:4] != b'BRGR':
        raise ValueError('not a BRGR REZ file')
    _, _hdr_end, _, first_index, count = struct.unpack_from('<IIIII', data, 4)
    entries = []
    pos = 24
    for _ in range(count):
        off, length, _ = struct.unpack_from('<III', data, pos)
        entries.append((off, length))
        pos += 12

    # Last entry is the resource map (big-endian).
    map_off, map_len = entries[-1]
    resources = []  # (type4cc bytes, id, name bytes, data bytes)
    p = map_off
    _unknown, type_count = struct.unpack_from('>II', data, p)
    p += 8
    total = 0
    types = []
    for _ in range(type_count):
        t4 = data[p:p + 4]
        toff, tcount = struct.unpack_from('>II', data, p + 4)
        types.append((t4, toff, tcount))
        total += tcount
        p += 12
    for _ in range(total):
        idx, = struct.unpack_from('>I', data, p)
        t4 = data[p + 4:p + 8]
        rid, = struct.unpack_from('>H', data, p + 8)
        raw_name = data[p + 10:p + 266]
        name = raw_name.split(b'\0', 1)[0][:255]
        off, length = entries[idx - first_index]
        resources.append((t4, rid, name, data[off:off + length]))
        p += 266
    return resources


def build_resource_fork(resources) -> bytes:
    # Data area
    data_area = bytearray()
    data_offsets = []
    for _, _, _, payload in resources:
        data_offsets.append(len(data_area))
        data_area += struct.pack('>I', len(payload)) + payload

    # Group by type, preserving order of first appearance
    by_type = {}
    for i, (t4, rid, name, _) in enumerate(resources):
        by_type.setdefault(t4, []).append(i)

    num_types = len(by_type)
    type_list_size = 2 + 8 * num_types
    ref_list_size = 12 * sum(len(v) for v in by_type.values())

    name_list = bytearray()
    name_offsets = {}
    for i, (_, _, name, _) in enumerate(resources):
        if name:
            name_offsets[i] = len(name_list)
            name_list += bytes([len(name)]) + name

    # Map layout: 16 reserved + 4 next + 2 fileref + 2 attrs
    #   + 2 type_list_off + 2 name_list_off = 28 bytes header
    type_list_off = 28
    name_list_off = type_list_off + type_list_size + ref_list_size

    map_area = bytearray(16)  # copy of fork header, zeros are fine
    map_area += struct.pack('>IHH', 0, 0, 0)
    map_area += struct.pack('>HH', type_list_off, name_list_off)
    map_area += struct.pack('>H', (num_types - 1) & 0xFFFF)

    # Type entries; ref list offsets are relative to the type list start
    # (the position of the numTypes word).
    ref_cursor = type_list_size
    for t4, indices in by_type.items():
        map_area += t4
        map_area += struct.pack('>HH', len(indices) - 1, ref_cursor)
        ref_cursor += 12 * len(indices)

    for t4, indices in by_type.items():
        for i in indices:
            _, rid, name, _ = resources[i]
            noff = name_offsets.get(i, 0xFFFF)
            doff = data_offsets[i]
            if doff > 0xFFFFFF:
                raise ValueError('data area exceeds 16MB limit')
            map_area += struct.pack('>Hh', rid, noff - 0x10000 if noff == 0xFFFF else noff) \
                if False else struct.pack('>HH', rid, noff)
            map_area += bytes([0]) + doff.to_bytes(3, 'big')
            map_area += struct.pack('>I', 0)

    map_area += name_list

    data_off = 256
    map_off = data_off + len(data_area)
    header = struct.pack('>IIII', data_off, map_off, len(data_area), len(map_area))
    out = bytearray(header) + bytes(240) + data_area + map_area
    # Fill the reserved copy of the header at the start of the map.
    out[map_off:map_off + 16] = header
    return bytes(out)


def main():
    src_dir = Path(sys.argv[1])
    dst_dir = Path(sys.argv[2])
    dst_dir.mkdir(parents=True, exist_ok=True)
    for rez in sorted(src_dir.glob('*.rez')):
        data = rez.read_bytes()
        resources = parse_rez(data)
        out = build_resource_fork(resources)
        dst = dst_dir / (rez.stem + '.ndat')
        dst.write_bytes(out)
        print(f'{rez.name}: {len(resources)} resources -> {dst.name} ({len(out)} bytes)')


if __name__ == '__main__':
    main()
