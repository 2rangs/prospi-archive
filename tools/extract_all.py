#!/usr/bin/env python3
"""Extract render-ready sprite cells for every ANSS_EF effect, deduplicated.

Cells are shared across effects (1201005 references ef_1101004_00), so every
crop is stored once under sprites/<md5>.png and referenced by hash.
"""
import hashlib, io, json, os, re, sys
from collections import defaultdict
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_sprites import parse_part, find_tagged, sheet_files, CHK_DIR, CLS

OUT = sys.argv[1]
MAX_SINGLES, MAX_FAMILIES = 7, 4
MASK = re.compile(r"^(maru|kage)(_\w+)?$")

def families(sprites):
    fam, singles = defaultdict(list), []
    for s in sprites:
        if MASK.match(s["name"]):
            continue
        m = re.match(r"^(.*?)_(\d+)$", s["name"])
        if m:
            fam[m.group(1)].append((int(m.group(2)), s))
        else:
            singles.append(s)
    out = {}
    for k, v in fam.items():
        v.sort(key=lambda t: t[0])
        seq = [s for _, s in v]
        if len(seq) >= 2: out[k] = seq
        else: singles.extend(seq)
    return out, singles

def centre_alpha(im):
    w, h = im.size
    box = (int(w*.35), int(h*.35), max(1, int(w*.65)), max(1, int(h*.65)))
    a = list(im.crop(box).getchannel("A").getdata())
    return sum(a)/len(a) if a else 0

sprite_dir = os.path.join(OUT, "sprites")
os.makedirs(sprite_dir, exist_ok=True)
seen = {}
plan = {}
files = sorted(f for f in os.listdir(CHK_DIR) if f.endswith(f"_{CLS}.CHK"))
print("effects:", len(files), flush=True)

for n, fn in enumerate(files):
    eid = re.match(rf"ANSS_EF_(\d+)_{CLS}\.CHK$", fn).group(1)
    if n % 60 == 0: print(f"  ...{n} ({eid})", flush=True)
    d = open(os.path.join(CHK_DIR, fn), "rb").read()
    sheets = sheet_files(eid)
    buckets = {"back": [], "front": []}
    canvas = frames = fps = None
    cache = {}
    for off in find_tagged(d, b"PRCT"):
        pr = parse_part(d, off)
        if not pr: continue
        role = "front" if re.search(r"_f\d+(_\d+)?$", pr["part"]) else "back"
        clip = pr["clips"][0] if pr["clips"] else {}
        if canvas is None and clip.get("canvasW"):
            canvas, frames, fps = clip["canvasW"], clip["frames"], clip["fps"]
        for tex in pr["textures"]:
            src = sheets.get(tex["slot"])
            if not src: continue
            if src not in cache:
                cache[src] = Image.open(src).convert("RGBA")
            im = cache[src]
            for cell in tex["cells"]:
                x, y = int(round(cell["x"])), int(round(cell["y"]))
                w, h = int(round(cell["w"])), int(round(cell["h"]))
                if w <= 0 or h <= 0: continue
                x2, y2 = min(x+w, im.width), min(y+h, im.height)
                if x >= im.width or y >= im.height or x2 <= x or y2 <= y: continue
                crop = im.crop((x, y, x2, y2))
                if crop.getbbox() is None: continue
                buf = io.BytesIO(); crop.save(buf, "PNG", optimize=True)
                raw = buf.getvalue()
                key = hashlib.md5(raw).hexdigest()[:16]
                if key not in seen:
                    with open(os.path.join(sprite_dir, key + ".png"), "wb") as f:
                        f.write(raw)
                    seen[key] = len(raw)
                buckets[role].append({"name": cell["name"], "file": key,
                                      "w": crop.width, "h": crop.height,
                                      "px": round(cell["pivotX"], 4), "py": round(cell["pivotY"], 4),
                                      "ca": round(centre_alpha(crop), 1)})
    layers = []
    for role in ("back", "front"):
        fams, singles = families(buckets[role])
        singles.sort(key=lambda s: s["w"]*s["h"], reverse=True)
        kept = 0
        for s in singles:
            if kept >= MAX_SINGLES: break
            if role == "front" and s["ca"] > 40: continue
            layers.append({"role": role, "kind": "still", **{k: s[k] for k in ("name","file","w","h","px","py")}})
            kept += 1
        for k in sorted(fams, key=lambda k: (len(fams[k]), fams[k][0]["w"]*fams[k][0]["h"]), reverse=True)[:MAX_FAMILIES]:
            seq = fams[k]
            layers.append({"role": role, "kind": "flip", "name": k,
                           "w": seq[0]["w"], "h": seq[0]["h"], "px": seq[0]["px"], "py": seq[0]["py"],
                           "frames": [s["file"] for s in seq]})
    tail = eid[-5:]
    plan[eid] = {"effectId": int(eid), "group": int(eid[:-5]),
                 "series": tail[:2], "sub": tail[2:4], "rank": int(tail[4]),
                 "canvasW": canvas or 320, "canvasH": canvas or 320,
                 "frames": frames or 30, "fps": fps or 11,
                 "spriteCount": sum(len(v) for v in buckets.values()), "layers": layers}
    for im in cache.values(): im.close()

with open(os.path.join(OUT, "layers.json"), "w", encoding="utf-8") as f:
    json.dump(plan, f, ensure_ascii=False, separators=(",", ":"))
tot = sum(seen.values())
print(f"\neffects={len(plan)} unique sprites={len(seen)} bytes={tot} ({tot/1048576:.1f} MB)")
print("layers.json", os.path.getsize(os.path.join(OUT, 'layers.json')))
