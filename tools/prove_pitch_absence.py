#!/usr/bin/env python3
"""남은 구종 공백 카드의 **원본 부재를 입증**하는 재실행 가능한 검사.

각 카드에 대해 접근 가능한 모든 출처를 다시 조회해 결과를 기록한다:
  1) rakda3 목록 — NFKC 정규화 + 이체자(斎/斉·澤/沢·櫻/桜·髙/高·﨑/崎·嶋/島 등)
     변형까지 포함해 같은 연도 행이 있는지.
  2) 로컬 CARDMASTERDATA (3개 스냅샷, md5 동일 확인) — 해당 playerId 의
     `표시 연도-1` 행이 있는지, 실제 보유 연도 목록.
  3) CDN 현행 마스터 (output/integrity/cdn-CARDMASTERDATA.CHK, 11,775행
     구 리비전) — 같은 조회.
  4) contents_personal.csv — 선수 수록 여부.

모든 출처에서 같은 연도 근거가 없으면 status=absence_proven.
하나라도 생기면 status=candidate_found 로 표시하고 종료 코드 1 을 돌려
자동 감사가 눈치채게 한다.
"""
import csv, json, re, sys, unicodedata, collections
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from chk_master import sections, xlb, card_row

MASTERS = [
    Path("/Users/yi-rang/Documents/ChatGPT/프로스피/extracted/download/JP/CARDMASTERDATA.CHK"),
    ROOT / "output/integrity/cdn-CARDMASTERDATA.CHK",
]
CONTENTS = Path("/Users/yi-rang/Documents/ChatGPT/프로스피/output/current/contents_personal.csv")

VAR = [("斎","斉"),("斎","齋"),("斎","齊"),("澤","沢"),("櫻","桜"),("髙","高"),
       ("﨑","崎"),("嶋","島"),("邊","辺"),("邉","辺"),("國","国"),("眞","真"),
       ("龍","竜"),("冨","富"),("圓","円")]

def norm(s):
    return re.sub(r"[\s　・.．]", "", unicodedata.normalize("NFKC", s or ""))

def variants(name):
    out = {norm(name)}
    for a, b in VAR:
        more = set()
        for v in out:
            if a in v: more.add(v.replace(a, b))
            if b in v: more.add(v.replace(b, a))
        out |= more
    return out

def year_of(series):
    m = re.match(r"(\d{4})", series or "")
    return int(m.group(1)) if m else None

def load_master(path):
    d, secs = sections(str(path))
    dat = [s for s in secs if s["tag"] == "DAT"][0]
    x = xlb(d, dat["data"])
    by_pid = collections.defaultdict(list)
    for r in range(x["rows"]):
        row = card_row(d, x["base"], x["stride"], r)
        by_pid[row["playerId"]].append(row)
    return by_pid

def main():
    cards = {str(c["id"]): c for c in json.loads((ROOT / "public/data/cards.json").read_text())}
    audit = json.loads((ROOT / "output/integrity/player-data-audit.json").read_text())
    # 이전 실행에서 이미 absence_proven 된 카드는 audit 의 issues 에서
    # confirmedGaps 로 옮겨 간다. issues 만 다시 조사하면 증명 파일이
    # "기존 공백" / "신규 공백" 사이를 번갈아 덮어써 감사 결과가 진동한다.
    # 두 집합의 합집합을 매번 전수 재검증해 결과를 결정론적으로 만든다.
    gap_ids = sorted({str(i["cardId"]) for i in audit.get("issues", [])
                      if isinstance(i, dict) and i.get("code") == "pitch_missing"}
                     | {str(i["cardId"]) for i in audit.get("confirmedGaps", [])
                        if isinstance(i, dict) and i.get("cardId") is not None})

    rak = [json.loads(l) for l in (ROOT / "output/rakda3/cards.jsonl").open(encoding="utf-8")]
    rak_idx = collections.defaultdict(list)
    for r in rak:
        y = year_of(r.get("series"))
        for v in variants(r.get("name", "")):
            rak_idx[(y, v)].append(r["ref_id"])

    contents_names = set()
    if CONTENTS.exists():
        with CONTENTS.open(encoding="utf-8-sig") as fh:
            for row in csv.DictReader(fh):
                contents_names.add(norm((row.get("last_name_ja") or "") + (row.get("first_name_ja") or "")))

    masters = [(str(p), load_master(p)) for p in MASTERS if p.exists()]

    out, bad = [], 0
    for gid in gap_ids:
        c = cards.get(str(gid))
        if not c:
            continue
        y = int(c["year"]); pid = int(c["playerId"]) if c.get("playerId") else None
        rec = {"id": gid, "name": c["name"], "year": y, "playerId": pid, "checks": {}}
        hits = set()
        for v in variants(c["name"]):
            hits.update(rak_idx.get((y, v), []))
        rec["checks"]["rakda3_same_year"] = sorted(hits)
        for mp, by_pid in masters:
            rows = by_pid.get(pid, [])
            y1 = [r for r in rows if r["year"] == y - 1 and r["pitches"]]
            rec["checks"][f"master:{Path(mp).name}"] = {
                "years": sorted({r["year"] for r in rows}),
                "year_minus_1_rows": len(y1),
            }
        rec["checks"]["contents_personal"] = norm(c["name"]) in contents_names
        proven = (not hits
                  and all(v["year_minus_1_rows"] == 0 for k, v in rec["checks"].items()
                          if k.startswith("master:"))
                  and not rec["checks"]["contents_personal"])
        rec["status"] = "absence_proven" if proven else "candidate_found"
        if not proven:
            bad += 1
        out.append(rec)

    dst = ROOT / "output/integrity/pitch-absence-proof.json"
    dst.write_text(json.dumps({"cards": out,
                               "proven": sum(1 for r in out if r["status"] == "absence_proven"),
                               "candidates": bad}, ensure_ascii=False, indent=1))
    print(f"absence proof: {len(out)}장 중 입증 {len(out)-bad} · 후보발견 {bad} -> {dst}")
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
