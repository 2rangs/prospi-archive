#!/usr/bin/env python3
"""Split large detail-page datasets by the first two card-id digits."""
import gzip
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "data"


def dump_shards(source: str, folder: str, mapping: bool) -> None:
    raw = json.loads((DATA / source).read_text())
    shards = defaultdict(dict if mapping else list)
    if mapping:
        for card_id, value in raw.items():
            shards[str(card_id)[:2]][str(card_id)] = value
    else:
        for value in raw:
            shards[str(value["id"])[:2]].append(value)
    out = DATA / folder
    out.mkdir(parents=True, exist_ok=True)
    for key, value in shards.items():
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        (out / f"{key}.json").write_bytes(payload)
        # 상세 화면은 .json.gz 를 받는다(app/player/[id] fetchGzipJson).
        # json 만 갱신하고 gz 를 안 만들면 상세 샤드가 stale 로 남아 신규
        # 카드 상세가 안 열린다 — 반드시 함께 쓴다.
        (out / f"{key}.json.gz").write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))


dump_shards("cards.json", "card-shards", False)
dump_shards("ref-stats.json", "ref-shards", True)
