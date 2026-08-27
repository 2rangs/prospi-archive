#!/usr/bin/env python3
"""Export AnimSS animation data for the web player. (v2)

Attribute ids come from AnimssNormalModel::updatePartAttributeSub in libAll.so
(a 33-entry jump table; each case calls AnimssPart::set<Attr>):

    0 CELL  1 POSX  2 POSY  3 POSZ  4 ROTX  5 ROTY  6 ROTZ  7 SCALEX 8 SCALEY
    9 ALPHA 10 PRIORITY 11 FLIPH 12 FLIPV 13 HIDE 14 VERTEXCOLOR
    15 VERTEXTRANSFORM 16 PIVOTX 17 PIVOTY 22 IMGFLIPH 23 IMGFLIPV
    24 UVTRANSX 25 UVTRANSY 26 UVROTZ 27 UVSCALEX 28 UVSCALEY
    30 USERDATA 31 INSTANCE 32 EFFECT

Struct layout, also from the binary:
    AnimssDescAttribute  +0x00 u32 attrId  +0x08 keyOff  +0x10 keyCount
    AnimssDescKeyFrame   +0x00 s32 frame   +0x04 u32 curve   +0x08 DescCurve
                         +0x18 u32 valueKind  +0x20 value            (40B)
    curve: 0 hold | 1 linear | 2 hermite | 3 bezier | 4 accel | 5 decel
    (from the 6-entry table in AnimssInterpolation::interpolateKeyFrameFloat;
     hermite/bezier take AnimssDescCurve = keyframe+0x08, four floats)

v2 additions over the first exporter:
  * keys carry the curve id and, for hermite/bezier, its handles:
    [frame, value, curve] or [frame, value, curve, [x0,y0,x1,y1]]
    (observed values: 1 = linear, 2 = hermite/smooth; 0 treated as hold)
  * node tail decoded: +0x60 u32 = instance target CLIP index within the same
    part, +0x64 u32 = target ANIM index (0xFFFFFFFF when not an instance).
    Instance parts (kind 3) are inlined generally through those indices —
    the old name-regex only caught "ef_<id>_*_anime_N" and silently dropped
    local instances such as the 24 staggered "arrow_front_N" chevrons.
  * exported attributes now include ROTX/ROTY (3D tilts), PRIORITY (z-order),
    FLIPH/V, PIVOTX/Y, IMGFLIPH/V, UV transforms and USERDATA (per-instance
    stagger; steps of 448 = 1.75 frames in 8.8 fixed point).
  * CELL tracks with more than one key are exported as flipbooks:
    node.cells = [cell...], node.ct = [[frame, cellsIndex, interp]...]
"""
import hashlib, io, json, math, os, random, re, struct, sys
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from animss import parts as anim_parts, _cstr
from extract_sprites import parse_part, find_tagged, sheet_files, CHK_DIR, CLS

# 20/21 = SIZE_X / SIZE_Y — 셀의 자연 크기를 덮어쓰는 표시 크기다.
# [근거] 값이 128.0 · 112.0 · 75.787 처럼 픽셀 규모이고 늘 20/21 이 쌍으로 온다
#   (예: 1114005 의 eff_kira_1 이 20=128.0, 21=128.0). 키 종류 태그(+0x18)도
#   float(2) 다. 문서화된 표에서 17 PIVOTY 와 22 IMGFLIPH 사이의 빈 자리이며,
#   SpriteStudio 의 속성 순서(… PIVOT, ANCHOR, SIZE, IMGFLIP …)와 맞는다.
# [범위] 키 75+73개 · 이펙트 16개. 작지만 그 파츠는 크기가 틀리게 그려진다.
# [신뢰도] STRONG (값 규모 + 쌍 출현 + 자리)
WANT = {1: "x", 2: "y", 4: "rx", 5: "ry", 6: "rot", 7: "sx", 8: "sy", 9: "a",
        10: "prio", 11: "fh", 12: "fv", 13: "hide", 16: "pvx", 17: "pvy",
        20: "szx", 21: "szy",
        22: "ifh", 23: "ifv", 24: "uvx", 25: "uvy", 26: "uvrot",
        27: "uvsx", 28: "uvsy"}
INT_ATTRS = {10, 11, 12, 13, 22, 23}
MAX_DEPTH = 3
NO_INST = 0xFFFFFFFF


def clips_ex(d, part):
    """Like animss.clips() but with the node tail (instance clip/anim index)."""
    cb = part["cb"]
    off, cnt = part["clips"]
    out = []
    for i in range(cnt):
        o = cb + off + i * 0x80
        frames, fps = struct.unpack_from("<II", d, o + 0x40)
        cw, ch = struct.unpack_from("<ff", d, o + 0x50)
        n_off, n_cnt = struct.unpack_from("<QQ", d, o + 0x60)
        a_off, a_cnt = struct.unpack_from("<QQ", d, o + 0x70)
        nodes = []
        for k in range(n_cnt if n_cnt < 4096 else 0):
            no = cb + n_off + k * 0x68
            parent, kind = struct.unpack_from("<ii", d, no + 0x40)
            iclip, ianim = struct.unpack_from("<II", d, no + 0x60)
            # node struct tail: +0x48 u32 blendType (SpriteStudio: 0=Mix 1=Mul 2=Add 3=Sub)
            blend = struct.unpack_from("<I", d, no + 0x48)[0]
            nodes.append({"name": _cstr(d, no), "parent": parent, "kind": kind,
                          "iclip": iclip, "ianim": ianim, "blend": blend})
        out.append({"name": _cstr(d, o), "frames": frames, "fps": fps,
                    "canvas": (cw, ch), "nodes": nodes, "anims": (a_off, a_cnt)})
    return out


def cellmaps(d):
    out = []
    for off in find_tagged(d, b"PRCT"):
        pr = parse_part(d, off)
        if pr:
            out.append(pr)
    return out


SHEET_DIR = "public/effects/sheets"
_sheet_cache = {}


def sheet_hash(path):
    """시트 PNG 를 내용 해시로 디듑해 public/effects/sheets 에 두고 (해시, w, h) 반환.

    UV 애니메이션 파츠는 셀 크롭이 아니라 **시트 전체**를 텍스처로 써야 한다.
    런타임은 GL_CLAMP_TO_EDGE 만 쓰므로(libAll.so 에 GL_REPEAT 는 0회) UV 가 셀
    바깥으로 나가면 반복되지 않고 시트의 이웃 내용이 보이다가 시트 경계에서
    늘어난다. 셀만 잘라 두면 그 이웃 내용을 재현할 수 없다.
    18,816개 파츠 / 383개 이펙트가 UV 를 셀 밖으로 밀어낸다.
    """
    if path in _sheet_cache:
        return _sheet_cache[path]
    raw = open(path, "rb").read()
    h = hashlib.md5(raw).hexdigest()[:16]
    os.makedirs(SHEET_DIR, exist_ok=True)
    out = os.path.join(SHEET_DIR, h + ".png")
    if not os.path.exists(out):
        with open(out, "wb") as fh:
            fh.write(raw)
    with Image.open(path) as im:
        wh = (h, im.width, im.height)
    _sheet_cache[path] = wh
    return wh


def crop_hash(im, cell):
    x, y = int(round(cell["x"])), int(round(cell["y"]))
    w, h = int(round(cell["w"])), int(round(cell["h"]))
    x2, y2 = min(x + w, im.width), min(y + h, im.height)
    if w <= 0 or h <= 0 or x >= im.width or y >= im.height or x2 <= x or y2 <= y:
        return None
    crop = im.crop((x, y, x2, y2))
    if crop.getbbox() is None:
        return None
    buf = io.BytesIO(); crop.save(buf, "PNG", optimize=True)
    return hashlib.md5(buf.getvalue()).hexdigest()[:16], crop.width, crop.height


def read_vcol(d, cb, off):
    """AnimssValue::Vcol -- blend type, then one ARGB + rate per corner.

    [핵심] ARGB 의 **최상위 바이트가 코너 알파**다. 종전에는 그 바이트를
    버리고 rate float 만 알파로 썼다. 그 결과 A 바이트에 페이드/그라데이션을
    담은 파츠가 **항상 최대 밝기로 떠 있었다.**

    [근거 — 951004 `ef_951000_07_02b_2`] vcol 9키의 원시 덤프:
      f0   corners = 0x001d5ce8 x4        (A=00, 파랑 #1d5ce8)  rate=1.0
      f5   위 2코너 0xff1d5ce8 · 아래 2코너 0x001d5ce8  = 수직 와이프
      f32~f140 전부 0xff1d5ce8            (완전 표시)
      f148~f165 다시 A=00 코너            (페이드아웃)
    rate 는 전 구간 1.0 — envelope 은 전적으로 A 바이트에 있다. 화면의
    "항상 켜진 파란 판"의 색 #1d5ce8 과 정확히 일치한다.

    [전수] vcol 키 91,999개 중 A<255 가 22,543개(24.5%) · 이펙트 471/682.
    사용자 판정과의 교집합: 엉망 23개 중 22개 · 살짝 128개 중 127개.

    [합성] 유효 알파 = rate(색 적용 강도) x A/255. eff_t 처럼 rate 쪽에
    그라데이션을 담는 파츠(그때 A=ff)와 이 케이스(rate=1, A 가 envelope)
    둘 다 이 곱으로 성립한다.
    """
    try:
        blend = struct.unpack_from("<I", d, cb + off)[0]
        n = 4 if blend else 1
        base = cb + off + 0x10
        out = []
        for i in range(n):
            argb = struct.unpack_from("<I", d, base + i*8)[0]
            rate = struct.unpack_from("<f", d, base + i*8 + 4)[0]
            rate = rate if 0 <= rate <= 1 else 1.0
            a = ((argb >> 24) & 0xFF) / 255.0
            out.append([(argb >> 16) & 0xFF, (argb >> 8) & 0xFF, argb & 0xFF,
                        round(rate * a, 3)])
        return {"blend": blend, "c": out}
    except Exception:
        return None


def read_tracks(d, cb, a_off, a_cnt):
    """-> (tracks, vcol, vtrack, verttrack, cellkeys, user, aref)

    aref 는 USERDATA "[ANIME]#<파트>:<클립>:<애니>" 로, iclip 이 없는 노드에서
    다른 PRCT 파트의 애니메이션을 그 자리에 재생하라는 지시다. 682개 중 100개
    이펙트가 이걸 쓰므로(태그 352개) 처리하지 않으면 그 서브 애니메이션이
    통째로 빠진다. [신뢰도 STRONG]
    """
    tr, vcol, vtrack, verttrack, cellkeys, user, aref = {}, None, None, None, None, None, None
    for ai in range(a_cnt):
        aid, k_off, k_cnt = struct.unpack_from("<QQQ", d, cb + a_off + ai*0x18)
        if k_cnt > 4096:
            continue
        if aid == 14:
            # 정점 색상도 키프레임 트랙이다. [ADVANCE]#N 으로 위상이 다른 인스턴스가
            # 서로 다른 프레임을 읽어 링을 따라 색이 변하는 연출(1181005 화살표:
            # 0프레임 빨강/파랑 -> 45 시안 -> 180 반전)이 여기서 나온다.
            keys = []
            for k in range(k_cnt):
                ko = cb + k_off + k*0x28
                if ko + 0x28 > len(d):
                    break
                fr = struct.unpack_from("<i", d, ko)[0]
                curve = struct.unpack_from("<I", d, ko + 4)[0]
                if curve > 5:
                    curve = 1
                vc = read_vcol(d, cb, struct.unpack_from("<I", d, ko + 0x20)[0])
                if vc:
                    keys.append([fr, vc["blend"], vc["c"], curve])
            if keys:
                vcol = {"blend": keys[0][1], "c": keys[0][2]}
                vtrack = keys
            continue
        if aid == 15:
            # AnimssValue::Vert is exactly eight signed 32-bit values (32B),
            # copied wholesale by AnimssValue::Vert::set. They are four (x,y)
            # corner offsets in lower-left, lower-right, upper-left, upper-right
            # order. interpolateKeyFrameVert interpolates every component.
            keys = []
            for k in range(k_cnt):
                ko = cb + k_off + k * 0x28
                if ko + 0x28 > len(d):
                    break
                fr = struct.unpack_from("<i", d, ko)[0]
                curve = struct.unpack_from("<I", d, ko + 4)[0]
                if curve > 5:
                    curve = 1
                vo = struct.unpack_from("<I", d, ko + 0x20)[0]
                if cb + vo + 0x20 > len(d):
                    continue
                vals = list(struct.unpack_from("<8i", d, cb + vo))
                key = [fr, vals, curve]
                if curve in (2, 3):
                    h = [round(x, 4) for x in struct.unpack_from("<4f", d, ko + 8)]
                    if any(h):
                        key.append(h)
                keys.append(key)
            if keys:
                verttrack = keys
            continue
        if aid == 30:
            # USERDATA: u32 는 파트 블록 내 문자열 구조 오프셋(+0x30 에 ASCII).
            # 인스턴스 시차는 "[ADVANCE]#N" 의 N (엔진: setFrame(0, N) 로 서브클립 시드 프레임).
            ko = cb + k_off
            if ko + 0x28 <= len(d):
                u = struct.unpack_from("<I", d, ko + 0x20)[0]
                s = _cstr(d, cb + u + 0x30, 0x40)
                m = re.search(r"\[ADVANCE\]#(-?\d+)", s)
                if m:
                    user = int(m.group(1))
                m = re.match(r"\[ANIME\]#([^:]+):([^:]+):(\S+)", s)
                if m:
                    # USERDATA 레코드 +0x00 의 정수도 같이 쓴다(이미터의 방출 개수)
                    aref = (m.group(1), m.group(2), m.group(3),
                            struct.unpack_from("<I", d, cb + u)[0])
            continue
        if aid == 0:
            keys = []
            for k in range(k_cnt):
                ko = cb + k_off + k*0x28
                if ko + 0x28 > len(d):
                    break
                fr = struct.unpack_from("<i", d, ko)[0]
                curve = struct.unpack_from("<I", d, ko + 4)[0]
                if curve > 5: curve = 1
                keys.append([fr, list(struct.unpack_from("<II", d, ko + 0x20)), curve])
            if keys:
                cellkeys = keys
            continue
        if aid not in WANT:
            continue
        keys = []
        for k in range(k_cnt):
            ko = cb + k_off + k*0x28
            if ko + 0x28 > len(d):
                break
            fr = struct.unpack_from("<i", d, ko)[0]
            curve = struct.unpack_from("<I", d, ko + 4)[0]
            if curve > 5: curve = 1
            if aid in INT_ATTRS:
                v = struct.unpack_from("<I", d, ko + 0x20)[0]
            else:
                v = round(struct.unpack_from("<f", d, ko + 0x20)[0], 4)
                if abs(v) > 1e6:
                    v = 0.0
            key = [fr, v, curve]
            if curve in (2, 3):
                h = [round(x, 4) for x in struct.unpack_from("<4f", d, ko + 8)]
                if any(h):
                    key.append(h)
            keys.append(key)
        if keys:
            tr[WANT[aid]] = keys
    return tr, vcol, vtrack, verttrack, cellkeys, user, aref


def clip_default_cells(d, cb, clip):
    """노드별 기본 셀 (mapIndex, cellIndex).

    런타임의 AnimssCellPart::setCell 은 AnimssDescCell* 를 파츠에 붙이므로 셀은
    애니메이션이 아니라 파츠에 딸린 상태다. 그래서 어떤 애니메이션에 CELL(attr 0)
    트랙이 없어도 그 파츠는 계속 같은 셀을 그린다. 파일에 파츠 기본 셀 필드는
    따로 없고(kind=1 노드의 +0x48~+0x64 가 전수 동일), 같은 클립의 다른
    애니메이션이 그 값을 갖고 있다. 그것을 파츠 기본 셀로 쓴다. [신뢰도 POSSIBLE]
    """
    out = {}
    a_off, a_cnt = clip["anims"]
    for ai in range(a_cnt):
        ao = cb + a_off + ai*0x78
        t_off, t_cnt = struct.unpack_from("<QQ", d, ao + 0x68)
        if t_cnt > 4096:
            continue
        for t in range(t_cnt):
            pi, at_off, at_cnt = struct.unpack_from("<QQQ", d, cb + t_off + t*0x18)
            if pi in out:
                continue
            _, _, _, _, cellkeys, _, _ = read_tracks(d, cb, at_off, at_cnt)
            if cellkeys:
                out[pi] = cellkeys[0][1]
    return out


def _u32(d, off):
    return struct.unpack_from("<I", d, off)[0]


def read_emitter(d, cb, clip, t_off, t_cnt):
    """`[EMITTER]#standard` 클립을 파티클 사양으로 읽는다.

    [확인된 사실] 이미터 클립은 노드 이름으로 사양을 담는다.
        root      USERDATA "[EMITTER]#standard"
        rect      방출 영역. x,y 가 중심, sx,sy 가 크기(논리단위)
        param     각 어트리뷰트에 키 2개 = 파티클 초기값 [min, max]
        interval  USERDATA 정수 2개 = [0, 방출 간격(프레임)]
        anime*    USERDATA 문자열 "[ANIME]#파트:클립:애니" + 정수 = 방출 개수
      예) 101002: rect 318x258 @(-169,-12), interval 31, anim01 10개,
          param rot -10~10 / 크기 0.75~1.2 / 알파 0.75~1.0, 파티클 수명 80프레임.
      682개 중 100개 이펙트가 이 구조를 쓴다(태그 200개).
    [신뢰도] 구조 STRONG / "interval 마다 count 개 방출" 해석은 POSSIBLE.
    """
    nodes = clip["nodes"]
    if t_cnt > 4096:
        return None
    rect = {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}
    param = {}
    interval = 0
    emits = []
    is_emitter = False
    for t in range(t_cnt):
        pi, at_off, at_cnt = struct.unpack_from("<QQQ", d, cb + t_off + t * 0x18)
        if at_cnt > 64 or pi >= len(nodes):
            continue
        name = nodes[pi]["name"]
        for i2 in range(at_cnt):
            aid, k_off, k_cnt = struct.unpack_from("<QQQ", d, cb + at_off + i2 * 0x18)
            if k_cnt > 4096:
                continue
            keys = []
            for k in range(k_cnt):
                ko = cb + k_off + k * 0x28
                if aid == 30:
                    u = _u32(d, ko + 0x20)
                    base = cb + u
                    sptr = _u32(d, base + 0x20)
                    keys.append((_u32(d, base),
                                 _cstr(d, cb + sptr, 0x40) if sptr else ""))
                elif aid in INT_ATTRS:
                    keys.append(_u32(d, ko + 0x20))
                else:
                    keys.append(round(struct.unpack_from("<f", d, ko + 0x20)[0], 4))
            if aid == 30:
                if name == "param" and len(keys) >= 2:
                    # Native initModelWorkStandard converts this integer range
                    # to a millisecond countdown before enabling each model.
                    vals = [iv for iv, _sv in keys]
                    param["delay_ms"] = [min(vals), max(vals)]
                for iv, sv in keys:
                    if "[EMITTER]" in sv:
                        is_emitter = True
                    if name == "interval":
                        interval = max(interval, iv)
                    m = re.match(r"\[ANIME\]#([^:]+):([^:]+):(\S+)", sv)
                    if m:
                        emits.append((m.group(1), m.group(2), m.group(3), max(1, iv)))
            elif name == "rect":
                if aid == 1: rect["x"] = keys[0]
                elif aid == 2: rect["y"] = keys[0]
                elif aid == 7: rect["w"] = abs(keys[0])
                elif aid == 8: rect["h"] = abs(keys[0])
            elif name == "param" and len(keys) >= 2:
                nm = WANT.get(aid)
                if nm in ("x", "y", "rot", "sx", "sy", "a"):
                    param[nm] = [min(keys[0], keys[1]), max(keys[0], keys[1])]
    if not is_emitter or not emits:
        return None
    return {"rect": rect, "param": param, "interval": max(1, interval), "emits": emits}


def find_anim(d, cb, clip, name=None, index=None):
    a_off, a_cnt = clip["anims"]
    for ai in range(a_cnt):
        ao = cb + a_off + ai*0x78
        if name is not None and _cstr(d, ao) != name:
            continue
        if index is not None and ai != index:
            continue
        t_off, t_cnt = struct.unpack_from("<QQ", d, ao + 0x68)
        if t_cnt > 4096:
            continue
        fps, length = struct.unpack_from("<II", d, ao + 0x48)
        return _cstr(d, ao), t_off, t_cnt, fps, length
    return None


class Ctx:
    def __init__(self, d, ps, cells, clips_by_part):
        self.d, self.ps, self.cells, self.clips = d, ps, cells, clips_by_part


def load_effect(effect_id, cache):
    if effect_id in cache:
        return cache[effect_id]
    path = os.path.join(CHK_DIR, f"ANSS_EF_{effect_id}_{CLS}.CHK")
    if not os.path.exists(path):
        cache[effect_id] = None
        return None
    d, ps = anim_parts(path)
    prs = cellmaps(d)
    sheets = sheet_files(effect_id)
    images, alpha_src, cells = {}, {}, {}
    for pr in prs:
        flat = []
        for tex in pr["textures"]:
            src = sheets.get(tex["slot"])
            if src and src not in images:
                raw = Image.open(src)
                # PNG colour type 4/6 carry alpha; palette does only with tRNS
                alpha_src[src] = raw.mode in ("RGBA", "LA") or "transparency" in raw.info
                images[src] = raw.convert("RGBA")
            sheet = sheet_hash(src) if src else None
            for ci, cell in enumerate(tex["cells"]):
                h = crop_hash(images[src], cell) if src else None
                entry = {"name": cell["name"],
                         "file": h[0] if h else None,
                         "w": h[1] if h else int(cell["w"]),
                         "h": h[2] if h else int(cell["h"]),
                         "px": round(cell["pivotX"], 4), "py": round(cell["pivotY"], 4),
                         "map": tex["slot"], "idx": ci,
                         "alpha": bool(alpha_src.get(src, False))}
                if sheet:
                    # 시트 안의 셀 사각형 — UV 파츠가 시트에서 샘플링할 때 쓴다
                    entry["sheet"] = sheet[0]
                    entry["sw"] = sheet[1]
                    entry["sh"] = sheet[2]
                    entry["rx"] = int(round(cell["x"]))
                    entry["ry"] = int(round(cell["y"]))
                    entry["rw"] = int(round(cell["w"]))
                    entry["rh"] = int(round(cell["h"]))
                flat.append(entry)
        # ---- 스크롤 창(_t/_u)의 원본 이미지를 찾아 UV 이동 단위를 기록한다 ----
        #
        # [문제] `fan01_01_t`(시트 2~66행) 처럼 **더 큰 셀에서 잘라낸 얇은 창**이
        #   있고, 그 파츠는 UV 이동만으로 애니메이션한다. UV 이동 단위를 창 높이
        #   (64)로 잡으면 원본 424행 중 **29%** 만 훑고 나머지는 화면에 영영 안
        #   나온다. 실제로 1285005 의 eff_t 는 시트 -3~120행만 샘플하는데, 그
        #   리본에서 가장 밝은 구간은 120~300행(평균 알파 65.7 vs 우리가 보여 준
        #   구간 31.1)이다.
        # [서명] 같은 텍스처 안에서 (a) x·폭이 같고 크기도 같은 형제 창이 바로
        #   위/아래에 붙어 있고, (b) 그 둘을 감싸는 높이 2배 이상의 셀이 있을 때만
        #   스크롤 창으로 본다. 우연한 아틀라스 겹침(포함 관계만 보면 78%가 걸린다)
        #   을 걸러내기 위한 조건이다. 이 서명에 맞는 UV 셀 참조는 4,098개 /
        #   105개 이펙트다.
        # [근거] `fan01_01_t`(2,2,256,64) · `fan01_01_u`(2,66,256,64) ⊂
        #   `fan01_01`(2,2,256,424). 1151003 의 `brush01_t/_u` ⊂ `brush01`,
        #   1142004 의 `wa_t` ⊂ `wa_long` 도 같은 꼴이다.
        # [신뢰도] POSSIBLE — 기하 서명에 기댄 해석. 서명에 맞을 때만 적용하므로
        #   나머지 이펙트의 결과는 종전과 완전히 같다.
        bytex = {}
        for c in flat:
            if "rx" in c:
                bytex.setdefault(c["map"], []).append(c)
        for c in flat:
            if "rx" not in c:
                continue
            sibs = bytex.get(c["map"], [])
            rx, ry, rw, rh = c["rx"], c["ry"], c["rw"], c["rh"]
            has_sib = any(o is not c and o["rx"] == rx and o["rw"] == rw
                          and o["rh"] == rh
                          and (abs(o["ry"] - (ry + rh)) <= 1
                               or abs((o["ry"] + o["rh"]) - ry) <= 1)
                          for o in sibs)
            if not has_sib:
                continue
            box = None
            for o in sibs:
                if o is c or o["rx"] != rx or o["rw"] != rw:
                    continue
                if o["rh"] < 2 * rh:
                    continue
                if o["ry"] <= ry and o["ry"] + o["rh"] >= ry + rh:
                    if box is None or o["rh"] < box["rh"]:
                        box = o
            if box:
                c["uy"] = box["ry"]      # 원본 이미지 상단 (시트 픽셀)
                c["uh"] = box["rh"]      # UV 세로 이동 1.0 에 해당하는 높이
            else:
                # 감싸는 셀이 없으면 **쌍의 합집합**이 원본이다.
                #
                # [근거] 1285005 의 로고 광택 logo_eff_t01(0,0,256,96) ·
                #   u01(0,96,256,96) 은 컨테이너 셀 없이 uvy -0.75 -> 1.0 로
                #   흐른다. 단위를 합집합 높이 192 로 읽으면 광택이 위(빈 곳)
                #   에서 들어와 훑고 정지값 1.0 에서 **둘 다 빈 행/시트 밖**에
                #   놓여 사라진다 — 광택 연출 그대로다. 창 높이 96 으로 읽으면
                #   정지 후 t01 이 u01 의 줄무늬를 가리켜 **정지된 광택이
                #   91/121 프레임 동안 떠 있다**(시트 96~192행 avgA 85,
                #   192행 아래 avgA 8->0 실측).
                sib_ry = None
                for o in sibs:
                    if o is c or o["rx"] != rx or o["rw"] != rw or o["rh"] != rh:
                        continue
                    if abs(o["ry"] - (ry + rh)) <= 1 or abs((o["ry"] + o["rh"]) - ry) <= 1:
                        sib_ry = o["ry"]
                        break
                if sib_ry is not None:
                    c["uy"] = min(ry, sib_ry)
                    c["uh"] = 2 * rh
        cells[pr["part"]] = flat
    for im in images.values():
        im.close()
    clips_by_part = {p["name"]: clips_ex(d, p) for p in ps}
    cache[effect_id] = Ctx(d, ps, cells, clips_by_part)
    return cache[effect_id]


def emit_particles(ctx, em, role, out, parent_at, depth):
    """이미터 사양대로 파티클을 배치한다.

    Native buildStandard allocates exactly the USERDATA integer on each
    `[ANIME]` part. `interval` is only a required setting lookup in this runtime;
    it does not multiply the model count. rect is (minimum x/y, positive range),
    not (centre, width/height). param USERDATA is a millisecond start delay.
    """
    rect = em["rect"]
    prm = em["param"]
    interval = em["interval"]
    for ei, (pname, cname, aname, count) in enumerate(em["emits"]):
        tgt = next((q for q in ctx.ps if q["name"] == pname), None)
        if not tgt:
            continue
        sub = next((cc for cc in ctx.clips.get(pname, []) if cc["name"] == cname), None)
        if not sub:
            continue
        info = find_anim(ctx.d, tgt["cb"], sub, name=aname)
        if not info:
            continue
        life = max(1, info[4])
        total = count
        rnd = random.Random(f"{pname}:{cname}:{aname}:{ei}")
        for n in range(total):
            def rng(key, lo_hi, fallback=0.0):
                r = prm.get(key)
                return rnd.uniform(r[0], r[1]) if r else fallback
            px = rect["x"] + rnd.random() * rect["w"]
            py = rect["y"] + rnd.random() * rect["h"]
            delay_ms = rng("delay_ms", None, 0.0)
            delay = max(0, int(math.ceil(delay_ms * 30.0 / 1000.0)))
            node = {
                "n": f"particle_{ei}_{n}",
                "p": parent_at,
                "k": 0,
                "role": role,
                "len": life + delay,
                "afps": 30,
                "loop": True,
                "user": -delay,
                "t": {
                    "x": [[0, round(px, 3), 1]],
                    "y": [[0, round(py, 3), 1]],
                    "rot": [[0, round(rng("rot", None), 2), 1]],
                    "sx": [[0, round(rng("sx", None, 1.0), 4), 1]],
                    "sy": [[0, round(rng("sy", None, 1.0), 4), 1]],
                    "a": [[0, round(rng("a", None, 1.0), 4), 1]],
                    # The native model is disabled during its random countdown,
                    # then runs the referenced animation once before re-init.
                    "hide": [[0, 0, 0], [life, 1, 0]],
                },
            }
            out.append(node)
            emit_clip(ctx, tgt, sub, {"name": aname}, role, out, len(out) - 1, depth + 1)


def emit_clip(ctx, part, clip, anim_sel, role, out, parent_at, depth, user=None):
    """Append one clip animation's nodes to `out` under parent index parent_at."""
    d = ctx.d
    cb = part["cb"]
    found = find_anim(d, cb, clip, **anim_sel)
    if not found:
        return
    _, t_off, t_cnt, anim_fps, anim_len = found

    # 이 애니메이션이 반복인지 아닌지는 파일이 직접 말해 준다.
    #
    # [확인된 사실] USERDATA 문자열 "[LOOP]" 은 언제나 애니메이션의 **root 노드
    #   0프레임**에 하나 붙는다(USERDATA 트랙의 키는 전부 1개다). 즉 파트별
    #   플래그가 아니라 **애니메이션 단위 반복 플래그**다.
    # [근거] 682개 전수: 애니메이션 13,902개 중 13,085개(94%)에 [LOOP] 이 있고
    #   817개에는 없다. 없는 쪽에 속한 노드-트랙이 4,230개, 이펙트 144개가
    #   "일부만 반복"으로 갈린다.
    # [문제] 종전에는 이 플래그를 읽지 않고 "트랙 시작값과 끝값이 얼마나
    #   어긋나는가"라는 휴리스틱으로 반복 여부를 정했다. 1회 재생이어야 할
    #   애니메이션을 되감으면 그 파츠가 프레임 경계에서 순간이동한다.
    # [처리] 플래그를 그대로 실어 보낸다. 추측은 이 값이 없을 때만 쓴다.
    # [신뢰도] CONFIRMED (전수)
    anim_loop = False
    for _t in range(t_cnt):
        _pi, _ao, _ac = struct.unpack_from("<QQQ", d, cb + t_off + _t*0x18)
        for _i in range(_ac):
            _aid, _ko, _kc = struct.unpack_from("<QQQ", d, cb + _ao + _i*0x18)
            if _aid != 30 or _kc > 4096:
                continue
            for _k in range(_kc):
                _o = cb + _ko + _k*0x28
                if _o + 0x28 > len(d):
                    break
                _u = struct.unpack_from("<I", d, _o + 0x20)[0]
                if _cstr(d, cb + _u + 0x30, 0x40).startswith("[LOOP]"):
                    anim_loop = True
    flat = ctx.cells.get(part["name"], [])
    # CELL 키프레임의 mapIndex 는 **파트의 텍스처 배열 순서**(파일 순서)다.
    #
    # [문제] 종전에는 슬롯 이름을 sorted() 로 정렬해 번호를 다시 매겼다. 슬롯이
    #   CLMP00.. 처럼 오름차순이면 우연히 맞지만, 파트가 앞선 슬롯을 다시 쓰면
    #   순서가 뒤집힌다. 예: ef_1281004_f1 의 슬롯은 [CLMP33, CLMP22] 라
    #   sorted() 가 CLMP22->0 으로 만들지만 키프레임의 0 은 CLMP33 이다.
    #   그러면 셀이 다른 시트에서 찾아지거나(=다른 그림) 아예 못 찾는다(=안 그려짐).
    # [측정] 원본 _L 682개의 PRCT 파트 1,664개 중 **143개**가 슬롯 비오름차순이고,
    #   이펙트 기준 **111 / 682 (16%)** 가 영향을 받는다. 내보낸 결과에서도 셀
    #   파츠 159,997개 중 5,992개(3.7%)가 그릴 이미지 없이 비어 있었다.
    # [처리] flat 은 pr["textures"] 를 파일 순서로 훑어 만들므로, 첫 등장 순서로
    #   번호를 매기면 그대로 파일 순서가 된다.
    # [신뢰도] CONFIRMED (슬롯 순서 전수 조사)
    mapno = {}
    for c in flat:
        if c["map"] not in mapno:
            mapno[c["map"]] = len(mapno)
    bycell = {(mapno[c["map"]], c["idx"]): c for c in flat}
    # 셀 이름 -> (mapIndex, cellIndex). CELL 트랙이 없는 노드를 이름으로 붙일 때 쓴다.
    byname = {}
    for c in flat:
        if not c.get("file"):
            continue
        byname.setdefault(c["name"], []).append((mapno[c["map"]], c["idx"]))

    base = len(out)
    node_at = {}
    inst_todo = []
    aref_todo = []
    fallback_cells = clip_default_cells(d, cb, clip)

    # 이미터 클립은 노드를 그대로 그리지 않고 파티클을 뿌린다
    emitter = read_emitter(d, cb, clip, *found[1:3]) if depth < MAX_DEPTH else None
    if emitter:
        emit_particles(ctx, emitter, role, out, parent_at, depth)
        return
    for t in range(t_cnt):
        pi, at_off, at_cnt = struct.unpack_from("<QQQ", d, cb + t_off + t*0x18)
        nd = clip["nodes"][pi] if pi < len(clip["nodes"]) else {
            "name": f"#{pi}", "parent": -1, "kind": 0, "iclip": NO_INST, "ianim": NO_INST}
        tracks, vcol, vtrack, verttrack, cellkeys, u, aref = read_tracks(d, cb, at_off, at_cnt)
        node = {"n": nd["name"],
                "p": node_at.get(nd["parent"], parent_at),
                "k": nd["kind"], "role": role, "t": tracks,
                "len": anim_len, "afps": anim_fps, "loop": anim_loop}
        if nd.get("blend"):
            node["bl"] = nd["blend"]     # 0(Mix)이 아닌 경우만 기록
        if u is not None:
            node["user"] = u
        if nd["kind"] == 1 and not cellkeys and pi in fallback_cells:
            # 이 애니메이션엔 CELL 트랙이 없다 -> 파츠에 붙어 있는 셀을 그린다
            cellkeys = [[0, fallback_cells[pi], 0]]
        if nd["kind"] == 1 and not cellkeys:
            # 마지막 수단: **노드 이름으로 셀을 찾는다.**
            #
            # [문제] 같은 클립의 어떤 애니메이션에도 CELL 트랙이 없는 셀파츠가
            #   남는다. 그리면 안 되는 게 아니라 그릴 그림을 못 찾는 것이라
            #   화면에서 통째로 빠진다. 전수 조사 결과 **1,381개 파츠 / 90개
            #   이펙트**가 그 상태였다.
            # [근거] SpriteStudio 계열은 파츠 이름을 기본으로 **표시할 셀 이름**
            #   으로 짓고, 복제본에 `_1` `_2` 접미사를 붙인다. 실제로
            #   `ef_1281004_b1_04` 의 `line_moto_1` `line_moto_2` 는 같은 파트의
            #   셀 `line_moto`(CLMP27) 와 이름이 정확히 맞는다.
            # [측정] 1,381개 중 **864개(63%)** 가 같은 PRCT 파트 안에서 이름이
            #   **유일하게** 맞는다. 후보가 여럿인 136개와 이름이 아예 없는
            #   381개는 근거가 부족하므로 **건드리지 않는다.**
            # [신뢰도] POSSIBLE — 이름 규약에 기댄 추정이라 유일 매칭만 채택한다.
            hit = byname.get(nd["name"])
            if hit is None:
                hit = byname.get(re.sub(r"(_\d+)+$", "", nd["name"]))
            if hit and len({bycell[k]["file"] for k in hit}) == 1:
                # 후보가 여럿이어도 잘라낸 그림이 하나면 어느 것을 골라도 같다
                cellkeys = [[0, hit[0], 0]]
            elif not hit:
                # 같은 파트에 없으면 **이펙트 전체**에서 찾는다. 셀은 모두 같은
                # 시트를 자른 것이라, 후보들의 이미지 해시가 하나로 모이면 어떤
                # (map, idx) 를 골라도 같은 그림이다 — 그때만 채택한다.
                want = nd["name"]
                base = re.sub(r"(_\d+)+$", "", want)
                cand = []
                for other in ctx.cells.values():
                    for c in other:
                        if c.get("file") and c["name"] in (want, base):
                            cand.append(c)
                files = {c["file"] for c in cand}
                if len(files) == 1:
                    src = cand[0]
                    # 이 파트의 셀 표에 없는 그림이므로 (map, idx) 대신 셀을
                    # 직접 얹는다. 아래 해석 루프가 bycell 을 타지 않도록
                    # 임시 항목을 등록한다.
                    key = (-1, len(bycell))
                    bycell[key] = src
                    cellkeys = [[0, key, 0]]
        if nd["kind"] == 1 and cellkeys:
            resolved = []
            seen = {}
            ct = []
            for fr, (mi, ci), curve in cellkeys:
                cell = bycell.get((mi, ci))
                if not cell or not cell["file"]:
                    continue
                key = (mi, ci)
                if key not in seen:
                    seen[key] = len(resolved)
                    resolved.append({k: cell[k] for k
                                     in ("file", "w", "h", "px", "py", "alpha",
                                         "sheet", "sw", "sh", "rx", "ry", "rw", "rh",
                                         "uy", "uh")
                                     if k in cell})
                ct.append([fr, seen[key], curve])
            if resolved:
                node["c"] = resolved[0]
                if len(resolved) > 1:
                    node["cells"] = resolved
                    node["ct"] = ct
        if vcol:
            node["v"] = vcol
        if vtrack and len(vtrack) > 1:
            node["vt"] = vtrack
        if verttrack:
            node["xt"] = verttrack
        node_at[pi] = len(out)
        out.append(node)
        if nd["kind"] == 3 and nd["iclip"] != NO_INST and depth < MAX_DEPTH:
            inst_todo.append((len(out) - 1, nd))
        elif aref and depth < MAX_DEPTH:
            aref_todo.append((len(out) - 1, aref))

    for at, nd in inst_todo:
        clips = ctx.clips[part["name"]]
        if nd["iclip"] >= len(clips):
            continue
        sub = clips[nd["iclip"]]
        sel = {"index": nd["ianim"]} if nd["ianim"] != NO_INST else {"index": 0}
        emit_clip(ctx, part, sub, sel, role, out, at, depth + 1)

    for at, (pname, cname, aname, _count) in aref_todo:
        tgt = next((q for q in ctx.ps if q["name"] == pname), None)
        if not tgt:
            continue                      # 파일에 없는 파트를 참조 (352개 중 33개)
        sub = next((cc for cc in ctx.clips.get(pname, []) if cc["name"] == cname), None)
        if not sub:
            continue
        emit_clip(ctx, tgt, sub, {"name": aname}, role, out, at, depth + 1)


def anime_targets(ctx):
    """`[ANIME]#<파트>:...` 가 가리키는 파트 이름 집합.

    그 파트들은 인스턴스/파티클의 **본체**라 참조된 자리에서만 그려야 한다.
    PRCT 파트라는 이유로 최상위에서도 그리면 원점에 같은 그림이 하나 더 얹혀
    "사진이 떠 있는" 것처럼 보인다. 1,664개 파트 중 176개(95개 이펙트)가 그랬다.
    """
    out = set()
    for part in ctx.ps:
        cb = part["cb"]
        for clip in ctx.clips[part["name"]]:
            a_off, a_cnt = clip["anims"]
            for ai in range(a_cnt):
                ao = cb + a_off + ai * 0x78
                t_off, t_cnt = struct.unpack_from("<QQ", ctx.d, ao + 0x68)
                if t_cnt > 4096:
                    continue
                for t in range(t_cnt):
                    pi, at_off, at_cnt = struct.unpack_from("<QQQ", ctx.d, cb + t_off + t * 0x18)
                    if at_cnt > 64:
                        continue
                    for i2 in range(at_cnt):
                        aid, k_off, k_cnt = struct.unpack_from("<QQQ", ctx.d, cb + at_off + i2 * 0x18)
                        if aid != 30 or k_cnt > 4096:
                            continue
                        for k in range(k_cnt):
                            u = struct.unpack_from("<I", ctx.d, cb + k_off + k * 0x28 + 0x20)[0]
                            sp = struct.unpack_from("<I", ctx.d, cb + u + 0x20)[0]
                            if not sp:
                                continue
                            m = re.match(r"\[ANIME\]#([^:]+):", _cstr(ctx.d, cb + sp, 0x40))
                            if m:
                                out.add(m.group(1))
    return out


def restore_tree_order(parts):
    """Restore the native stable part order after recursively inlining clips.

    ``emit_clip`` has to discover all direct nodes before it can expand instance
    and ANIME references.  That makes the flat export breadth-first: referenced
    children are appended after later siblings.  The native scene graph visits
    those children at the reference node, and its priority sort is stable, so
    equal-priority children must precede the reference node's later siblings.

    Rebuild the flat array in pre-order and remap parent indices.  This preserves
    explicit priority sorting in the player while restoring its equal-priority
    tie order without any effect-specific rules.
    """
    if not parts:
        return parts
    children = [[] for _ in parts]
    roots = []
    for i, node in enumerate(parts):
        parent = node.get("p", -1)
        if isinstance(parent, int) and 0 <= parent < len(parts) and parent != i:
            children[parent].append(i)
        else:
            roots.append(i)

    order = []
    seen = set()

    def visit(i):
        if i in seen:
            return
        seen.add(i)
        order.append(i)
        for child in children[i]:
            visit(child)

    for root in roots:
        visit(root)
    # Malformed/cyclic input should remain visible rather than disappear.
    for i in range(len(parts)):
        visit(i)

    remap = {old: new for new, old in enumerate(order)}
    result = []
    for old in order:
        node = parts[old]
        parent = node.get("p", -1)
        node["p"] = remap.get(parent, -1)
        result.append(node)
    return result


def build(effect_id, cache):
    ctx = load_effect(effect_id, cache)
    if not ctx:
        return [], None
    out, meta = [], None
    skip = anime_targets(ctx)
    for part in ctx.ps:
        if part["name"] in skip:
            continue          # 인스턴스/파티클 본체 — 참조된 자리에서만 그린다
        role = "front" if re.search(r"_f\d+(_\d+)?$", part["name"]) else "back"
        for clip in ctx.clips[part["name"]]:
            if clip["name"] != part["name"]:
                continue
            if meta is None:
                a_off, a_cnt = clip["anims"]
                sw = sh = 0.0
                if a_cnt:
                    ao = part["cb"] + a_off
                    sw, sh = struct.unpack_from("<ff", ctx.d, ao + 0x58)
                # 최상위 애니메이션 이름은 파일마다 다르다: anime_1(1435) ·
                # emitter(104) · anime(61) · anime1(56) · b1(6) · f1(2).
                # 이름을 고정하면 나머지 229개 파트(14%)가 통째로 빠진다.
                top = find_anim(ctx.d, part["cb"], clip, index=0)
                meta = {"canvasW": clip["canvas"][0], "canvasH": clip["canvas"][1],
                        "stageW": round(sw, 1), "stageH": round(sh, 1),
                        # clip +0x40 and anim +0x48 are both a constant 30 in
                        # every effect and equal maxKeyFrame+1 divisors -> fps.
                        # clip +0x44 is a constant 11 of unknown meaning.
                        "UNKNOWN_clip44": clip["fps"],
                        "frames": top[4] if top else clip["frames"],
                        "fps": top[3] if top else clip["fps"]}
            emit_clip(ctx, part, clip, {"index": 0}, role, out, -1, 0)
    return restore_tree_order(out), meta


if __name__ == "__main__":
    out_dir, ids = sys.argv[1], sys.argv[2:]
    os.makedirs(out_dir, exist_ok=True)
    if not ids:
        ids = [re.match(rf"ANSS_EF_(\d+)_{CLS}\.CHK$", f).group(1)
               for f in sorted(os.listdir(CHK_DIR)) if f.endswith(f"_{CLS}.CHK")]
    total = 0
    done = 0
    for n, eid in enumerate(ids):
        if n % 60 == 0:
            print(f"  ...{n}/{len(ids)}", flush=True)
        cache = {}
        try:
            parts_, meta = build(eid, cache)
        except Exception as ex:
            print(f"  !! {eid}: {ex}")
            continue
        if not parts_:
            continue
        doc = {"effectId": int(eid), **(meta or {}), "parts": parts_}
        p = os.path.join(out_dir, f"{eid}.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(doc, f, separators=(",", ":"))
        total += os.path.getsize(p)
        done += 1
    print(f"exported {done}/{len(ids)} effects, {total/1048576:.1f} MB")
