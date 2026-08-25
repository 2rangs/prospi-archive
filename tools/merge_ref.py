#!/usr/bin/env python3
"""긁어 온 레퍼런스 카드 표기값을 우리 카드에 병합한다.

1차 키: (정규화 이름, 수비 3종 정확 일치) — 清宮 검증으로 확립된 강한 키.
2차 키: (정규화 이름, 연도) 가 양쪽 모두 유일할 때.
결과: public/data/ref-stats.json  { ourCardId: {...ref fields} }
"""
import argparse, json, re, collections, sys
from pathlib import Path
from card_rules import apply_card_rules, variant_family

ROOT = Path(__file__).resolve().parents[1]
REF = ROOT / "output" / "rakda3" / "cards.jsonl"
CARDS = ROOT / "public" / "data" / "cards.json"
OUT = ROOT / "public" / "data" / "ref-stats.json"

norm = lambda s: re.sub(r"[\s　・.．]", "", s or "")

def surname(s):
    """성만. 레퍼런스는 외국인 선수를 **성만** 적는다.

    [문제] 원장 이름 파서를 고쳐 이름 전체를 얻게 되자(874명 교정) 오히려 매칭이
      9,203 -> 8,544 로 **떨어졌다**. 레퍼런스는 アブレウ / オスナ 처럼 성만 쓰는데
      우리가 アブレウ アルベルト 로 바뀌어 키가 어긋난 것이다.
    [처리] 풀네임으로 먼저 맞추고, 안 되면 성으로 한 번 더 맞춘다. 같은 성이 여럿인
      경우(オスナ ホセ / オスナ ロベルト)는 1차 키의 수비 3종이 갈라 준다.
    [측정] 9,203(교정 전) -> 8,544(교정 후, 폴백 없음) -> **9,525**(폴백 적용).
    """
    return norm((s or "").split(" ")[0])

def year_of(series):
    m = re.match(r"(\d{4})S", series or "")
    return int(m.group(1)) if m else None

def series_marker(card):
    """Return the rakda3 series marker encoded by the card art family.

    The first two variant digits are the release family; the following two are
    the club/art suffix.  Only families whose meaning is stable are listed.
    """
    y = card.get("year")
    try:
        pre = int(str(card.get("variant", "")).zfill(4)[:2])
    except ValueError:
        return None
    if pre % 2 == 0:
        pre -= 1
    markers = {
        1: f"{y}S1",
        3: f"{y}S1覚(",
        5: f"{y}S1SP(TS",
        7: f"{y}S1SP(SL",
        9: f"{y}S1SP(EX",
        11: f"{y}S1SP(ドラ1)",
        15: f"{y}S1SP(MJR)",
        19: f"{y}S1SP(WS",
        21: f"{y}S2",
        23: f"{y}S2覚(",
        25: f"{y}S2SP(OB",
        27: f"{y}S2SP(WS",
        31: f"{y}S2SP(SM",
        33: f"{y}S2SP(PCS)",
        37: f"{y}S2SP(AN",
        39: f"{y}S2SP(ULT)",
        41: f"{y}S2SP(JT)",
        45: f"{y}S2SP(OBD)",
        49: f"{y}S2SP(SLC)",
        51: f"{y}S2SP(JP",
    }
    marker = markers.get(pre)
    # Plain S1/S2 must not swallow their SP/awakening releases.
    if pre in (1, 21):
        return (marker, "exact")
    return (marker, "prefix") if marker else None

def family_ref(card, candidates):
    marker = series_marker(card)
    if not marker:
        return None
    value, mode = marker
    same_kind = [r for r in candidates if r.get("kind") == card.get("playerType")]
    matched = [r for r in same_kind if
               (r.get("series") == value if mode == "exact" else r.get("series", "").startswith(value))]
    if len(matched) == 1:
        return matched[0]
    d = card.get("defense")
    if d and matched:
        exact = [r for r in matched if r.get("catch") and r.get("throw") and r.get("arm") and
                 (r["catch"][1], r["throw"][1], r["arm"][1]) ==
                 (d["catching"], d["throwing"], d["shoulder"])]
        if len(exact) == 1:
            return exact[0]
    return None

def growth(base):
    """특훈 Lv0..10. Δ = round(base×0.12), 레벨 분배는 브레젠험.
    앵커 9스탯(清宮/菊池/田淵) 전부 적중 — docs/DATA-VERIFY.md 참고."""
    delta = round(base * 0.12)
    return [base + (delta * lv + 5) // 10 if False else base + round(delta * lv / 10) for lv in range(11)]

def lv0_from_max(mx):
    """MAX = L0 + round(L0×0.12) 역산."""
    for l0 in range(mx, mx - 15, -1):
        if l0 + round(l0 * 0.12) == mx:
            return l0
    return None

def exact_two_way_ref(card, candidates):
    """Disambiguate Ohtani's pitcher/batter cards by baked visual family."""
    if str(card.get("playerId", "")) != "3945":
        return None
    family = variant_family(card)
    year = int(card.get("year", 0))
    kind = card.get("playerType")
    same = [r for r in candidates if r.get("kind") == kind]
    if year < 2017 or family is None:
        return same[0] if len(same) == 1 else None

    marker = None
    if family in (27, 28): marker = "(WS"
    elif family in (31, 32): marker = "(SM"
    elif family in (47, 48, 91, 92): marker = "(OBWC)"
    elif family == 51: marker = "(JP"
    elif year == 2017 and family in (1, 2): marker = "2017S1"
    elif year == 2017 and family in (21, 22): marker = "2017S2"
    elif year == 2017 and family == 34: marker = "(PCS"
    elif year == 2017 and family in (37, 38): marker = "(AN"
    if marker:
        matched = [r for r in same if marker in r.get("series", "")]
        if len(matched) == 1:
            return matched[0]
    return same[0] if len(same) == 1 else None

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=REF)
    parser.add_argument("--cards", type=Path, default=CARDS)
    parser.add_argument("--output", type=Path, default=OUT)
    args = parser.parse_args()
    refs = [json.loads(l) for l in args.input.open(encoding="utf-8")]
    cards = json.load(args.cards.open(encoding="utf-8"))
    corrected = apply_card_rules(cards)
    if corrected:
        json.dump(cards, args.cards.open("w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"ref {len(refs)} · cards {len(cards)}")

    # 1차: 이름+수비 3종
    by_def = collections.defaultdict(list)
    for r in refs:
        if r.get("catch") and r.get("throw") and r.get("arm"):
            by_def[(norm(r["name"]), r["catch"][1], r["throw"][1], r["arm"][1])].append(r)

    by_year = collections.defaultdict(list)
    for r in refs:
        y = year_of(r["series"])
        if y: by_year[(norm(r["name"]), y)].append(r)

    ours_year = collections.defaultdict(list)
    for c in cards:
        ours_year[(norm(c["name"]), c["year"])].append(c)
    ours_sur = collections.defaultdict(list)
    for c in cards:
        ours_sur[(surname(c["name"]), c["year"])].append(c)

    # 3차용: 이름만으로 모은 뒤 **만장일치인 필드만** 쓴다.
    by_name = collections.defaultdict(list)
    for r in refs:
        by_name[norm(r["name"])].append(r)
        sn = surname(r["name"])
        if sn != norm(r["name"]):
            by_name[sn].append(r)

    out, hit_family, hit_def, hit_year, hit_kind, hit_part, miss = {}, 0, 0, 0, 0, 0, 0
    for c in cards:
        r = None
        d = c.get("defense")
        names = [norm(c["name"])]
        sn = surname(c["name"])
        if sn != names[0]:
            names.append(sn)
        has_family = series_marker(c) is not None
        for nm in names:
            r = family_ref(c, by_year.get((nm, c["year"]), []))
            if r:
                hit_family += 1
                break
        if d and not has_family:
            for nm in names if r is None else ():
                v = by_def.get((nm, d["catching"], d["throwing"], d["shoulder"]))
                if not v:
                    continue
                # 수비 일치가 여러 장이면 연도가 같은 것을 우선
                same = [x for x in v if year_of(x["series"]) == c["year"]]
                r = (same or v)[0] if (len(v) == 1 or same) else None
                if r:
                    hit_def += 1
                    break
        if r is None and not has_family:
            for nm, tbl in ((names[0], ours_year),
                            *(((sn, ours_sur),) if len(names) > 1 else ())):
                k = (nm, c["year"])
                rv, cv = by_year.get(k, []), tbl.get(k, [])
                if len(rv) == 1 and len(cv) == 1:
                    r = rv[0]; hit_year += 1; break
        if r is None and not has_family:
            # 투타겸업은 같은 이름·연도에 양쪽 카드가 있으므로 이미지 family까지 쓴다.
            for nm in names:
                r = exact_two_way_ref(c, by_year.get((nm, c["year"]), []))
                if r:
                    hit_kind += 1
                    break

        if r is None and not has_family:
            # 2.5차 - 유형(kind)으로 가른다.
            #
            # [문제] 大谷 翔平처럼 한 해에 투수 카드와 타자 카드가 같이 나오는
            #   선수는 (이름, 연도) 가 다대다라 1·2차가 전부 실패한다. 그래서 46장이
            #   전부 같은 스텟(선수 base 폴백)으로 보였다.
            # [근거] 레퍼런스는 batter-list / pitcher-list 를 따로 제공하고 한 행마다
            #   미트·파워·주력 / 구위·제구·스태미나가 실제로 다르다.
            # [처리] 우리 카드의 유형과 같은 kind 의 ref 행만 후보로 두고, 그 후보가
            #   그 해에 **하나뿐이면** 붙인다. 여럿이면 붙이지 않는다(3차로 넘긴다).
            #   유형이 갈리는 지점이라 스텟 종류(투수용/타자용)는 반드시 맞는다.
            # [신뢰도] 후보가 유일할 때만 쓰므로 STRONG.
            for nm in names:
                rv = [x for x in by_year.get((nm, c["year"]), [])
                      if x["kind"] == c.get("playerType")]
                if len(rv) == 1:
                    r = rv[0]; hit_kind += 1; break

        if r is None:
            # 3차 - 부분 매칭.
            #
            # [문제] 大谷 翔平처럼 카드가 많고 수비값이 원장(52/50/85)과 표기값
            #   (52/68/83 등) 어디에도 안 맞으면 46장 전부 매칭이 안 된다. 그러면
            #   팀 필터에서 아예 사라진다 - "닛폰햄인데 안 나온다".
            # [처리] 이름(또는 성)으로 모아 **모든 후보가 같은 값을 갖는 필드만**
            #   채운다. 팀은 37장 전부 日 이므로 안전하다. 능력치·스피리츠처럼
            #   카드마다 다른 값은 채우지 않는다(kind 도 투수 20/타자 17 로 갈리면 뺀다).
            # [신뢰도] 채우는 필드에 한해 CONFIRMED - 만장일치가 조건이다.
            cand = by_name.get(names[0]) or (by_name.get(sn) if len(names) > 1 else None)
            part = {}
            if cand:
                for fld in ("team", "kind", "hand", "trajectory"):
                    vals = {x.get(fld) for x in cand if x.get(fld)}
                    if len(vals) == 1:
                        part[fld] = vals.pop()
            if part:
                part["partial"] = True
                out[c["id"]] = part
                hit_part += 1
                continue
            miss += 1
            continue
        e = dict(refId=r["ref_id"], series=r["series"], team=r["team"], pos=r["pos"],
                 spirits=r["spirits"], cost=r["cost"], hand=r["hand"],
                 abilities=r.get("abilities") or [],
                 refAptitude=r.get("aptitude") or {})
        if r["kind"] == "batter":
            e["kind"] = "batter"
            e["max"] = {k2: r[k2][1] for k2 in ("meet","power","speed") if r.get(k2)}
            e["defense"] = {k2: r[k2][1] for k2 in ("catch","throw","arm") if r.get(k2)}
            e["trajectory"] = r.get("trajectory")
            lv0 = {k2: lv0_from_max(v2) for k2, v2 in e["max"].items()}
            if all(v2 is not None for v2 in lv0.values()) and lv0:
                e["lv0"] = lv0
        else:
            e["kind"] = "pitcher"
            e["max"] = {k2: r[k2][1] for k2 in ("velocity","control","stamina") if r.get(k2)}
            e["defense"] = {k2: r[k2][1] for k2 in ("catch","throw","arm") if r.get(k2)}
            e["pitchRanks"] = r.get("pitchRanks")
        out[c["id"]] = e

    args.output.parent.mkdir(parents=True, exist_ok=True)
    json.dump(out, args.output.open("w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"카드유형교정 {corrected} · 시리즈키 {hit_family} · 수비키 {hit_def} · 연도키 {hit_year} · 유형키 {hit_kind} · 부분 {hit_part} · 미매칭 {miss}  -> {args.output} ({len(out)}건)")

if __name__ == "__main__":
    main()
