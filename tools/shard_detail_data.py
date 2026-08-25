#!/usr/bin/env python3
"""Split large detail-page datasets by the first two card-id digits."""
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
        (out / f"{key}.json").write_text(
            json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        )


dump_shards("cards.json", "card-shards", False)
dump_shards("ref-stats.json", "ref-shards", True)
