#!/usr/bin/env python3
"""Convert ANSS UV sheets referenced by full animations to lossless WebP."""
from __future__ import annotations

import gzip
import json
import os
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def collect(value, names: set[str]) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "sheet" and isinstance(child, str):
                names.add(child)
            else:
                collect(child, names)
    elif isinstance(value, list):
        for child in value:
            collect(child, names)


def main() -> None:
    cwebp = shutil.which("cwebp")
    if not cwebp:
        raise SystemExit("cwebp is required (brew install webp)")
    effects = ROOT / "public" / "effects"
    source = ROOT / "output" / "deploy-excluded" / "sheets"
    target = effects / "sheets-webp"
    target.mkdir(exist_ok=True)
    names: set[str] = set()
    for doc in (effects / "anim-gz").glob("*.json.gz"):
        collect(json.loads(gzip.decompress(doc.read_bytes())), names)

    def convert(name: str) -> None:
        src, dst = source / f"{name}.png", target / f"{name}.webp"
        if not src.exists():
            raise FileNotFoundError(src)
        subprocess.run([cwebp, "-quiet", "-lossless", "-z", "6", str(src), "-o", str(dst)], check=True)

    with ThreadPoolExecutor(max_workers=max(2, min(10, os.cpu_count() or 4))) as pool:
        list(pool.map(convert, sorted(names)))
    print(f"lossless WebP UV sheets: {len(names)}")


if __name__ == "__main__":
    main()
