#!/usr/bin/env python3
"""prospi-a.rakda3.net/sp-list 에서 특수능력 설명을 긁는다.

구조: <div class='sp-item' id='<야수|투수>_<기본이름>'>
        <div class='sp-title'>（超）かく乱（・改）</div>
        <div class='sp-effect'>설명<br>・효과<br>…</div>
id 의 기본이름이 카드 표기(超/◎/改 등이 붙음)와 맞추는 키다.
출력: public/data/skills.json  { 기본이름: {title, kind, effect[]} }
"""
import json, re, subprocess, html as H

URL = "https://prospi-a.rakda3.net/sp-list"
OUT = "public/data/skills.json"
UA = {"User-Agent": "prospi-archive-research (personal)"}

ITEM = re.compile(
    r"<div class='sp-item' id='([^']*)'>\s*"
    r"<div class='sp-title'>(.*?)</div>\s*"
    r"<div class='sp-effect'>(.*?)</div>", re.S)


def text(s):
    return H.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def main():
    page = subprocess.run(
        ["curl", "-fsSL", "--retry", "4", "-A", UA["User-Agent"], URL],
        check=True, capture_output=True,
    ).stdout.decode("utf-8", "replace")
    out = {}
    for m in ITEM.finditer(page):
        ident, title, effect = m.group(1), m.group(2), m.group(3)
        kind, _, base = ident.partition("_")
        lines = [text(x) for x in re.split(r"<br\s*/?>", effect)]
        lines = [x for x in lines if x]
        out[base] = {"title": text(title), "kind": kind,
                     "desc": lines[0] if lines else "", "effect": lines[1:]}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=0)
    print(f"{len(out)}개 -> {OUT}")


if __name__ == "__main__":
    main()
