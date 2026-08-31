#!/usr/bin/env python3
"""목록용 ref-stats.json.gz 에서 **상세 화면 전용 필드**를 뺀다.

[문제] 목록·이펙트 화면은 카드 10,247건의 표기값 전체(`ref-stats.json.gz`)를
  받는다. 그 안에서 `growth`(특훈 Lv0~10 표)가 원본 8.60MB 중 4.72MB(66%)를
  차지하는데, 이 값을 읽는 곳은 선수 상세 화면 한 곳뿐이고 거기서는 이미
  카드별 조각(`ref-shards/<앞2자리>.json.gz`)을 따로 받는다. 즉 목록은 쓰지도
  않는 4.7MB 를 매번 받아서 매번 파싱한다.
[측정] 앱 전체를 훑어 `growth` · `lv0` · `refAptitude` 를 읽는 코드가
  `growth` = 상세 화면 1곳(샤드로 받는다) · `lv0`/`refAptitude` = 0곳이다.
[처리] 세 필드를 목록용 파일에서만 뺀다. **샤드는 그대로 두므로** 상세 화면이
  보는 값은 하나도 줄지 않는다.

    python3 tools/shard_detail_data.py   # 먼저 (샤드는 완전판에서 만든다)
    python3 tools/slim_ref_stats.py

주의: `ref-stats.json`(완전판)은 건드리지 않는다. 이 스크립트는 gz 만 다시 쓴다.
"""
import gzip
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "data"
DROP = ("growth", "lv0", "refAptitude")


def main() -> int:
    src = DATA / "ref-stats.json"
    if not src.exists():
        print(f"없음: {src}", file=sys.stderr)
        return 1
    full = json.loads(src.read_text(encoding="utf-8"))
    slim = {k: {a: b for a, b in v.items() if a not in DROP} for k, v in full.items()}
    body = json.dumps(slim, ensure_ascii=False, separators=(",", ":")).encode()
    out = DATA / "ref-stats.json.gz"
    before = out.stat().st_size if out.exists() else 0
    out.write_bytes(gzip.compress(body, 9, mtime=0))
    kept = sum(len(v) for v in slim.values())
    dropped = sum(len(v) for v in full.values()) - kept
    print(f"항목 {len(slim)} · 필드 {kept}개 유지 / {dropped}개 제거 {DROP}")
    print(f"원본 {len(src.read_bytes())/1e6:.2f}MB → 목록용 {len(body)/1e6:.2f}MB")
    print(f"gz {before/1e6:.2f}MB → {out.stat().st_size/1e6:.2f}MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
