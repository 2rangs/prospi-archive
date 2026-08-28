#!/usr/bin/env python3
"""선수 데이터 무결성을 전수 검사하고 기계 판독 가능한 보고서를 만든다."""
import argparse, collections, json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NORM = lambda s: re.sub(r"[\s　・.．]", "", s or "")


def load_jsonl(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cards", type=Path, default=ROOT / "public/data/cards.json")
    ap.add_argument("--refs", type=Path, default=ROOT / "public/data/ref-stats.json")
    ap.add_argument("--source", type=Path, default=ROOT / "output/rakda3/cards.jsonl")
    ap.add_argument("--details", type=Path, default=ROOT / "output/rakda3/details.jsonl")
    ap.add_argument("--out", type=Path, default=ROOT / "output/integrity/player-data-audit.json")
    args = ap.parse_args()

    cards = json.loads(args.cards.read_text(encoding="utf-8"))
    refs = json.loads(args.refs.read_text(encoding="utf-8"))
    source = load_jsonl(args.source)
    details = {int(x["refId"]): x for x in load_jsonl(args.details)}
    source_ids = {int(x["ref_id"]) for x in source}
    by_name_year = collections.defaultdict(list)
    for row in source:
        m = re.match(r"(\d{4})", row.get("series") or "")
        if m:
            by_name_year[(NORM(row.get("name")), int(m.group(1)), row.get("kind"))].append(row)

    issues = []
    # 원본 부재가 입증된 구종 공백은 이슈가 아니라 "확인된 공백"으로 분리한다.
    # 증명은 tools/prove_pitch_absence.py 가 rakda3(NFKC+이체자)·로컬 마스터·
    # CDN 구 리비전·contents_personal 4개 출처를 재조회해 만든 것만 인정하고,
    # status 가 absence_proven 이 아니면(=어디선가 후보 발견) 도로 이슈로 센다.
    proof_path = ROOT / "output/integrity/pitch-absence-proof.json"
    absence_proven = {}
    if proof_path.exists():
        for rec in json.loads(proof_path.read_text()).get("cards", []):
            if rec.get("status") == "absence_proven":
                absence_proven[str(rec["id"])] = rec
    confirmed_gaps = []
    def issue(code, card=None, **extra):
        issues.append({"code": code, **({"cardId": card["id"], "name": card.get("name"), "year": card.get("year")} if card else {}), **extra})

    ids = [x["id"] for x in cards]
    for card_id, count in collections.Counter(ids).items():
        if count > 1: issue("duplicate_card_id", cardId=card_id, count=count)
    for card_id in refs:
        if card_id not in set(ids): issue("orphan_ref", cardId=card_id)

    coverage = collections.Counter()
    missing_reasons = collections.Counter()
    for card in cards:
        coverage[f"cards_{card.get('playerType')}"] += 1
        entry = refs.get(card["id"])
        if entry:
            coverage["ref_any"] += 1
        if entry and entry.get("refId"):
            coverage["ref_exact"] += 1
            rid = int(entry["refId"])
            if rid not in source_ids: issue("unknown_ref_id", card, refId=rid)
            if entry.get("kind") != card.get("playerType"): issue("kind_mismatch", card, refKind=entry.get("kind"))
        elif entry and entry.get("partial"):
            coverage["ref_partial"] += 1
        else:
            coverage["ref_missing"] += 1

        growth = (entry or {}).get("growth")
        if growth:
            coverage["growth"] += 1
            labels, rows = growth.get("labels", []), growth.get("rows", [])
            levels = [x.get("level") for x in rows]
            if levels != list(range(11)): issue("growth_levels", card, levels=levels)
            if not labels or any(len(x.get("values", [])) != len(labels) for x in rows): issue("growth_shape", card)
            for i, label in enumerate(labels):
                vals = [x["values"][i] for x in rows if len(x.get("values", [])) > i]
                if any(b < a for a, b in zip(vals, vals[1:])): issue("growth_decreases", card, label=label, values=vals)
            if rows and entry.get("max"):
                keymap = {"ミート":"meet", "パワー":"power", "走力":"speed", "球威":"velocity", "制球":"control", "スタミナ":"stamina"}
                row10 = rows[-1].get("values", [])
                for i, label in enumerate(labels):
                    key = keymap.get(label)
                    if key and key in entry["max"] and i < len(row10) and entry["max"][key] != row10[i]:
                        issue("growth_max_mismatch", card, label=label, growth=row10[i], maximum=entry["max"][key])

        if card.get("playerType") != "pitcher":
            continue
        pitches = (card.get("pitching") or {}).get("pitches") or []
        if pitches:
            coverage["pitch_present"] += 1
            sources = {p.get("source") or "local-original" for p in pitches}
            for source_name in sources:
                coverage[f"pitch_source_{source_name}"] += 1
        else:
            coverage["pitch_missing"] += 1
            candidates = by_name_year.get((NORM(card.get("name")), int(card.get("year") or 0), "pitcher"), [])
            if not candidates:
                reason = "no_same_year_source"
            else:
                signatures = {json.dumps(details.get(int(x["ref_id"]), {}).get("pitches"), ensure_ascii=False, sort_keys=True) for x in candidates if details.get(int(x["ref_id"]), {}).get("pitches")}
                reason = "ambiguous_source" if len(signatures) > 1 else "source_without_pitches"
            missing_reasons[reason] += 1
            if str(card["id"]) in absence_proven and reason == "no_same_year_source":
                coverage["pitch_gap_confirmed"] += 1
                confirmed_gaps.append({"cardId": card["id"], "name": card.get("name"),
                                       "year": card.get("year"), "reason": reason,
                                       "proof": "output/integrity/pitch-absence-proof.json"})
            else:
                issue("pitch_missing", card, reason=reason, candidates=[x["ref_id"] for x in candidates])
        directions = [p.get("direction") for p in pitches]
        if len(directions) != len(set(directions)): issue("pitch_duplicate_direction", card, directions=directions)
        for pitch in pitches:
            if not isinstance(pitch.get("direction"), int) or not 0 <= pitch["direction"] <= 11: issue("pitch_direction", card, pitch=pitch)
            if not isinstance(pitch.get("level"), int) or not 0 <= pitch["level"] <= 7: issue("pitch_level", card, pitch=pitch)
            if not isinstance(pitch.get("speed"), int) or pitch["speed"] <= 0: issue("pitch_speed", card, pitch=pitch)
            if pitch.get("kind") == -1: coverage["pitch_unknown_kind"] += 1

    report = {
        "counts": {"cards": len(cards), "sourceRows": len(source), "detailRows": len(details), "refRows": len(refs), **dict(coverage)},
        "missingPitchReasons": dict(missing_reasons),
        "issueCounts": dict(collections.Counter(x["code"] for x in issues)),
        "issues": issues,
        "confirmedGaps": confirmed_gaps,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k:v for k,v in report.items() if k != "issues"}, ensure_ascii=False, indent=2))
    print("report", args.out)


if __name__ == "__main__":
    main()
