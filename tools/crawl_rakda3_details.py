#!/usr/bin/env python3
"""Archive every rakda3 player detail page discovered by scrape_ref.

Raw HTML is gzip-compressed so no table, pitch repertoire, training-level row,
or future field is lost. The job is resumable: an existing non-empty gzip is
never fetched again. A JSONL manifest records provenance and hashes.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import gzip
import hashlib
import json
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://prospi-a.rakda3.net"
UA = "prospi-archive-research (personal; data preservation)"
lock = threading.Lock()
last_request = 0.0


def fetch(pid: int, out: Path, delay: float) -> dict:
    global last_request
    target = out / "players" / f"{pid}.html.gz"
    if target.exists() and target.stat().st_size > 40:
        return {"id": pid, "status": "cached", "path": str(target)}
    with lock:
        wait = delay - (time.monotonic() - last_request)
        if wait > 0:
            time.sleep(wait)
        last_request = time.monotonic()
    url = f"{BASE}/player/{pid}"
    cp = subprocess.run(
        ["curl", "-fsSL", "--retry", "4", "--retry-all-errors",
         "--connect-timeout", "15", "--max-time", "45", "-A", UA, url],
        capture_output=True,
    )
    if cp.returncode or len(cp.stdout) < 200:
        return {"id": pid, "status": "error", "code": cp.returncode,
                "error": cp.stderr.decode("utf-8", "replace")[-500:]}
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(gzip.compress(cp.stdout, compresslevel=6))
    return {"id": pid, "status": "ok", "url": url, "path": str(target),
            "bytes": len(cp.stdout), "sha256": hashlib.sha256(cp.stdout).hexdigest(),
            "fetchedAt": datetime.now(timezone.utc).isoformat()}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cards", default="output/rakda3/cards.jsonl")
    ap.add_argument("--out", default="output/rakda3")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--delay", type=float, default=0.25,
                    help="global minimum seconds between request starts")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ids = set()
    with open(args.cards, encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            if row.get("ref_id") is not None:
                ids.add(int(row["ref_id"]))
    done = sum((out / "players" / f"{pid}.html.gz").exists() for pid in ids)
    print(f"details: {len(ids)} unique players, {done} cached", flush=True)
    manifest = out / "detail-manifest.jsonl"
    counts = {"ok": 0, "cached": 0, "error": 0}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = [ex.submit(fetch, pid, out, args.delay) for pid in sorted(ids)]
        with manifest.open("a", encoding="utf-8") as mf:
            for n, fut in enumerate(concurrent.futures.as_completed(futures), 1):
                result = fut.result()
                counts[result["status"]] = counts.get(result["status"], 0) + 1
                mf.write(json.dumps(result, ensure_ascii=False) + "\n")
                mf.flush()
                if n % 100 == 0:
                    print(f"  details {n}/{len(ids)} {counts}", flush=True)
    (out / "summary.json").write_text(json.dumps({
        "source": BASE, "uniquePlayers": len(ids), "results": counts,
        "completedAt": datetime.now(timezone.utc).isoformat(),
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("details complete", counts, flush=True)


if __name__ == "__main__":
    main()
