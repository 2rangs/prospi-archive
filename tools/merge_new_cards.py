#!/usr/bin/env python3
"""기존 원장(cards.json)에 신규 카드만 가산 병합한다 (회귀 0).

배경
    커밋된 원장은 디스크에 보존되지 않은 생성기로 만들어졌고(position/
    positionName/masterSeason 을 ~10,470장에 찍은 스크립트가 tools 에 없다),
    rakda 병합·수작업 교정까지 누적돼 있어 처음부터 재생성하면 그 데이터가
    사라진다. 그래서 기존 레코드는 그대로 두고, 신규 id 만 새로 추출한 원장
    에서 가져와 덧붙인다.

입력
    --current : 기존 원장 (기본 public/data/cards.json)
    --fresh   : 최신 CHK 로 새로 생성한 전체 원장 (position/masterSeason 포함)
출력
    --current 를 제자리 갱신. 기존 레코드는 바이트 동일, 신규만 append.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--current", type=Path, default=ROOT / "public/data/cards.json")
    ap.add_argument("--fresh", type=Path, required=True)
    ap.add_argument("--apply", action="store_true", help="실제 파일에 쓴다")
    args = ap.parse_args()

    current = json.loads(args.current.read_text(encoding="utf-8"))
    fresh = json.loads(args.fresh.read_text(encoding="utf-8"))

    have = {c["id"] for c in current}
    fresh_by_id = {c["id"]: c for c in fresh}
    new_ids = [cid for cid in fresh_by_id if cid not in have]
    # 기존에 있는데 신선본에 없어진 id (삭제분) — 참고용으로만 보고, 지우지 않는다.
    dropped = [cid for cid in have if cid not in fresh_by_id]

    merged = list(current) + [fresh_by_id[cid] for cid in new_ids]

    print(f"기존 {len(current)} + 신규 {len(new_ids)} = {len(merged)}  "
          f"(신선본에서 사라진 기존 id {len(dropped)}건은 보존)")
    for cid in new_ids[:10]:
        c = fresh_by_id[cid]
        print(f"  + {cid} {c.get('year')} {c.get('name')} "
              f"pos={c.get('positionName')} ms={c.get('masterSeason')} [{c.get('playerType')}]")

    if args.apply:
        args.current.write_text(
            json.dumps(merged, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        print(f"기록함 -> {args.current}")
    else:
        print("(--apply 없음: 미리보기만)")


if __name__ == "__main__":
    main()
