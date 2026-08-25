#!/usr/bin/env python3
"""Parse ANSS_EF_*.CHK (AnimSS05) and export individual sprite cells + manifest.

Container layout (reverse engineered from the app's own files):
  'CHK ' u32 hdrsize u32 flags u32 totalsize
  then a sequence of 16-byte tagged sections: tag[4] id[2] pad[2] u32 padded u32 raw
    CLMP<nn>  -> one PNG texture sheet
    DESC      -> ANIMSS05 descriptor for the whole effect
    PRCT<nn>  -> ANIMSS05 part (e.g. *_b1 = behind player, *_f1 = in front)
  PRCT content:
    +0x00 u64 version   +0x08 'ANIMSS05'  +0x10 u64 0  +0x18 u64 namelen
    +0x20 name[namelen] +... 32 zero bytes + 2 u32
    then table descriptors (u64 offset, u64 count):
      [0] texture table, stride 0x78
      [1] clip table,    stride 0x80
    texture entry: slot[8] .. name[0x40]@0x10, f32 w,h @0x50, u64 cellOff,cellCount @0x68
    cell entry (0x60): name[0x40], f32 x,y,w,h,pivotX,pivotY
    clip entry (0x80): name[0x40], u32 frames, u32 fps, f32 canvasW,canvasH @0x50,
                       u64 nodeOff,nodeCount @0x60
    node entry (0x68): name[0x40], i32 parent, i32 kind
"""
import json, os, re, struct, sys
from PIL import Image

CHK_DIR = "/Users/yi-rang/Downloads/prospi-a-card-effects/chk"
PNG_DIR = "/Users/yi-rang/Downloads/prospi-a-card-effects/png"

# 게임은 이펙트마다 큰(_L)/작은(_S) 두 벌을 따로 배포한다. _S 는 목록 아이콘용
# 저작본이라 텍스처 수·해상도가 다르다(1201005: 19장/2.9M px -> 5장/0.69M px).
# 파이프라인 세 스크립트가 같은 값을 봐야 하므로 환경변수 하나로 고른다.
CLS = os.environ.get("ANSS_CLASS", "L")
assert CLS in ("L", "S"), CLS

def cstr(b):
    i = b.find(b"\0")
    return b[: i if i >= 0 else len(b)].decode("utf-8", "replace")

def sections(d):
    """Walk the top-level 16-byte-header sections."""
    out, off = [], 0x10
    while off + 16 <= len(d):
        while off < len(d) and d[off] == 0xCC:      # 0xCC padding between sections
            off += 1
        if off + 16 > len(d):
            break
        tag = d[off:off + 4]
        if not re.fullmatch(rb"[A-Z]{4}", tag):
            break
        sid = cstr(d[off + 4:off + 8])
        padded, raw = struct.unpack_from("<II", d, off + 8)
        out.append({"tag": tag.decode(), "id": sid, "off": off, "padded": padded, "raw": raw})
        off += 16 + (padded if padded else 0)
        if padded == 0:                              # DESC/PRCT declare their own span
            break
    return out

def find_tagged(d, tag):
    return [m.start() for m in re.finditer(re.escape(tag) + rb"\d\d", d)]

def parse_part(d, tag_off):
    cb = tag_off + 16
    if d[cb + 8:cb + 16] != b"ANIMSS05":
        return None
    namelen = struct.unpack_from("<Q", d, cb + 24)[0]
    if not (0 < namelen <= 256):
        return None
    name = cstr(d[cb + 32:cb + 32 + namelen])
    p = cb + 32 + namelen + 32 + 8
    tex_off, tex_cnt = struct.unpack_from("<QQ", d, p)
    clip_off, clip_cnt = struct.unpack_from("<QQ", d, p + 16)
    if tex_cnt > 512 or clip_cnt > 512:
        return None

    textures = []
    for i in range(tex_cnt):
        o = cb + tex_off + i * 0x78
        slot = cstr(d[o:o + 8])
        tname = cstr(d[o + 0x10:o + 0x50])
        w, h = struct.unpack_from("<ff", d, o + 0x50)
        c_off, c_cnt = struct.unpack_from("<QQ", d, o + 0x68)
        cells = []
        for j in range(c_cnt):
            so = cb + c_off + j * 0x60
            cn = cstr(d[so:so + 0x40])
            x, y, cw, ch, px, py = struct.unpack_from("<6f", d, so + 0x40)
            cells.append({"name": cn, "x": x, "y": y, "w": cw, "h": ch,
                          "pivotX": px, "pivotY": py})
        textures.append({"slot": slot, "name": tname, "w": w, "h": h, "cells": cells})

    clips = []
    for i in range(clip_cnt):
        o = cb + clip_off + i * 0x80
        cn = cstr(d[o:o + 0x40])
        frames, fps = struct.unpack_from("<II", d, o + 0x40)
        cw, ch = struct.unpack_from("<ff", d, o + 0x50)
        n_off, n_cnt = struct.unpack_from("<QQ", d, o + 0x60)
        nodes = []
        if n_cnt < 4096:
            for j in range(n_cnt):
                no = cb + n_off + j * 0x68
                nn = cstr(d[no:no + 0x40])
                parent, kind = struct.unpack_from("<ii", d, no + 0x40)
                nodes.append({"name": nn, "parent": parent, "kind": kind})
        clips.append({"name": cn, "frames": frames, "fps": fps,
                      "canvasW": cw, "canvasH": ch, "nodes": nodes})
    return {"part": name, "textures": textures, "clips": clips}

def sheet_files(effect_id):
    """Map CLMP slot -> extracted sheet PNG path."""
    dirp = os.path.join(PNG_DIR, f"ANSS_EF_{effect_id}_{CLS}")
    out = {}
    if not os.path.isdir(dirp):
        return out
    for fn in os.listdir(dirp):
        m = re.match(r"\d+_(CLMP\d+)_(\d+)x(\d+)\.png$", fn)
        if m:
            out[m.group(1)] = os.path.join(dirp, fn)
    return out

def export(effect_id, out_root):
    path = os.path.join(CHK_DIR, f"ANSS_EF_{effect_id}_{CLS}.CHK")
    d = open(path, "rb").read()
    sheets = sheet_files(effect_id)
    parts = []
    for off in find_tagged(d, b"PRCT"):
        pr = parse_part(d, off)
        if pr:
            parts.append(pr)
    desc = None
    for off in find_tagged(d, b"DESC"):
        desc = parse_part(d, off)
        break

    out_dir = os.path.join(out_root, str(effect_id))
    spr_dir = os.path.join(out_dir, "sprites")
    os.makedirs(spr_dir, exist_ok=True)

    manifest = {"effectId": effect_id, "desc": desc["part"] if desc else None, "parts": []}
    written = 0
    for pr in parts:
        clip = pr["clips"][0] if pr["clips"] else {}
        pm = {"name": pr["part"],
              "role": "front" if re.search(r"_f\d+(_\d+)?$", pr["part"]) else "back",
              "canvasW": clip.get("canvasW"), "canvasH": clip.get("canvasH"),
              "frames": clip.get("frames"), "fps": clip.get("fps"),
              "nodes": clip.get("nodes", []), "sprites": []}
        for tex in pr["textures"]:
            src = sheets.get(tex["slot"])
            if not src:
                continue
            with Image.open(src) as im:
                im = im.convert("RGBA")
                for cell in tex["cells"]:
                    x, y = int(round(cell["x"])), int(round(cell["y"]))
                    w, h = int(round(cell["w"])), int(round(cell["h"]))
                    if w <= 0 or h <= 0:
                        continue
                    x2, y2 = min(x + w, im.width), min(y + h, im.height)
                    if x >= im.width or y >= im.height or x2 <= x or y2 <= y:
                        continue
                    crop = im.crop((x, y, x2, y2))
                    if crop.getbbox() is None:      # fully transparent cell
                        continue
                    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", f"{tex['slot']}_{cell['name']}")
                    fn = f"{pm['role']}_{safe}.png"
                    crop.save(os.path.join(spr_dir, fn), optimize=True)
                    written += 1
                    pm["sprites"].append({
                        "name": cell["name"], "sheet": tex["name"], "slot": tex["slot"],
                        "file": fn, "w": crop.width, "h": crop.height,
                        "pivotX": round(cell["pivotX"], 4), "pivotY": round(cell["pivotY"], 4),
                    })
        manifest["parts"].append(pm)
    with open(os.path.join(out_dir, "effect.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))
    return manifest, written

if __name__ == "__main__":
    out_root = sys.argv[1]
    ids = sys.argv[2:]
    total = 0
    for eid in ids:
        m, n = export(eid, out_root)
        parts = ", ".join(f"{p['name']}({p['role']},{len(p['sprites'])}spr,{p['frames']}f)" for p in m["parts"])
        print(f"{eid}: {n} sprites | {parts}")
        total += n
    print(f"TOTAL sprites: {total}")
