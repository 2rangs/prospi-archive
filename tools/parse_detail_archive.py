#!/usr/bin/env python3
"""Parse every locally archived rakda3 player page.

Produces one JSONL row per refId containing the complete pitch repertoire and
the literal training-level table.  This is intentionally parsed from the saved
HTML rather than reconstructed from MAX values.
"""
from __future__ import annotations

import argparse
import gzip
import html
import json
import re
from pathlib import Path

from scrape_pitches import parse as parse_pitches

TAG = re.compile(r"<[^>]+>")
TR = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
CELL = re.compile(r"<t[hd][^>]*>(.*?)</t[hd]>", re.S)
TABLE = re.compile(r"<table[^>]*>(.*?)</table>", re.S)


def text(value: str) -> str:
    return html.unescape(TAG.sub("", value)).strip()


def parse_growth(page: str) -> dict | None:
    table = next((t for t in TABLE.findall(page) if "特訓Lv別ステータス" in t), None)
    if table is None:
        return None
    rows = [[text(c) for c in CELL.findall(row)] for row in TR.findall(table)]
    rows = [row for row in rows if row]
    header_at = next((i for i, row in enumerate(rows) if row and row[0] == "特訓Lv"), -1)
    if header_at < 0 or len(rows[header_at]) < 4:
        return None
    labels = rows[header_at][1:4]
    values = []
    for row in rows[header_at + 1:]:
        level_match = re.match(r"\d+", row[0]) if row else None
        if len(row) < 4 or not level_match:
            continue
        nums = []
        for value in row[1:4]:
            match = re.match(r"\d+", value)
            if match:
                nums.append(int(match.group()))
        if len(nums) == 3:
            # 마지막 행은 `10(MAX)`이므로 isdigit()으로 검사하면 전 카드에서
            # MAX 단계가 조용히 누락된다.
            values.append({"level": int(level_match.group()), "values": nums})
    if not values:
        return None
    return {"labels": labels, "rows": values}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", default="output/rakda3/players")
    ap.add_argument("--out", default="output/rakda3/details.jsonl")
    args = ap.parse_args()
    archive, out = Path(args.archive), Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    count = pitches = growth = errors = 0
    with out.open("w", encoding="utf-8") as fh:
        for path in sorted(archive.glob("*.html.gz"), key=lambda p: int(p.name.split(".")[0])):
            try:
                page = gzip.decompress(path.read_bytes()).decode("utf-8", "replace")
                row = {"refId": int(path.name.split(".")[0])}
                ps = parse_pitches(page)
                gr = parse_growth(page)
                if ps:
                    row["pitches"] = ps
                    pitches += 1
                if gr:
                    row["growth"] = gr
                    growth += 1
                fh.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
                count += 1
            except Exception as exc:
                errors += 1
                print(f"parse error {path}: {exc}")
    print(json.dumps({"pages": count, "withPitches": pitches, "withGrowth": growth,
                      "errors": errors}, ensure_ascii=False))


if __name__ == "__main__":
    main()
