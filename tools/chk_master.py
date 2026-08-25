#!/usr/bin/env python3
"""Reader for the app's CHK master-data containers (JP/*.CHK).

Container
    'CHK ' u32 hdrsize u32 flags u32 filesize
    then sections, each: tag[8] u32 size u32 rawsize     <- size INCLUDES the
    16-byte header, so the next section starts at off+size. 0xCC / 0xFF pad.

XLB table (used by CARDMASTERDATA / BGMCUSTOMIZEMASTERDATA)
    'XLB' pad(8) u32 size u32 hdrbytes
    +0x10 u32 stride  u32 rows  u32 poolStart ...
    one stride-sized header block, then `rows` rows, then a cp932 string pool.

CARDMASTERDATA / DAT  (12,358 rows x 236 bytes) - player-season ability table,
verified against cards.json (playerId at +36 matched for every sampled card):
    +0x00 u32  card-type code      (49 values, 0 = plain)
    +0x04 u32  title / trait id    (228 values)
    +0x08 u32  comment pointer 1   -> cp932 string pool
    +0x0c u32  flag
    +0x10 u32  comment pointer 2
    +0x14 u32  position            (0..7; 7 = pitcher -> fielding cols are 0)
    +0x18 u32  catching
    +0x1c u32  throwing
    +0x20 u32  shoulder
    +0x24 u32  playerId            <- CONFIRMED against cards.json
    +0x28 u32  season/version index (1..22)
    +0x2c .. +0xbc   12 x (pitchKind, power, level)   <- the 12 pitch directions,
                                                        37 = empty slot
    +0xbc u32  year                (1937..2025)
    +0xc0 ..   floats and trait ids
"""
import struct, re, sys

def sections(path):
    d = open(path, "rb").read()
    assert d[:4] == b"CHK ", "not a CHK container"
    out, off = [], 0x10
    while off + 16 <= len(d):
        while off < len(d) and d[off] in (0xCC, 0xFF):
            off += 1
        if off + 16 > len(d):
            break
        tag = d[off:off + 8].rstrip(b"\0")
        if not re.fullmatch(rb"[A-Z0-9_]{2,8}", tag or b""):
            break
        size, raw = struct.unpack_from("<II", d, off + 8)
        out.append({"tag": tag.decode(), "off": off, "size": size, "raw": raw,
                    "data": off + 16})
        if size < 16:
            break
        off += size
    return d, out

def xlb(d, off):
    """Read an XLB table header at `off` (the 'XLB' tag position)."""
    size, hdr = struct.unpack_from("<II", d, off + 8)
    stride, rows, pool = struct.unpack_from("<III", d, off + 0x10)
    base = off + 0x10 + stride              # skip the stride-sized header block
    return {"stride": stride, "rows": rows, "base": base,
            "pool": base + stride * rows, "size": size, "hdr": hdr}

def cp932(d, pool, off):
    end = d.find(b"\0", pool + off)
    return d[pool + off:end].decode("cp932", "replace")

PITCH_SLOTS = 12
def card_row(d, base, stride, r):
    o = base + r * stride
    g = lambda k: struct.unpack_from("<I", d, o + k)[0]
    pitches = []
    for i in range(PITCH_SLOTS):
        k = 0x2c + i * 12
        kind, power, level = g(k), g(k + 4), g(k + 8)
        if kind != 37:
            pitches.append({"kind": kind, "power": power, "level": level})
    return {"typeCode": g(0), "traitId": g(4), "position": g(0x14),
            "catching": g(0x18), "throwing": g(0x1c), "shoulder": g(0x20),
            "playerId": g(0x24), "season": g(0x28), "year": g(0xbc),
            "pitches": pitches}

if __name__ == "__main__":
    for p in sys.argv[1:]:
        d, secs = sections(p)
        print(f"\n### {p.split('/')[-1]}")
        for s in secs:
            print(f"  {s['tag']:10} size={s['size']:9} data=0x{s['data']:x}")
        dat = next((s for s in secs if s["tag"] == "DAT"), None)
        if dat and d[dat["data"]:dat["data"] + 3] == b"XLB":
            t = xlb(d, dat["data"])
            print(f"  DAT/XLB stride={t['stride']} rows={t['rows']}")
            for r in (0, 1, 8672):
                if r < t["rows"]:
                    print("   ", card_row(d, t["base"], t["stride"], r))
