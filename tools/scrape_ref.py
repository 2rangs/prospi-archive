#!/usr/bin/env python3
"""prospi-a.rakda3.net 목록 페이지를 긁어 카드별 표기값을 모은다.

사용자 승인 하에 (팬사이트, 개인 아카이브 목적) 0.4초 간격으로 요청한다.
출력: scratchpad/ref-cards.jsonl (한 줄 = 카드 하나)
"""
import argparse, json, re, subprocess, sys, time, html as H
from pathlib import Path

BASE = "https://prospi-a.rakda3.net"
UA = {"User-Agent": "prospi-archive-research (personal)"}
OUT = "output/rakda3/cards.jsonl"
DELAY = 0.4

TD = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
ROW = re.compile(r"<tr>\s*<td class='mleft fixcol col0'>(.*?)</tr>", re.S)
RANKVAL = re.compile(r"rank([A-GS])'>[A-GS]</span><br>(\d+)")
TAG = re.compile(r"<[^>]+>")

def fetch(url):
    # macOS framework Python in this workspace has no usable CA bundle, while
    # the system curl validates this site's certificate correctly.
    return subprocess.run(
        ["curl", "-fsSL", "--retry", "4", "--retry-all-errors",
         "--connect-timeout", "15", "--max-time", "45",
         "-A", UA["User-Agent"], url],
        check=True, capture_output=True,
    ).stdout.decode("utf-8", "replace")

def text(td):
    return H.unescape(TAG.sub("", td)).strip()

def rankval(td):
    m = RANKVAL.search(td)
    return [m.group(1), int(m.group(2))] if m else None

def parse_rows(page_html, kind):
    out = []
    # 각 데이터 행: 첫 td 가 fixcol col0
    for chunk in re.findall(r"<tr>\s*<td class='mleft fixcol col0'.*?</tr>", page_html, re.S):
        tds = TD.findall("<td" + chunk.split("<td", 1)[1])
        if len(tds) < 12:
            continue
        m = re.search(r"href='/player/(\d+)' title='([^']*)'", tds[0])
        if not m:
            continue
        pid, full = m.group(1), H.unescape(m.group(2))
        date = re.search(r"title='(\d{4}-\d{2}-\d{2})'", chunk)
        series = text(tds[3])
        row = dict(ref_id=int(pid), name=full, team=text(tds[1]), pos=text(tds[2]),
                   series=series, date=date.group(1) if date else None, kind=kind)
        if kind == "batter":
            # 4..9: meet,power,speed,catch,throw,arm | 10 spi | 11 hand | 12 cost | 13 dando | 14 abilities | 15..22 apt
            keys = ["meet","power","speed","catch","throw","arm"]
            for i,k in enumerate(keys): row[k] = rankval(tds[4+i])
            row["spirits"] = int(text(tds[10]) or 0)
            row["hand"] = text(tds[11]); row["cost"] = int(text(tds[12]) or 0)
            row["trajectory"] = text(tds[13])
            row["abilities"] = [t for t in (text(x) for x in re.findall(r"<a[^>]*>(.*?)</a>", tds[14])) if t] or [t for t in text(tds[14]).split() if t]
            APT = ["catcher","first","second","third","short","left","center","right"]
            row["aptitude"] = {p: rankval(tds[15+i]) for i,p in enumerate(APT) if 15+i < len(tds) and rankval(tds[15+i])}
        else:
            keys = ["velocity","control","stamina","catch","throw","arm"]
            for i,k in enumerate(keys): row[k] = rankval(tds[4+i])
            row["spirits"] = int(text(tds[10]) or 0)
            row["hand"] = text(tds[11]); row["cost"] = int(text(tds[12]) or 0)
            row["pitchRanks"] = text(tds[13])
            row["abilities"] = [t for t in (text(x) for x in re.findall(r"<a[^>]*>(.*?)</a>", tds[14])) if t]
            APT = ["starter","middle","closer"]
            apt = {}
            for i,pn in enumerate(APT):
                if 15+i >= len(tds): break
                v = rankval(tds[15+i]) or (text(tds[15+i]) or None)
                if v: apt[pn] = v
            row["aptitude"] = apt
        out.append(row)
    return out

def total_pages(page_html):
    pages = [int(p) for p in re.findall(r"page='(\d+)'", page_html)]
    return (max(pages) + 1) if pages else 1

def crawl(kind):
    url0 = f"{BASE}/{kind}-list"
    h = fetch(url0)
    n = total_pages(h)
    rows = parse_rows(h, kind)
    print(f"{kind}: {n} 페이지", flush=True)
    with open(OUT, "a", encoding="utf-8") as f:
        for r in rows: f.write(json.dumps(r, ensure_ascii=False) + "\n")
        for p in range(1, n):
            time.sleep(DELAY)
            try:
                h = fetch(f"{url0}?page={p}")
            except Exception as e:
                print(f"  p{p} 실패 {e} — 5초 후 재시도", flush=True)
                time.sleep(5)
                h = fetch(f"{url0}?page={p}")
            rs = parse_rows(h, kind)
            for r in rs: f.write(json.dumps(r, ensure_ascii=False) + "\n")
            if p % 20 == 0: print(f"  {kind} p{p}/{n} 누적행 기록중", flush=True)
    print(f"{kind} 완료", flush=True)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()
    OUT = args.out
    Path(OUT).parent.mkdir(parents=True, exist_ok=True)
    open(OUT, "w").close()
    crawl("batter")
    crawl("pitcher")
    print("전체 완료:", OUT)
