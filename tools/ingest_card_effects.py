#!/usr/bin/env python3
"""Extract app API `image -> effect_id` pairs and merge them into known-map.json."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def walk(value: Any):
    if isinstance(value, dict):
        image = value.get("image")
        effect = value.get("effect_id")
        if isinstance(image, (int, str)) and isinstance(effect, (int, str)):
            image_s, effect_s = str(image), str(effect)
            if image_s.isdigit() and effect_s.isdigit() and int(effect_s) > 0:
                yield image_s, effect_s, value.get("image_effect")
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def documents(path: Path):
    if path.is_dir():
        for child in sorted(path.rglob("*.json")):
            yield from documents(child)
        for child in sorted(path.rglob("*.jsonl")):
            yield from documents(child)
        return
    try:
        if path.suffix == ".jsonl":
            for line in path.read_text().splitlines():
                if line.strip():
                    yield json.loads(line)
        else:
            yield json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--known-map", type=Path,
                        default=Path("public/effects/known-map.json"))
    parser.add_argument("--report", type=Path,
                        default=Path("public/effects/card-effect-evidence.json"))
    args = parser.parse_args()

    found: dict[str, str] = {}
    evidence: dict[str, dict[str, Any]] = {}
    conflicts: list[dict[str, str]] = []
    for source in args.inputs:
        for doc in documents(source):
            for image, effect, image_effect in walk(doc):
                old = found.get(image)
                if old and old != effect:
                    conflicts.append({"image": image, "old": old, "new": effect})
                    continue
                found[image] = effect
                evidence[image] = {"effect_id": effect, "image_effect": image_effect,
                                   "source": str(source)}

    known_doc = json.loads(args.known_map.read_text())
    known = known_doc.setdefault("map", {})
    added = changed = 0
    for image, effect in sorted(found.items()):
        if image not in known:
            added += 1
        elif str(known[image]) != effect:
            changed += 1
        known[image] = effect
    args.known_map.write_text(json.dumps(known_doc, ensure_ascii=False, indent=1) + "\n")
    args.report.write_text(json.dumps({"pairs": evidence, "conflicts": conflicts},
                                      ensure_ascii=False, indent=1) + "\n")
    print(json.dumps({"found": len(found), "added": added, "changed": changed,
                      "conflicts": len(conflicts)}, ensure_ascii=False))
    return 1 if conflicts else 0


if __name__ == "__main__":
    raise SystemExit(main())
