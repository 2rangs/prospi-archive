#!/usr/bin/env python3
"""Card-level rules that cannot be inferred from player-level aptitude alone."""
from __future__ import annotations

import json
from pathlib import Path


OHTANI_PLAYER_ID = "3945"
NEO_PLAYER_ID = "5117"


def variant_family(card: dict) -> int | None:
    """Return the two-digit modern visual family (27xx, 28xx, ...)."""
    variant = str(card.get("variant", "")).zfill(4)
    if int(card.get("year", 0)) <= 2015:
        return None
    try:
        return int(variant[:2])
    except ValueError:
        return None


def forced_card_type(card: dict) -> str | None:
    """Resolve known two-way cards from the card image family, not the player."""
    player_id = str(card.get("playerId", ""))
    if player_id == NEO_PLAYER_ID:
        # 根尾 昂: 2019~2021 카드 마스터는 전 구종 슬롯이 비고 탄도/야수
        # 포지션이 있으며 rakda3도 batter 카드만 존재한다. 2023 이후 카드
        # 마스터에는 실제 구종 슬롯이 있어 투수 전향 이후 카드다.
        return "batter" if int(card.get("year", 0)) <= 2021 else "pitcher"
    if player_id != OHTANI_PLAYER_ID:
        return None

    # The three unique 2015 art variants (23/24/25) were inspected directly;
    # every one is a pitching pose. Duplicate image ids are the same art.
    if int(card.get("year", 0)) == 2015:
        return "pitcher"

    family = variant_family(card)
    if family is None:
        return None

    # Ohtani's paired visual families are consistent across 2016-2025:
    # odd = pitcher art, the following even number = batter art.
    return "pitcher" if family % 2 else "batter"


def apply_card_rules(cards: list[dict]) -> int:
    changed = 0
    for card in cards:
        forced = forced_card_type(card)
        if not forced:
            continue
        before = json.dumps(card, ensure_ascii=False, sort_keys=True)
        card["playerType"] = forced
        card["cardTypeSource"] = ("career-era" if str(card.get("playerId", "")) == NEO_PLAYER_ID
                                  else "visual-family")
        if forced == "pitcher":
            if str(card.get("playerId", "")) == OHTANI_PLAYER_ID:
                # Player 3945's confirmed pitcher aptitude from PLAYERDATA.
                card["aptitude"] = {"pitcher": 58}
            card["position"] = 7
            card["positionName"] = "투수"
        else:
            card["pitching"] = None
            card["aptitude"] = ({"left": 42, "center": 42, "right": 42}
                                if str(card.get("playerId", "")) == OHTANI_PLAYER_ID else None)
        if json.dumps(card, ensure_ascii=False, sort_keys=True) != before:
            changed += 1
    return changed


def main() -> None:
    path = Path(__file__).resolve().parents[1] / "public/data/cards.json"
    cards = json.loads(path.read_text(encoding="utf-8"))
    changed = apply_card_rules(cards)
    path.write_text(json.dumps(cards, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"card type corrections: {changed}")


if __name__ == "__main__":
    main()
