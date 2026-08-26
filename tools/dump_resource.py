#!/usr/bin/env python3
"""Dump raw retail resources straight out of the Nova data files.

Reading the real bytes is the only way to settle a question the EV Nova Bible
leaves open, such as which offset holds a field or which flag a government
actually sets. Use it alongside the Bible rather than guessing.

    # Every resource type present, with counts
    python3 tools/dump_resource.py --types

    # One resource as annotated 16-bit words, with a hex dump
    python3 tools/dump_resource.py shïp --id 141

    # A field across every resource of a type, to spot what a flag means
    python3 tools/dump_resource.py gövt --offset 2 --width 2 --hex

    # Names only
    python3 tools/dump_resource.py jünk --list
"""
import argparse
import glob
import struct
import sys

DATA_GLOB = 'nova/Nova_Data/Nova Files/*.ndat'


def parse_fork(path):
    """Read a Macintosh resource fork into {type: {id: (bytes, name)}}."""
    d = open(path, 'rb').read()
    data_off, map_off, _data_len, map_len = struct.unpack('>IIII', d[:16])
    m = d[map_off:map_off + map_len]
    type_off, name_off = struct.unpack('>HH', m[24:28])
    type_count = struct.unpack('>h', m[type_off:type_off + 2])[0] + 1
    out = {}
    for i in range(type_count):
        o = type_off + 2 + i * 8
        kind = m[o:o + 4].decode('mac-roman')
        count = struct.unpack('>h', m[o + 4:o + 6])[0] + 1
        ref_off = struct.unpack('>H', m[o + 6:o + 8])[0] + type_off
        items = {}
        for j in range(count):
            r = ref_off + j * 12
            rid = struct.unpack('>h', m[r:r + 2])[0]
            name_rel = struct.unpack('>h', m[r + 2:r + 4])[0]
            body_off = struct.unpack('>I', b'\x00' + m[r + 5:r + 8])[0]
            start = data_off + body_off
            length = struct.unpack('>I', d[start:start + 4])[0]
            name = ''
            if name_rel >= 0:
                p = name_off + name_rel
                name = m[p + 1:p + 1 + m[p]].decode('mac-roman', 'replace')
            items[rid] = (d[start + 4:start + 4 + length], name)
        out.setdefault(kind, {}).update(items)
    return out


def load_all():
    everything = {}
    for path in sorted(glob.glob(DATA_GLOB)):
        try:
            fork = parse_fork(path)
        except Exception as error:  # A few files are not resource forks.
            print(f'skipped {path}: {error}', file=sys.stderr)
            continue
        for kind, items in fork.items():
            everything.setdefault(kind, {}).update(items)
    return everything


def hex_dump(blob, per_line=16):
    for offset in range(0, len(blob), per_line):
        chunk = blob[offset:offset + per_line]
        octets = ' '.join(f'{b:02x}' for b in chunk)
        text = ''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)
        print(f'  {offset:>4} {octets:<{per_line * 3}} {text}')


def words(blob, limit):
    print('  offset   int16   uint16     hex')
    for offset in range(0, min(len(blob) - 1, limit), 2):
        signed = struct.unpack('>h', blob[offset:offset + 2])[0]
        unsigned = struct.unpack('>H', blob[offset:offset + 2])[0]
        print(f'  {offset:>6} {signed:>7} {unsigned:>8}  {unsigned:#06x}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('kind', nargs='?', help='resource type, e.g. shïp or gövt')
    ap.add_argument('--types', action='store_true', help='list all types')
    ap.add_argument('--list', action='store_true', help='list ids and names')
    ap.add_argument('--id', type=int, help='dump one resource')
    ap.add_argument('--offset', type=int, help='report one field for every id')
    ap.add_argument('--width', type=int, default=2, choices=(1, 2, 4))
    ap.add_argument('--hex', action='store_true', help='print field in hex')
    ap.add_argument('--words', type=int, default=120,
                    help='bytes to decode as words with --id')
    args = ap.parse_args()

    everything = load_all()

    if args.types or not args.kind:
        for kind in sorted(everything):
            print(f'{kind:<8} {len(everything[kind]):>5} resources')
        return

    items = everything.get(args.kind)
    if not items:
        print(f'no {args.kind!r}; try --types', file=sys.stderr)
        sys.exit(1)

    if args.list:
        for rid in sorted(items):
            blob, name = items[rid]
            print(f'{rid:<6} {len(blob):>5}b  {name}')
        return

    if args.id is not None:
        blob, name = items[args.id]
        print(f'{args.kind} {args.id} {name!r}, {len(blob)} bytes')
        words(blob, args.words)
        print()
        hex_dump(blob)
        return

    if args.offset is not None:
        fmt = {1: '>b', 2: '>h', 4: '>i'}[args.width]
        for rid in sorted(items):
            blob, name = items[rid]
            if len(blob) < args.offset + args.width:
                continue
            end = args.offset + args.width
            value = struct.unpack(fmt, blob[args.offset:end])[0]
            shown = f'{value & 0xffffffff:#x}' if args.hex else value
            print(f'{rid:<6} {name[:28]:<30} {shown}')
        return

    print(f'{args.kind}: {len(items)} resources. Use --list, --id or --offset.')


if __name__ == '__main__':
    main()
