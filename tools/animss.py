#!/usr/bin/env python3
"""Reader for the AnimSS animation data inside ANSS_EF_*.CHK.

The engine is the game's own SpriteStudio-derived runtime. libAll.so keeps RTTI
for it, which is where the node model below comes from:

    AnimssPart / Animss6Part            scene-graph node
    AnimssCellPart                      sprite cell node
    AnimssSCMatrix                      transform
    AnimssItemRegister::EnableNode      visibility
    AnimssItemRegister::ChangeCellNode  cell swap
    AnimssItemRegister::ChangeImageNode image swap
    AnimssItemRegister::VertexColorNode per-corner colour
    AnimssItemRegister::TextNode        string payload (e.g. "[LOOP]")
    AnimssEffectEmitterNode / ...ParticleNode   particle system

Layout, all little-endian, offsets relative to a PRCT section's content base
(the 16 bytes after the section tag):

    part header   u64 version, 'ANIMSS05', u64 0, u64 namelen, name[namelen],
                  32 zero bytes, 2 u32, then (u64 offset, u64 count) tables:
                    [0] texture table  stride 0x78
                    [1] clip table     stride 0x80
    texture       slot[8], name[0x40] @0x10, f32 w,h @0x50,
                  u64 cellOff, cellCount @0x68
    cell (0x60)   name[0x40], f32 x, y, w, h, pivotX, pivotY
    clip (0x80)   name[0x40], u32 frames, fps @0x40, f32 canvasW,H @0x50,
                  u64 nodeOff,nodeCount @0x60, u64 animOff,animCount @0x70
    node (0x68)   name[0x40], i32 parent, i32 kind
    anim (0x78)   name[0x40], u64 1 @0x40, u32 frames @0x48,
                  f32 stageW,H @0x58, u64 trackOff,trackCount @0x68
    track (0x18)  u64 nodeIndex, u64 keyframeOff, u64 keyframeCount
    keyframe(0x18) u64 frame, u64 propOff, u64 propCount
    property(0x28) u32 slot, u32 flag, 16 zero bytes, u64 kind,
                   f32/u32 value, u32 0

`kind` maps onto the ItemRegister node types: 1 = enable/end, 2 = float channel
(the transform and colour values; `slot` selects which), 3 = cell index,
4 = image reference, 5 = string pointer (the "[LOOP]" markers).

Still unresolved: what each of the ~60 float `slot` values means. Slots seen
carrying 1.0/0.6 runs are vertex colours; slots carrying +-100..280 are clearly
positions and 0.1..9.0 scales, but the exact index->attribute table needs the
field offsets from AnimssSCMatrix / AnimssPart in libAll.so.
"""
import re, struct, sys

def _cstr(d, o, n=0x40):
    b = d[o:o + n]
    i = b.find(b"\0")
    return b[:i if i >= 0 else len(b)].decode("utf-8", "replace")

def parts(path):
    d = open(path, "rb").read()
    out = []
    for m in re.finditer(rb"PRCT\d\d", d):
        cb = m.start() + 16
        if d[cb + 8:cb + 16] != b"ANIMSS05":
            continue
        namelen = struct.unpack_from("<Q", d, cb + 24)[0]
        if not 0 < namelen <= 256:
            continue
        name = _cstr(d, cb + 32, namelen)
        p = cb + 32 + namelen + 32 + 8
        tex_off, tex_cnt = struct.unpack_from("<QQ", d, p)
        clip_off, clip_cnt = struct.unpack_from("<QQ", d, p + 16)
        out.append({"name": name, "cb": cb, "textures": (tex_off, tex_cnt),
                    "clips": (clip_off, clip_cnt)})
    return d, out

def clips(d, part):
    cb = part["cb"]
    off, cnt = part["clips"]
    for i in range(cnt):
        o = cb + off + i * 0x80
        frames, fps = struct.unpack_from("<II", d, o + 0x40)
        cw, ch = struct.unpack_from("<ff", d, o + 0x50)
        n_off, n_cnt = struct.unpack_from("<QQ", d, o + 0x60)
        a_off, a_cnt = struct.unpack_from("<QQ", d, o + 0x70)
        nodes = [{"name": _cstr(d, cb + n_off + k * 0x68),
                  **dict(zip(("parent", "kind"), struct.unpack_from("<ii", d, cb + n_off + k * 0x68 + 0x40)))}
                 for k in range(n_cnt if n_cnt < 4096 else 0)]
        yield {"name": _cstr(d, o), "frames": frames, "fps": fps,
               "canvas": (cw, ch), "nodes": nodes, "anims": (a_off, a_cnt)}

def anims(d, part, clip):
    cb = part["cb"]
    off, cnt = clip["anims"]
    for a in range(cnt):
        ao = cb + off + a * 0x78
        t_off, t_cnt = struct.unpack_from("<QQ", d, ao + 0x68)
        if t_cnt > 4096:
            continue
        tracks = []
        for t in range(t_cnt):
            ni, kf_off, kf_cnt = struct.unpack_from("<QQQ", d, cb + t_off + t * 0x18)
            keys = []
            for k in range(kf_cnt):
                fr, p_off, p_cnt = struct.unpack_from("<QQQ", d, cb + kf_off + k * 0x18)
                if p_cnt > 256:
                    continue
                props = []
                for j in range(p_cnt):
                    po = cb + p_off + j * 0x28
                    if po + 0x28 > len(d):
                        break
                    slot, flag = struct.unpack_from("<II", d, po)
                    kind = struct.unpack_from("<Q", d, po + 0x18)[0]
                    fval = struct.unpack_from("<f", d, po + 0x20)[0]
                    ival = struct.unpack_from("<I", d, po + 0x20)[0]
                    props.append({"slot": slot, "flag": flag, "kind": kind,
                                  "f": fval, "i": ival})
                keys.append({"frame": fr, "props": props})
            tracks.append({"node": ni, "keys": keys})
        yield {"name": _cstr(d, ao),
               "frames": struct.unpack_from("<I", d, ao + 0x48)[0],
               "stage": struct.unpack_from("<ff", d, ao + 0x58),
               "tracks": tracks}

if __name__ == "__main__":
    for path in sys.argv[1:]:
        d, ps = parts(path)
        print(f"\n### {path.split('/')[-1]}  parts={len(ps)}")
        for part in ps:
            cs = list(clips(d, part))
            n_anim = k = pr = 0
            for c in cs:
                for a in anims(d, part, c):
                    n_anim += 1
                    for t in a["tracks"]:
                        k += len(t["keys"])
                        pr += sum(len(x["props"]) for x in t["keys"])
            print(f"  {part['name']:22} clips={len(cs):3} anims={n_anim:3} "
                  f"keys={k:5} props={pr:5} canvas={cs[0]['canvas'] if cs else None} "
                  f"frames={cs[0]['frames'] if cs else None}@{cs[0]['fps'] if cs else None}fps")
