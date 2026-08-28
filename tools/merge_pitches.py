#!/usr/bin/env python3
"""레퍼런스에서 긁은 구종을 카드 데이터에 병합한다.

[왜 필요한가] 카드 마스터(cards_with_images.csv)에는 **그 연도(group)의 리비전이
없는 선수가 많다** — CS 카드 이미지 13,951장 중 2,407장(17.3%). 그래서 구종이
빈 투수 카드가 748장 남았고 그중 734장(98%)이 이 경우다. 원본 바이너리의
contents_personal 은 리비전을 다 갖고 있지만 가변길이 레코드라 해독이 안 끝났다.

[매핑 규칙]
  이름  : 전각/반각을 정규화한 뒤 바이너리에서 뽑은 47종 표(app/pitchNames.ts)와 대조.
          표에 없으면 APK 22.4.0 이후 추가된 구종이므로 kind=-1 로 두고 이름만 남긴다.
  방향  : 화살표 → 0 ← · 1 ↙ · 2 ↓ · 3 ➘(↘) · 4 → · 5 ●
          같은 화살표가 두 번 나오면 두 번째는 제2구종(+6).
  변화량: kyusyu_N 의 N (■ 개수와 항상 같은지 검증한다).
  구속  : km/h 그대로.
"""
import argparse, collections, json, re, sys, unicodedata
from pathlib import Path

ARROW = {"←": 0, "↙": 1, "↓": 2, "↘": 3, "➘": 3, "→": 4, "●": 5}


def load_kind_table(path: Path) -> dict[str, int]:
    src = path.read_text(encoding="utf-8")
    body = src.split("PITCH_NAME_JA: string[] = [", 1)[1].split("];", 1)[0]
    names = re.findall(r'"([^"]*)"', body)
    table: dict[str, int] = {}
    for i, name in enumerate(names):
        if not name:
            continue                      # 37 번은 원본도 빈칸이다
        table[unicodedata.normalize("NFKC", name)] = i
    return table


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scraped", default="output/rakda3/pitches.jsonl")
    ap.add_argument("--cards", default="public/data/cards.json")
    ap.add_argument("--ref", default="public/data/ref-stats.json")
    ap.add_argument("--ref-cards", default="output/rakda3/cards.jsonl")
    ap.add_argument("--names", default="app/pitchNames.ts")
    ap.add_argument("--korean", default="tools/pitch_names_ko.json")
    ap.add_argument("--repairs", default="tools/pitch_source_repairs.json")
    ap.add_argument("--replace", action="store_true",
                    help="원본 상세표로 기존 구종도 교체(누락된 제2구종 보정)")
    ap.add_argument("--apply", action="store_true", help="쓰지 않으면 통계만 낸다")
    args = ap.parse_args()

    kind_of = load_kind_table(Path(args.names))
    ko = json.loads(Path(args.korean).read_text(encoding="utf-8")) if Path(args.korean).exists() else []
    repairs = json.loads(Path(args.repairs).read_text(encoding="utf-8")) if Path(args.repairs).exists() else {}

    scraped: dict[int, list[dict]] = {}
    for line in Path(args.scraped).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("pitches"):
            scraped[int(row["refId"])] = row["pitches"]

    cards = json.loads(Path(args.cards).read_text(encoding="utf-8"))
    ref = json.loads(Path(args.ref).read_text(encoding="utf-8"))
    ref_cards = [json.loads(line) for line in Path(args.ref_cards).read_text(encoding="utf-8").splitlines() if line.strip()]
    norm = lambda value: re.sub(r"[\s　・.．]", "", value or "")
    by_player_year: dict[tuple[str, int], list[dict]] = collections.defaultdict(list)
    for row in ref_cards:
        match = re.match(r"(\d{4})", row.get("series") or "")
        if row.get("kind") == "pitcher" and match:
            by_player_year[(norm(row.get("name")), int(match.group(1)))].append(row)

    stat = {"filled": 0, "replaced": 0, "no_ref": 0, "no_scrape": 0,
            "bar_mismatch": 0, "unknown_kind": 0, "already": 0}
    unknown: set[str] = set()

    for card in cards:
        if card.get("playerType") != "pitcher":
            continue
        old_pitches = ((card.get("pitching") or {}).get("pitches")) or []
        if old_pitches and not args.replace:
            stat["already"] += 1
            continue
        ref_entry = ref.get(card["id"]) or {}
        rid = ref_entry.get("refId")
        fallback_row = None
        if not rid:
            # 같은 선수·연도 후보가 여러 장이어도 모든 상세 페이지의 구종표가
            # 완전히 같다면 카드 판별 없이도 안전하게 공통 구종을 사용할 수 있다.
            candidates = by_player_year.get((norm(card.get("name")), int(card.get("year") or 0)), [])
            signatures: dict[str, list[dict]] = collections.defaultdict(list)
            for candidate in candidates:
                candidate_pitches = scraped.get(int(candidate["ref_id"]))
                if candidate_pitches:
                    # 구속 셀 한 칸만 깨진 중복 상세 페이지가 있다(2015 大谷의
                    # スローカーブ 106/109). 구종 구조가 전부 같으면 전체 JSON의
                    # 다수형을 선택해 단일 사이트 오타를 배제한다.
                    structure = [{k: p.get(k) for k in ("arrow", "name", "rank", "level", "bars")}
                                 for p in candidate_pitches]
                    signatures[json.dumps(structure, ensure_ascii=False, sort_keys=True)].append(candidate)
            if len(signatures) == 1:
                structurally_same = next(iter(signatures.values()))
                full = collections.Counter(json.dumps(scraped[int(x["ref_id"])], ensure_ascii=False, sort_keys=True)
                                           for x in structurally_same)
                winning = full.most_common(1)[0][0]
                fallback_row = next(x for x in structurally_same
                                    if json.dumps(scraped[int(x["ref_id"])], ensure_ascii=False, sort_keys=True) == winning)
                rid = fallback_row["ref_id"]
            else:
                stat["no_ref"] += 1
                continue
        rows = scraped.get(int(rid))
        if not rows:
            stat["no_scrape"] += 1
            continue

        # [중요] 레퍼런스는 **게임 화면 그대로**라 좌완이면 방향이 이미 반전돼
        # 있다. 실측: 우완 슬라이더(kind 4) 방향 0 이 176장인데 좌완은 방향 4 가
        # 28장, 커브(8)는 1 <-> 3, 슈트(33)는 4 <-> 0 으로 정확히 뒤집힌다.
        # 우리 저장 형식은 **우완 기준 정본**이고 화면에서 좌완만 뒤집으므로,
        # 여기서 되돌려 놓지 않으면 이중 반전된다.
        lefty = (fallback_row or ref_entry).get("hand") == "左"
        unmirror = {0: 4, 1: 3, 2: 2, 3: 1, 4: 0, 5: 5}
        seen: dict[int, int] = {}
        out = []
        for row in rows:
            base = ARROW.get(row["arrow"])
            if base is None:
                continue
            if lefty:
                base = unmirror[base]
            n = seen.get(base, 0)
            seen[base] = n + 1
            direction = base + 6 * n
            if direction > 11:
                continue
            name = unicodedata.normalize("NFKC", row["name"])
            kind = kind_of.get(name, -1)
            if kind < 0:
                unknown.add(row["name"]); stat["unknown_kind"] += 1
            if row.get("bars") is not None and row.get("level") != row.get("bars"):
                stat["bar_mismatch"] += 1
            old = next((p for p in old_pitches
                        if p.get("direction") == direction and
                        (p.get("kind") == kind or
                         unicodedata.normalize("NFKC", p.get("nameJa") or p.get("name", "")) == name)), None)
            repair = repairs.get(str(rid), {}).get("directions", {}).get(str(direction), {})
            out.append({
                "direction": direction,
                "arrow": ["←", "↙", "↓", "↘", "→", "●"][base],
                "kind": kind,
                "name": (ko[kind] if 0 <= kind < len(ko) else row["name"]),
                "nameJa": row["name"],
                "power": old.get("power") if old else None,
                "rank": row.get("rank"),
                "level": row.get("level") or 0,
                "speed": repair.get("speed") or row.get("speed") or (old.get("speed") if old else 0),
                "source": "rakda3",
            })
        if not out:
            continue
        pitching = card.get("pitching") or {"maxSpeed": 0, "stamina": 0}
        pitching["pitches"] = sorted(out, key=lambda p: p["direction"])
        card["pitching"] = pitching
        if old_pitches:
            stat["replaced"] += 1
        else:
            stat["filled"] += 1

    print(json.dumps(stat, ensure_ascii=False))
    if unknown:
        print("표에 없는 구종명:", sorted(unknown))
    if args.apply:
        Path(args.cards).write_text(
            json.dumps(cards, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print("cards.json 갱신")
    return 0


if __name__ == "__main__":
    sys.exit(main())
