#!/usr/bin/env python3
"""Store full-size ANSS JSON as deterministic gzip assets for deployment."""
from __future__ import annotations

import gzip
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public" / "effects" / "anim"
TARGET = ROOT / "public" / "effects" / "anim-gz"


def main() -> None:
    TARGET.mkdir(exist_ok=True)
    count = 0
    for source in SOURCE.glob("*.json"):
        target = TARGET / f"{source.name}.gz"
        target.write_bytes(gzip.compress(source.read_bytes(), compresslevel=9, mtime=0))
        count += 1
    print(f"gzip animation documents: {count}")


if __name__ == "__main__":
    main()
