#!/usr/bin/env python3
"""prospi-a.rakda3.net 선수 상세에서 **구종 표**를 긁는다.

사용자 승인 하에(팬사이트·개인 아카이브 목적) 기본 0.4초 간격으로 요청한다.
이어받기: 출력 jsonl 에 이미 있는 refId 는 건너뛴다.

한 줄 = 선수(refId) 하나:
  {"refId": 8864, "pitches": [
     {"arrow": "●", "name": "ストレート", "rank": "B", "level": 0, "speed": 156}, ...]}

[페이지 구조] <th>球種</th> 아래로 행마다 td 3개:
  1) 화살표 + 구종명   2) <span class=status-rank rankX> + <span class=kyusyu-val kyusyu_N>■×N
  3) "156km/h"
kyusyu_N 의 N 과 ■ 개수가 항상 같다(=변화량).
"""
import argparse, html, json, re, subprocess, sys, time
from pathlib import Path

BASE = "https://prospi-a.rakda3.net"
UA = "prospi-archive-research (personal)"
TAG = re.compile(r"<[^>]+>")
ROW = re.compile(
    r"<td class='w1 kyusyu'>(.*?)</td>\s*<td class='w1 kyusyu'>(.*?)</td>\s*<td class='w1'>(.*?)</td>",
    re.S)
RANK = re.compile(r"rank([A-GS])")
LEVEL = re.compile(r"kyusyu_(\d+)'>(■*)")
SPEED = re.compile(r"(\d+)\s*km/h")


def fetch(url: str) -> str:
    # 이 작업 공간의 framework Python 은 CA 번들이 없어 시스템 curl 을 쓴다.
    return subprocess.run(
        ["curl", "-fsSL", "--retry", "3", "--retry-all-errors",
         "--connect-timeout", "15", "--max-time", "45", "-A", UA, url],
        check=True, capture_output=True).stdout.decode("utf-8", "replace")


def parse(page: str) -> list[dict]:
    if "球種" not in page:
        return []
    out = []
    for a, b, c in ROW.findall(page.split("球種", 1)[1]):
        label = html.unescape(TAG.sub("", a)).strip()
        if not label:
            continue
        arrow, _, name = label.partition(" ")
        rank = RANK.search(b)
        lvl = LEVEL.search(b)
        speed = SPEED.search(html.unescape(TAG.sub("", c)))
        out.append({
            "arrow": arrow,
            "name": name.strip(),
            "rank": rank.group(1) if rank else None,
            # N 과 ■ 개수가 어긋나면 데이터가 예상과 다른 것이므로 둘 다 남긴다.
            "level": int(lvl.group(1)) if lvl else None,
            "bars": len(lvl.group(2)) if lvl else None,
            "speed": int(speed.group(1)) if speed else None,
        })
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", required=True, help="refId 목록 파일 (한 줄에 하나)")
    ap.add_argument("--out", default="output/rakda3/pitches.jsonl")
    ap.add_argument("--delay", type=float, default=0.4)
    args = ap.parse_args()

    out = Path(args.out); out.parent.mkdir(parents=True, exist_ok=True)
    done = set()
    if out.exists():
        for line in out.open(encoding="utf-8"):
            try: done.add(int(json.loads(line)["refId"]))
            except Exception: pass
    ids = [int(x) for x in Path(args.ids).read_text().split() if x.strip()]
    todo = [i for i in ids if i not in done]
    print(f"대상 {len(ids)} · 이미 받음 {len(done)} · 남은 {len(todo)}", flush=True)

    with out.open("a", encoding="utf-8") as fh:
        for n, rid in enumerate(todo, 1):
            try:
                rows = parse(fetch(f"{BASE}/player/{rid}"))
            except subprocess.CalledProcessError as exc:
                print(f"  실패 {rid}: {exc.returncode}", flush=True); rows = None
            if rows is not None:
                fh.write(json.dumps({"refId": rid, "pitches": rows}, ensure_ascii=False) + "\n")
                fh.flush()
            if n % 100 == 0:
                print(f"  {n}/{len(todo)}", flush=True)
            time.sleep(args.delay)
    print("완료", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
