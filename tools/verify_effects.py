#!/usr/bin/env python3
"""내보낸 ANSS 문서 전수 검증.

이펙트별로 아래를 재고 문제 있는 것부터 보고한다.
  1. 보이지 않는 셀 파츠  — 셀이 해결되지 않아 아무것도 안 그리는 파츠
  2. 랩 불연속           — 파츠가 자기 길이 끝에서 0프레임으로 돌아갈 때 튀는 양
  3. 가산 포화           — 한 프레임에 겹치는 Add 파츠의 알파 합 (흰색으로 뭉개지는 지표)
  4. 무게중심 이탈       — 그려지는 셀이 스테이지 밖으로 나가는 비율
스크립트는 판정을 하지 않고 수치를 낸다. 임계값은 보고용이다.
"""
import json, math, os, sys, glob, collections

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def sample(t, f, fb=0.0):
    if not t:
        return fb
    if f <= t[0][0]:
        return t[0][1]
    if f >= t[-1][0]:
        return t[-1][1]
    p = t[0]
    for k in t:
        if k[0] > f:
            r = (f - p[0]) / max(1, k[0] - p[0])
            return p[1] + (k[1] - p[1]) * r
        p = k
    return p[1]


def step(t, f, fb=0.0):
    if not t:
        return fb
    v = fb if f < t[0][0] else t[0][1]
    for k in t:
        if k[0] > f:
            break
        v = k[1]
    return v


def closed(p, doc):
    """끝 포즈가 시작 포즈로 돌아오는가 = 닫힌 루프로 작성됐는가."""
    L = p.get("len") or doc.get("frames") or 1
    if L < 4:
        return True
    t = p.get("t", {})
    # 회전은 주기 운동이라 판정에서 뺀다 (넣으면 돌던 파츠가 도중에 굳는다)
    d = sum(abs(sample(t.get(k), L - 1, fb) - sample(t.get(k), 0, fb))
            for k, fb in (("x", 0), ("y", 0), ("sx", 1), ("sy", 1), ("a", 1)))
    return d < 2.0


def plan(doc):
    """시계 그룹(= 같은 애니메이션) 단위로 반복/정지를 정한다.

    파츠마다 따로 정하면 같은 애니메이션 안에서 부모는 되감기고 자식은 멈춰
    조립이 찢어진다(1201033 의 core_fire_2 가 99단위 튀던 원인).
    """
    if "_plan" not in doc:
        parts = doc["parts"]
        n = len(parts)
        L = [p.get("len") or doc.get("frames") or 1 for p in parts]
        group = [-1] * n
        for i, p in enumerate(parts):
            par = p["p"]
            group[i] = group[par] if (0 <= par < i and L[par] == L[i]) else i
        closes = [True] * n
        for i, p in enumerate(parts):
            if L[i] < 4:
                continue
            t = p.get("t", {})
            closes[i] = sum(
                abs(sample(t.get(k), L[i] - 1, fb) - sample(t.get(k), 0, fb))
                for k, fb in (("x", 0), ("y", 0), ("sx", 1), ("sy", 1), ("a", 1))) < 20.0
        gt, gb = {}, {}
        for i in range(n):
            gt[group[i]] = gt.get(group[i], 0) + 1
            if not closes[i]:
                gb[group[i]] = gb.get(group[i], 0) + 1
        # 그룹의 절반 이상이 닫히지 않을 때만 정지
        gl = {g: (gb.get(g, 0) / max(t, 1)) < 0.5 for g, t in gt.items()}
        loops = [False] * n
        spin = [0.0] * n
        for i, p in enumerate(parts):
            # 원본 [LOOP] 플래그가 있으면 그대로. 없을 때만 휴리스틱.
            flag = p.get("loop")
            ok = flag if flag is not None else gl.get(group[i], True)
            par = p["p"]
            if 0 <= par < i and not loops[par]:
                ok = False
            loops[i] = ok
            if not ok or L[i] < 4:
                continue
            t = p.get("t", {})
            dr = sample(t.get("rot"), L[i] - 1, 0) - sample(t.get("rot"), 0, 0)
            snap = abs(dr) % 360
            spin[i] = dr if min(snap, 360 - snap) >= 5 else 0.0
        doc["_plan"] = (max(L) if L else 1, loops, spin, closes)
    return doc["_plan"]


def draws(doc, frame):
    W = [None] * len(doc["parts"])
    out = []
    period, loops, spin, closes = plan(doc)
    for i, p in enumerate(doc["parts"]):
        par = W[p["p"]] if 0 <= p["p"] < i else None
        F = p.get("len") or doc.get("frames") or 1
        ph = (par["ph"] if par else 0) + (p.get("user") or 0)
        # 하이브리드(r26): 닫힌 루프만 자기 길이 반복, 나머지는 마스터 재시드
        M = max(doc.get("frames") or 1, F if F > (doc.get("frames") or 1) else 1)
        lf = (frame + ph) % F if (loops[i] and closes[i]) else min(F - 1, ((frame + ph) % M + M) % M)
        cyc = (frame + ph) // F if spin[i] else 0
        t = p.get("t", {})
        x, y = sample(t.get("x"), lf), sample(t.get("y"), lf)
        rot = math.radians(sample(t.get("rot"), lf) + cyc * spin[i])
        s1, s2 = sample(t.get("sx"), lf, 1), sample(t.get("sy"), lf, 1)
        s1 *= math.cos(math.radians(sample(t.get("ry"), lf))) or 1e-4
        s2 *= math.cos(math.radians(sample(t.get("rx"), lf))) or 1e-4
        if step(t.get("fh"), lf) > .5 or step(t.get("ifh"), lf) > .5:
            s1 = -s1
        if step(t.get("fv"), lf) > .5 or step(t.get("ifv"), lf) > .5:
            s2 = -s2
        c, s = math.cos(rot), math.sin(rot)
        a11, a12, a21, a22 = c * s1, -s * s2, s * s1, c * s2
        hid = step(t.get("hide"), lf) > .5
        al = sample(t.get("a"), lf, 1)
        if par:
            w = dict(a=par["a"] * a11 + par["c"] * a21, b=par["b"] * a11 + par["d"] * a21,
                     c=par["a"] * a12 + par["c"] * a22, d=par["b"] * a12 + par["d"] * a22,
                     x=par["x"] + par["a"] * x + par["c"] * y,
                     y=par["y"] + par["b"] * x + par["d"] * y,
                     hid=par["hid"] or hid, al=par["al"] * al, ph=ph)
        else:
            w = dict(a=a11, b=a21, c=a12, d=a22, x=x, y=y, hid=hid, al=al, ph=ph)
        W[i] = w
        if p["k"] != 1 or w["hid"] or w["al"] <= .004:
            continue
        cell = p.get("c")
        if p.get("cells"):
            cell = p["cells"][min(len(p["cells"]) - 1, max(0, int(step(p.get("ct"), lf))))]
        if not cell or not cell.get("file"):
            continue
        ox = -(cell["px"] + sample(t.get("pvx"), lf)) * cell["w"]
        oy = -(cell["py"] + sample(t.get("pvy"), lf)) * cell["h"]
        out.append(dict(i=i, part=p, cell=cell, alpha=w["al"], lf=lf,
                        a=w["a"], b=w["b"], c=w["c"], d=w["d"],
                        x=w["x"] + w["a"] * ox + w["c"] * oy,
                        y=w["y"] + w["b"] * ox + w["d"] * oy))
    return out


def check(path):
    doc = json.load(open(path, encoding="utf-8"))
    parts = doc["parts"]
    cellparts = [p for p in parts if p["k"] == 1]
    nocell = sum(1 for p in cellparts if not p.get("c"))

    hw = (doc.get("stageW") or 720) / 2
    hh = (doc.get("stageH") or 1136) / 2
    frames = doc.get("frames") or 30
    probe = sorted({0, frames // 4, frames // 2, (frames * 3) // 4, frames - 1})
    add_alpha, ndraw, outside = 0.0, 0, 0
    for fr in probe:
        qs = draws(doc, fr)
        ndraw += len(qs)
        for q in qs:
            if q["part"].get("bl", 0) == 2:
                add_alpha += q["alpha"]
            if abs(q["x"]) > hw or abs(q["y"]) > hh:
                outside += 1
    n = max(len(probe), 1)

    # 랩 불연속: 파츠가 자기 길이 끝 -> 0 으로 돌아갈 때의 세계좌표 이동
    jump, jumped = 0.0, 0
    by_len = collections.defaultdict(list)
    period, loops, _sp, _cl = plan(doc)
    for i, p in enumerate(parts):
        # 되감지 않는 파츠는 랩이 없으니 불연속 대상이 아니다
        if p["k"] == 1 and p.get("len", 0) > 3 and loops[i]:
            by_len[p["len"]].append(p)
    for L, ps in by_len.items():
        # 실제 연속 프레임을 비교한다: 랩 직전(L-1)과 랩 직후(L).
        # 회전을 사이클마다 이어 돌리므로 0프레임과 비교하면 안 된다.
        a = {q["i"]: q for q in draws(doc, L - 1)}
        b = {q["i"]: q for q in draws(doc, L)}
        for p in ps:
            i = parts.index(p)
            if i in a and i in b:
                dx = abs(a[i]["x"] - b[i]["x"]) + abs(a[i]["y"] - b[i]["y"])
                da = abs(a[i]["alpha"] - b[i]["alpha"])
                if dx > 8 or da > 0.25:
                    jumped += 1
                    jump += dx + da * 100
    return dict(id=doc["effectId"], parts=len(parts), cellparts=len(cellparts), nocell=nocell,
                draws=ndraw / n, addAlpha=add_alpha / n, outside=outside / max(ndraw, 1),
                wrapJump=jump, wrapParts=jumped,
                wrapLens=sorted(by_len)[:6])


def main(out_json=None):
    files = sorted(glob.glob("public/effects/anim/*.json"))
    rows = []
    for i, f in enumerate(files):
        try:
            rows.append(check(f))
        except Exception as e:
            rows.append(dict(id=os.path.basename(f)[:-5], error=str(e)[:80]))
        if i % 50 == 0:
            print(f"  ...{i}/{len(files)}", file=sys.stderr)
    ok = [r for r in rows if "error" not in r]
    print(f"검증 {len(rows)}개 (오류 {len(rows)-len(ok)}개)\n")
    print(f"보이지 않는 셀 파츠가 있는 이펙트: {sum(1 for r in ok if r['nocell'])}개, "
          f"총 {sum(r['nocell'] for r in ok)}개 파츠")
    print(f"스테이지 밖 비율 10%↑: {sum(1 for r in ok if r['outside'] > .1)}개")
    print(f"가산 알파합 100↑(흰색 포화 위험): {sum(1 for r in ok if r['addAlpha'] > 100)}개")
    print(f"랩에서 튀는 파츠가 있는 이펙트: {sum(1 for r in ok if r['wrapParts'])}개, "
          f"총 {sum(r['wrapParts'] for r in ok)}개 파츠\n")

    def top(key, label, n=12, fmt="{:.1f}"):
        print(f"── {label} 상위 {n}")
        for r in sorted(ok, key=lambda r: -r[key])[:n]:
            print(f"   {r['id']}  {key}={fmt.format(r[key])}  파츠 {r['cellparts']}  "
                  f"그리기 {r['draws']:.0f}  길이 {r['wrapLens']}")
        print()
    top("wrapParts", "랩 불연속 파츠 수", fmt="{:.0f}")
    top("addAlpha", "가산 알파합")
    top("nocell", "셀 미해결 파츠", fmt="{:.0f}")
    top("outside", "스테이지 밖 비율", fmt="{:.2f}")
    if out_json:
        json.dump(rows, open(out_json, "w"), ensure_ascii=False, indent=1)
        print("보고서:", out_json)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
