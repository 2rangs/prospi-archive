"""`_t`/`_u` 쌍 셀을 하나의 **스트립 텍스처**로 합친다.

[문제] 시트의 부분 셀을 UV 로 굴리는 파츠에서, r74 는 **개별 셀 텍스처**를
  repeat 로 감았다. 그런데 `_t`/`_u` 는 하나의 긴 그림을 위/아래 두 조각으로
  나눈 것이라 반복 주기가 **셀 1장이 아니라 쌍(2장)** 이어야 한다. 반쪽을 감으면
  내용이 두 배 빠르게 반복되어 겹치고 뭉개진다.

[근거]
  - 시트에서 두 셀이 정확히 인접(같은 rx·rw·rh, ry 가 rh 만큼 차이)
  - 정점색 알파가 **정반대**로 걸려 이음매에서 교차 페이드 —
    전 이펙트 668쌍 중 인접 624쌍에서 **624/624 알파 연속** 확인
  - 품질 라벨 대조: 해당 파츠 보유 효과가 minor 57%(40/70) vs clean 10%(63/612)
    = **5.7배** 편중

[수정 — r90] 처음에는 **개별 스프라이트 파일**(cell.file)을 붙였는데, 그 파일은
  잉크 경계로 **트림**돼 있어 셀 rect 와 크기가 다르다(예: 1285005 eff_t 는 셀
  256x64 인데 개별 파일은 116x64). 그래서 UV 가 엉뚱한 자리를 집어 흐르는 띠가
  **어두운 조각**으로 나왔다. 이제 **시트에서 rect 를 직접 크롭**해 붙인다.

[수정 — r90b] 표의 키를 **파츠 이름**에서 **셀 식별자**로 바꿨다. 같은 이름이
  서로 다른 셀을 쓰는 경우가 있다 (1285005 의 `eff_t` 는 256x64 / 132x64 /
  116x32 세 종류). 이름으로 키를 잡으면 마지막 항목이 다른 셀의 draw 에도
  적용돼 UV 가 엉뚱한 자리를 집는다 — 흐르는 띠가 어두운 조각으로 나온 원인.

[처리] 쌍의 두 셀을 위아래로 붙인 PNG 를 만들고,
  **셀별로** 그 스트립과 자기 절반(0=위, 1=아래)을 표에 적는다. 렌더러는
  스트립을 repeat 로 샘플링하므로 주기가 쌍 전체가 된다.
[신뢰도] 구조 CONFIRMED / 시각 확인은 사용자 몫.
"""
import gzip, json, glob, os, hashlib
from PIL import Image

SPRITE_DIRS = ("public/effects/sprites-webp", "public/effects/sprites")
OUT_DIR = "public/effects/strips-webp"

SHEET_DIRS = ("public/effects/sheets-webp", "public/effects/sheets")

def sheet_path(h):
    for b in SHEET_DIRS:
        for e in (".webp", ".png"):
            p = os.path.join(b, h + e)
            if os.path.exists(p):
                return p
    return None

_sheet_img = {}
def sheet_img(h):
    if h not in _sheet_img:
        p = sheet_path(h)
        _sheet_img[h] = Image.open(p).convert("RGBA") if p else None
    return _sheet_img[h]

def crop_cell(c):
    """시트에서 셀 rect 를 그대로 잘라낸다 (트림된 개별 파일을 쓰지 않는다)."""
    im = sheet_img(c["sheet"])
    if im is None:
        return None
    x, y = int(c.get("rx", 0)), int(c.get("ry", 0))
    w, h = int(c["rw"]), int(c["rh"])
    return im.crop((x, y, x + w, y + h))

os.makedirs(OUT_DIR, exist_ok=True)
made = {}          # (top,bot) -> strip hash
table = {}         # effectId -> partName -> [stripHash, half]

for fp in sorted(glob.glob("public/effects/anim-gz/*.json.gz")):
    eid = os.path.basename(fp).split(".")[0]
    d = json.loads(gzip.open(fp).read())
    parts = d["parts"]
    bypar = {}
    for p in parts:
        c = p.get("c")
        if not c or not c.get("sheet") or not p.get("t", {}).get("uvy"):
            continue
        bypar.setdefault(p.get("p"), []).append((p, c))
    ent = {}
    for items in bypar.values():
        for p, c in items:
            for q, c2 in items:
                if p is q:
                    continue
                if (c["rw"], c["rh"]) != (c2["rw"], c2["rh"]):
                    continue
                if c.get("rx") != c2.get("rx"):
                    continue
                if c2.get("ry", 0) != c.get("ry", 0) + c["rh"]:
                    continue
                key = (c["sheet"], c.get("rx", 0), c.get("ry", 0), c["rw"], c["rh"])
                h = made.get(key)
                if h is None:
                    ia, ib = crop_cell(c), crop_cell(c2)
                    if ia is None or ib is None:
                        continue
                    w = max(ia.width, ib.width)
                    strip = Image.new("RGBA", (w, ia.height + ib.height), (0, 0, 0, 0))
                    strip.paste(ia, (0, 0))
                    strip.paste(ib, (0, ia.height))
                    h = hashlib.md5(strip.tobytes()).hexdigest()[:16]
                    strip.save(os.path.join(OUT_DIR, h + ".webp"), quality=92, method=4)
                    made[key] = h
                ck = lambda cc: f"{cc['sheet']}:{cc.get('rx',0)},{cc.get('ry',0)},{cc['rw']}x{cc['rh']}"
                ent[ck(c)] = [h, 0]       # 위쪽 절반
                ent[ck(c2)] = [h, 1]      # 아래쪽 절반
    if ent:
        table[eid] = ent

json.dump(table, open("public/effects/uv-strip.json", "w"), separators=(",", ":"))
print(f"strips {len(made)}장 · 표 효과 {len(table)}개 · 파트이름 {sum(len(v) for v in table.values())}개")
