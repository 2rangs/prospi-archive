#!/usr/bin/env python3
"""Card-level rules that cannot be inferred from player-level aptitude alone."""
from __future__ import annotations

import json
from pathlib import Path


OHTANI_PLAYER_ID = "3945"


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
    if str(card.get("playerId", "")) != OHTANI_PLAYER_ID:
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
        if not forced or card.get("playerType") == forced:
            continue
        card["playerType"] = forced
        card["cardTypeSource"] = "visual-family"
        if forced == "pitcher":
            # Player 3945's confirmed pitcher aptitude from PLAYERDATA.
            card["aptitude"] = {"pitcher": 58}
        else:
            card["aptitude"] = {"left": 42, "center": 42, "right": 42}
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
