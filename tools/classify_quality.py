#!/usr/bin/env python3
"""이펙트를 '재현이 잘 되는 것' 과 '점검 필요' 로 가른다.

[근거] 사용자가 대조군을 지목했다 — 1281005 는 원본과 거의 같고, 1285005 는
  일부가 이상하다. 둘을 같은 기준으로 재면 차이가 **두 구조에 몰린다.**

    | | 1281005 (좋음) | 1285005 (이상) |
    | 셀파츠            | 907 | 472 |
    | UV 트랙           | 146 (16%) | 280 (59%) |
    | 스크롤 창 _t/_u   | **0** | 136 |
    | 정점색 그라데이션 | **0** | 294 (62%) |

  파츠 수·인스턴스 수는 오히려 좋은 쪽이 더 많다(1724/173 vs 990/112) —
  그 가설은 기각됐다.

[분류]
  clean  : 두 구조 모두 없음      -> 원본 재현이 잘 되는 쪽
  tu     : _t/_u 스크롤 창만
  grad   : 정점색 모서리 그라데이션만
  both   : 둘 다 (가장 심함)

[우선순위] `data/quality-labels.json` 이 있으면 **그것이 정답**이다. 사용자가
  눈으로 보고 매긴 라벨이라 아래 휴리스틱보다 정확하다. 실제로 휴리스틱은
  사용자 라벨 대비 미탐 62 · 오탐 13 이었다. 라벨에 없는 id 만 휴리스틱으로
  채운다.

[3단계] clean(양호) · minor(살짝 이상) · broken(아예 엉망).
  옛 라벨의 "check" 는 minor 로 읽는다.

재생성: python3 tools/classify_quality.py > app/anss/quality.ts
"""
import gzip, json, os, re

D = "public/effects/anim-gz"
UV = ("uvx", "uvy", "uvsx", "uvsy", "uvrot")
groups = {"clean": [], "tu": [], "grad": [], "both": []}

for f in sorted(os.listdir(D)):
    doc = json.loads(gzip.open(f"{D}/{f}", "rb").read())
    tu = grad = 0
    for p in doc["parts"]:
        if p.get("k") != 1:
            continue
        if re.search(r"_[tu]$", p.get("n") or ""):
            tu += 1
        v = p.get("v")
        if v and v.get("blend") == 1 and any((c[3] if len(c) > 3 else 1) < 0.999
                                             for c in (v.get("c") or [])):
            grad += 1
    key = "both" if (tu and grad) else "tu" if tu else "grad" if grad else "clean"
    groups[key].append(f[:-8])

LABELS = "data/quality-labels.json"
labels = {}
if os.path.exists(LABELS):
    raw = json.load(open(LABELS))
    for k in ("clean", "minor", "broken"):
        for i in raw.get(k, []):
            labels[i] = k
    for i in raw.get("check", []):      # 구버전 내보내기 호환
        labels[i] = "minor"
    for i, v in (raw.get("overrides") or {}).items():
        labels[i] = {"check": "minor"}.get(v, v)

final = {"clean": [], "minor": [], "broken": []}
for key, ids in groups.items():
    for i in ids:
        final[labels.get(i, "clean" if key == "clean" else "minor")].append(i)
for k in final:
    final[k].sort()

out = ['/**',
       ' * 이펙트 재현 품질. tools/classify_quality.py 가 생성한다 — 직접 고치지 말 것.',
       ' *',
       ' * 출처는 `data/quality-labels.json` — 사용자가 682개를 눈으로 보고 매긴',
       ' * 라벨이다. 휴리스틱(_t/_u 스크롤 창 · 정점색 그라데이션)은 그 라벨 대비',
       ' * 미탐 62 · 오탐 13 이라 라벨에 없는 id 를 채우는 용도로만 쓴다. (docs §39)',
       ' */']
for k, label in (("clean", "재현 양호"),
                 ("minor", "살짝 이상"),
                 ("broken", "아예 엉망")):
    out.append(f"\n/** {label} ({len(final[k])}개) */")
    ids = ", ".join(f'"{i}"' for i in final[k])
    out.append(f"export const QUALITY_{k.upper()}: readonly string[] = [{ids}];")
out.append("""
export type Verdict = "clean" | "minor" | "broken";
export type QualityTab = "all" | Verdict;

const MAP = new Map<string, Verdict>();
for (const i of QUALITY_CLEAN) MAP.set(i, "clean");
for (const i of QUALITY_MINOR) MAP.set(i, "minor");
for (const i of QUALITY_BROKEN) MAP.set(i, "broken");

/** 저장된 판정. 모르는 id 는 양호로 본다. */
export const verdictOf = (id: number | string): Verdict =>
  MAP.get(String(id)) ?? "clean";

export const VERDICT_LABEL: Record<Verdict, string> = {
  clean: "재현 양호",
  minor: "살짝 이상",
  broken: "아예 엉망",
};
""")
print("\n".join(out))
