"""UV 창이 **빈 자리**를 집는 파츠 목록을 만든다 -> public/effects/uv-wrap.json

[문제] 사용자 보고 "배치가 미스매치 나거나 재생 자체가 이상하다. 약간 어긋난
  것들이 대부분". 시트의 부분 셀에서 UV 창이 셀 밖으로 나가면 현행 clamp 는
  가장자리 한 줄을 늘려 그리거나(뿌연 얼룩) 이웃 스프라이트를 비춘다(어긋남).

[결정적 근거] 실제 시트 알파로 창의 평균 알파를 재면 (남은 minor 92개,
  uvsy 보유 · r74 게이트 미해당 파츠 1,109개 / 9,837프레임):
    clamp(현행)     빈 창 7.4%
    wrap-cell       빈 창 1.7%   <- 4.4배 개선
    wrap-container  빈 창 7.0%

[왜 전역 전환이 아닌가] §41 의 사인 광택(1082105 sign_ef_L/R, 이동폭 0.72~0.91)
  은 **의도적으로 시트의 다른 영역**(로고 그림)을 비춘다 — 그건 빈 자리를 집지
  않으므로 이 표에 들어오지 않는다. 그래서 "clamp 가 실제로 빈 자리를 집는
  파츠"만 골라 런타임에서 셀 단위로 감는다.

[판정 기준] 한 프레임이라도 clamp 창의 평균 알파 < 0.02 이고, 같은 프레임에서
  wrap-cell 창은 >= 0.05 인 파츠. 즉 **현행이 확실히 빈 자리를 집고 감으면
  그림이 있는** 경우만.
[신뢰도] CONFIRMED (시트 픽셀 실측)
"""
import gzip, json, glob, os
import numpy as np
from PIL import Image

def samp(tr, f):
    if not tr: return None
    ks = [(k[0], k[1]) for k in tr if isinstance(k, (list, tuple)) and len(k) >= 2]
    if not ks: return None
    if f <= ks[0][0]: return ks[0][1]
    if f >= ks[-1][0]: return ks[-1][1]
    for i in range(len(ks) - 1):
        (f0, v0), (f1, v1) = ks[i], ks[i + 1]
        if f0 <= f <= f1:
            return v0 if f1 == f0 else v0 + (v1 - v0) * (f - f0) / (f1 - f0)
    return ks[-1][1]

_sheets = {}
def sheet_alpha(h):
    if h not in _sheets:
        _sheets[h] = None
        for base in ("public/effects/sheets-webp", "public/effects/sheets"):
            for ext in (".webp", ".png"):
                p = os.path.join(base, h + ext)
                if os.path.exists(p):
                    a = np.array(Image.open(p).convert("RGBA"))[:, :, 3]
                    _sheets[h] = a.astype(np.float32) / 255
                    break
            if _sheets[h] is not None: break
    return _sheets[h]

out = {}
for fp in sorted(glob.glob("public/effects/anim-gz/*.json.gz")):
    eid = os.path.basename(fp).split(".")[0]
    d = json.loads(gzip.open(fp).read())
    N = d.get("frames") or 120
    names = set()
    for p in d["parts"]:
        t = p.get("t", {}); c = p.get("c")
        if not c or not c.get("sheet"): continue
        if c.get("rw") == c.get("sw") and c.get("rh") == c.get("sh"): continue
        if not (t.get("uvy") or t.get("uvsy")): continue
        A = sheet_alpha(c["sheet"])
        if A is None: continue
        rh, sh = c["rh"], c["sh"]; ry = c.get("ry", 0)
        rx, rw = c.get("rx", 0), c["rw"]
        hit = False
        for f in range(0, N, max(1, N // 24)):
            oy = samp(t.get("uvy"), f) or 0.0
            sy = samp(t.get("uvsy"), f)
            sy = 1.0 if sy is None else sy
            if abs(sy) < 1e-6: continue
            winH = max(1, rh * abs(sy))
            def mean(top):
                y0 = int(max(0, min(sh - 1, top))); y1 = int(max(1, min(sh, top + winH)))
                w = A[y0:y1, rx:rx + rw]
                return float(w.mean()) if w.size else 0.0
            base = ry + rh * 0.5 - winH * 0.5
            clamp = mean(min(max(base + oy * sh, 0), sh - winH))
            wrap = mean(ry + ((base + oy * rh) - ry) % rh)
            if clamp < 0.02 and wrap >= 0.05:
                hit = True; break
        if hit: names.add(p["n"])
    if names: out[eid] = sorted(names)

os.makedirs("public/effects", exist_ok=True)
json.dump(out, open("public/effects/uv-wrap.json", "w"), separators=(",", ":"))
tot = sum(len(v) for v in out.values())
print(f"uv-wrap.json: 효과 {len(out)}개 · 파츠 {tot}개")
