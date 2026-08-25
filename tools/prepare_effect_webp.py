#!/usr/bin/env python3
"""Convert only animation-referenced effect sprites to lossless WebP."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def collect_files(value, out: set[str]) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "file" and isinstance(child, str):
                out.add(child)
            else:
                collect_files(child, out)
    elif isinstance(value, list):
        for child in value:
            collect_files(child, out)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=max(2, min(10, os.cpu_count() or 4)))
    args = parser.parse_args()
    cwebp = shutil.which("cwebp")
    if not cwebp:
        raise SystemExit("cwebp is required (brew install webp)")
    effects = ROOT / "public" / "effects"
    source = effects / "sprites"
    target = effects / "sprites-webp"
    target.mkdir(exist_ok=True)
    names: set[str] = set()
    for folder in (effects / "anim", effects / "anim-s"):
        for doc in folder.glob("*.json"):
            collect_files(json.loads(doc.read_text()), names)

    def convert(name: str) -> None:
        src, dst = source / f"{name}.png", target / f"{name}.webp"
        if not src.exists():
            raise FileNotFoundError(src)
        if dst.exists() and dst.stat().st_mtime_ns >= src.stat().st_mtime_ns:
            return
        subprocess.run([cwebp, "-quiet", "-lossless", "-z", "6", str(src), "-o", str(dst)], check=True)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(convert, sorted(names)))
    missing = [name for name in names if not (target / f"{name}.webp").exists()]
    if missing:
        raise SystemExit(f"missing conversions: {len(missing)}")
    print(f"lossless WebP sprites: {len(names)}")


if __name__ == "__main__":
    main()
