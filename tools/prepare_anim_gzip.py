#!/usr/bin/env python3
"""Store full-size ANSS JSON as deterministic gzip assets for deployment."""
from __future__ import annotations

import gzip
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def main() -> None:
    for name in ("anim", "anim-s"):
        source_dir = ROOT / "public" / "effects" / name
        target_dir = ROOT / "public" / "effects" / f"{name}-gz"
        target_dir.mkdir(exist_ok=True)
        count = 0
        for source in source_dir.glob("*.json"):
            target = target_dir / f"{source.name}.gz"
            target.write_bytes(gzip.compress(source.read_bytes(), compresslevel=9, mtime=0))
            count += 1
        print(f"gzip {name} documents: {count}")


if __name__ == "__main__":
    main()
