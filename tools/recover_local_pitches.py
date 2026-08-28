#!/usr/bin/env python3
"""rakda3에 없는 카드의 구종을 로컬 CARDMASTERDATA에서 안전하게 복구한다.

선수 ID와 검증된 내부 기준 연도(표시 연도-1)가 일치하고, 구종 배열 후보가
유일한 경우만 사용한다. 이름이나 배열 순서에 의한 추정 매칭은 허용하지 않는다.
"""
import argparse, csv, json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARROWS = ["←", "↙", "↓", "↘", "→", "●", "←", "↙", "↓", "↘", "→", "●"]
RATES = [1,.9744,.9744,.9214,.8765,.918,.942,.8285,.7885,.6843,.7885,.8814,
         .6243,.8485,.9014,.8641,.6543,.8714,.8655,.9257,.963,.9014,.7885,
         .8428,.8428,.9214,.9214,.7814,.7814,.9574,.9574,.8655,.7885,.9728,
         .99,.9744,1,1,1,1,.6,.87,.9014,.9257,.9744,.945,.901]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cards", type=Path, default=ROOT / "public/data/cards.json")
    ap.add_argument("--master", type=Path, default=Path("/Users/yi-rang/Documents/ChatGPT/프로스피/output/current/cards_with_images.csv"))
    ap.add_argument("--names", type=Path, default=ROOT / "tools/pitch_names_ko.json")
    ap.add_argument("--refresh", action="store_true", help="기존 local-card-master 복구분을 지우고 재계산")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    cards = json.loads(args.cards.read_text(encoding="utf-8"))
    names = json.loads(args.names.read_text(encoding="utf-8"))
    with args.master.open(encoding="utf-8-sig") as fh:
        masters = list(csv.DictReader(fh))
    by_key = {}
    by_player_year = {}
    for row in masters:
        key = (row["player_id"], int(row["u32_0x98"]), int(row["content_version"]))
        by_key.setdefault(key, []).append(row)
        by_player_year.setdefault((row["player_id"], int(row["u32_0x98"])), []).append(row)

    if args.refresh:
        for card in cards:
            pitches = (card.get("pitching") or {}).get("pitches") or []
            if pitches and all(p.get("source") == "local-card-master" for p in pitches):
                card["pitching"]["pitches"] = []

    recovered = []
    for card in cards:
        pitching = card.get("pitching") or {}
        if card.get("playerType") != "pitcher" or pitching.get("pitches"):
            continue
        version = card.get("masterSeason") or (card.get("defense") or {}).get("version")
        # 사이트 앵커 전 연도 대조: 표시 연도와 같은 내부 연도의 완전일치율은
        # 20~34%, 표시 연도-1은 56~87%다. CARDMASTER의 연도는 출시 그룹의
        # 기준 연도이므로 모든 카드에서 한 해를 뺀다.
        rows = by_player_year.get((str(card.get("playerId")), int(card["year"]) - 1), [])
        if not rows and int(card["year"]) == 2015 and version:
            # 2014 레코드가 없는 2015 데뷔/복귀 선수는 카드에 연결돼 있던
            # content version과 2015 내부 레코드가 유일하게 일치할 때만 사용한다.
            rows = by_key.get((str(card.get("playerId")), 2015, int(version)), [])
        rows = [row for row in rows if any(int(row[f"u32_0x{o:02x}"]) != 37 for o in range(0x08, 0x90, 0x0c))]
        signatures = {}
        for row in rows:
            signature = tuple((int(row[f"u32_0x{o:02x}"]), int(row[f"u32_0x{o + 4:02x}"]),
                               int(row[f"u32_0x{o + 8:02x}"])) for o in range(0x08, 0x90, 0x0c))
            signatures.setdefault(signature, row)
        if len(signatures) != 1:
            continue
        row = next(iter(signatures.values()))
        max_speed = int(pitching.get("maxSpeed") or 0)
        if max_speed <= 0:
            continue
        pitches = []
        for direction, offset in enumerate(range(0x08, 0x90, 0x0c)):
            kind = int(row[f"u32_0x{offset:02x}"])
            if kind == 37 or not 0 <= kind < len(RATES):
                continue
            pitches.append({
                "direction": direction, "arrow": ARROWS[direction], "kind": kind,
                "name": names[kind] if kind < len(names) else str(kind),
                "power": int(row[f"u32_0x{offset + 4:02x}"]),
                "level": int(row[f"u32_0x{offset + 8:02x}"]),
                "speed": int(max_speed * RATES[kind]), "source": "local-card-master",
            })
        if pitches:
            pitching["pitches"] = pitches
            card["pitching"] = pitching
            recovered.append({"cardId": card["id"], "name": card["name"],
                              "year": card["year"], "version": version, "pitches": len(pitches)})
    print(json.dumps({"recovered": len(recovered), "cards": recovered}, ensure_ascii=False, indent=2))
    if args.apply:
        args.cards.write_text(json.dumps(cards, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
