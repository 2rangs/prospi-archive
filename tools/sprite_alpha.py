#!/usr/bin/env python3
"""Center-alpha index for the extracted sprite cells.

The player masks a colour through a cell to reproduce AnimssPart::setVertexColor.
That is right for the soft glow cells the attribute is used on, but a nearly
opaque cell masked this way turns into a flat lit shape, so the player needs to
know which cells are solid and draw those as images instead.
"""
import json, os, sys
from PIL import Image

d = sys.argv[1]
out = {}
files = sorted(f for f in os.listdir(d) if f.endswith(".png"))
for n, fn in enumerate(files):
    if n % 1500 == 0: print(f"  ...{n}/{len(files)}", flush=True)
    with Image.open(os.path.join(d, fn)) as im:
        im = im.convert("RGBA")
        w, h = im.size
        x0, y0 = int(w*.35), int(h*.35)
        x1, y1 = max(x0 + 1, int(w*.65)), max(y0 + 1, int(h*.65))
        crop = im.crop((x0, y0, x1, y1)).getchannel("A")
        if crop.width > 8 and crop.height > 8:
            crop = crop.resize((8, 8))
        px = list(crop.get_flattened_data())
    out[fn[:-4]] = round(sum(px)/len(px))
p = os.path.join(os.path.dirname(d), "sprite-alpha.json")
json.dump(out, open(p, "w"), separators=(",", ":"))
print(f"wrote {p} ({len(out)} sprites, {os.path.getsize(p)} bytes)")
