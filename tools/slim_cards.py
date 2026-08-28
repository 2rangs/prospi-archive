#!/usr/bin/env python3
"""목록용 cards.json.gz 에서 **상세 화면 전용 값**을 뺀다.

[문제] 목록·이펙트 화면은 카드 15,222장 전체(`cards.json.gz`)를 받는다. 그 안에서
  `pitching` 이 값 합계 8.84MB 중 4.89MB(55%)인데, 목록이 실제로 쓰는 것은
  `maxSpeed` · `stamina` · `pitches.length` · `pitches[].power` 네 가지뿐이다
  (app/page.tsx maxPitchPower·StatCells, app/search.ts statScore). 구종의
  방향·화살표·이름·구속·등급은 선수 상세에서만 쓰고, 거기서는 이미 카드별
  조각(`card-shards/<앞2자리>.json.gz`)을 따로 받는다.
[측정] 앱 전체 검색으로 목록이 안 읽는 필드: `md5`(스프라이트 화면의 md5 는
  다른 데이터셋이다) · `size` · `verified` · `defenseSource` · `aptitude`.
[처리] 위 필드를 빼고, 구종은 배열 길이와 `power` 만 남긴다. `.pitches.length`
  와 `maxPitchPower` 가 그대로 동작하므로 **화면 코드는 고치지 않는다.**
  **샤드는 완전판이므로** 상세 화면이 보는 값은 하나도 줄지 않는다.

    python3 tools/shard_detail_data.py   # 먼저 (샤드는 완전판에서 만든다)
    python3 tools/slim_cards.py

주의: `cards.json`(완전판)은 건드리지 않는다. 이 스크립트는 gz 만 다시 쓴다.
"""
import gzip
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "data"
DROP = ("md5", "size", "verified", "defenseSource", "aptitude")
# 목록이 구종에서 읽는 유일한 값. 나머지는 상세(샤드)에만 있으면 된다.
KEEP_PITCH = ("power",)


def slim_card(c: dict) -> dict:
    out = {k: v for k, v in c.items() if k not in DROP}
    p = out.get("pitching")
    if isinstance(p, dict) and isinstance(p.get("pitches"), list):
        out["pitching"] = {
            **{k: v for k, v in p.items() if k != "pitches"},
            "pitches": [{k: q.get(k) for k in KEEP_PITCH} for q in p["pitches"]],
        }
    return out


def main() -> int:
    src = DATA / "cards.json"
    if not src.exists():
        print(f"없음: {src}", file=sys.stderr)
        return 1
    full = json.loads(src.read_text(encoding="utf-8"))
    slim = [slim_card(c) for c in full]
    body = json.dumps(slim, ensure_ascii=False, separators=(",", ":")).encode()
    out = DATA / "cards.json.gz"
    before = out.stat().st_size if out.exists() else 0
    out.write_bytes(gzip.compress(body, 9))
    pitches = sum(len(c.get("pitching", {}).get("pitches", []) or [])
                  for c in slim if isinstance(c.get("pitching"), dict))
    print(f"카드 {len(slim)} · 제거 필드 {DROP} · 구종 {pitches}건을 {KEEP_PITCH} 만 남김")
    print(f"원본 {len(src.read_bytes())/1e6:.2f}MB → 목록용 {len(body)/1e6:.2f}MB")
    print(f"gz {before/1e6:.2f}MB → {out.stat().st_size/1e6:.2f}MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
