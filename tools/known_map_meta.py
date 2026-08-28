#!/usr/bin/env python3
"""known-map.json 에 실측 카드의 **종류 코드·리그** 메타를 굽는다.

매칭 키가 (group, variant) 만이면 SL1/SL2/SL3 처럼 variant 가 같고 이펙트가
다른 묶음을 가를 수 없다. 브라우저에서 실측표를 학습할 때 종류 코드를 알아야
하는데, 상세 화면은 ref-stats 전체(3.6MB)를 읽지 않으므로 실측 56건 분량만
여기에 미리 넣는다. known-map 에 항목을 추가하면 이 스크립트를 다시 돌린다.

    python3 tools/known_map_meta.py
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KM = ROOT / "public/effects/known-map.json"
REF = ROOT / "public/data/ref-stats.json"

# 12구단 리그. app/teams.ts 와 같은 값.
LEAGUE = {"巨": "central", "神": "central", "De": "central", "広": "central",
          "中": "central", "ヤ": "central",
          "ソ": "pacific", "日": "pacific", "ロ": "pacific", "楽": "pacific",
          "西": "pacific", "オ": "pacific"}


def kind(series: str | None) -> str | None:
    """"2026S1SP(SL3)" -> "SL3" · "2025S2覚(若手)" -> "覚" · 통상 -> "(기본)"."""
    if not series:
        return None
    m = re.search(r"(SP|覚)\(([^)]+)\)", series)
    if not m:
        return "(기본)"
    return "覚" if m.group(1) == "覚" else m.group(2)


def main() -> int:
    km = json.loads(KM.read_text(encoding="utf-8"))
    ref = json.loads(REF.read_text(encoding="utf-8"))
    meta: dict[str, dict[str, str]] = {}
    for cid in km.get("map", {}):
        if not re.fullmatch(r"\d{9,10}", cid):
            continue
        r = ref.get(cid) or {}
        e: dict[str, str] = {}
        k = kind(r.get("series"))
        if k:
            e["kind"] = k
        lg = LEAGUE.get(r.get("team") or "")
        if lg:
            e["league"] = lg
        if e:
            meta[cid] = e
    km["meta"] = dict(sorted(meta.items()))
    km["_meta_note"] = ("실측 카드의 종류 코드·리그. tools/known_map_meta.py 가 "
                        "ref-stats.json 에서 굽는다. 매칭 키를 (group, variant, 종류) 로 "
                        "넓히고 series 31/32 의 sub(13=Central·14=Pacific)를 고르는 데 쓴다.")
    KM.write_text(json.dumps(km, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    have_kind = sum(1 for v in meta.values() if "kind" in v)
    have_lg = sum(1 for v in meta.values() if "league" in v)
    print(f"실측 {len(km['map'])}건 · 메타 {len(meta)}건 (종류 {have_kind} · 리그 {have_lg})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
