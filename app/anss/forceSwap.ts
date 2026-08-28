/**
 * 강제표시 파츠의 **셀 텍스처 갈아끼우기**.
 *
 * [확인된 사실]
 *   1) 2025/2026 SELECTION 리본 이펙트(1114105 · 1214105)의 `ribbon_base` 는
 *      256x128 은색 배너인데 **글자가 없다**. 두 이펙트가 같은 시트 해시
 *      64285e81d20b0a7e 를 쓴다(문서 전수 대조).
 *   2) 같은 계열 옛 이펙트 914105(2023) · 1014105(2024)에는 `ef_914105_07`
 *      파츠가 있고, 그 셀(241x131, sprite 80edf3aa9d3d3c4d)에는
 *      **MEMORIAL** 글자가 찍혀 있다. 파츠 이름 자체가 "914105 의 것"이다.
 *   3) 두 리본은 같은 그림이다 — 알파 실루엣 IoU 0.991, 겹치는 화소 색차
 *      중앙값 1.7. 다른 화소 25.9% 는 정확히 글자 영역이다.
 * [해석] 새 그룹은 같은 리본에서 **글자만 지운** 판을 쓰고, 글자는 바깥에서
 *   얹는다(콜라보 로고와 같은 방식). 사용자 인게임 확인: SL3 카드의 우측하단
 *   리본에는 MEMORIAL 이 적혀 있다.
 * [처리] 옛 판을 빈 판의 셀 좌표계(256x128)로 정렬해 대체 스프라이트를 만들고
 *   (배율 0.991x0.983 · 오프셋 +9,0 → 정렬 후 IoU 0.9898, bbox 완전 일치),
 *   문서를 읽는 시점에 그 파츠의 셀 파일만 바꾼다. 기하는 건드리지 않는다.
 * [신뢰도] 1214105 = CONFIRMED(사용자 인게임 확인) · 1114105 = STRONG
 *   (파츠 구성·hide/alpha 트랙이 1214105 와 완전히 동일).
 */
import { AnssDocument } from "./types";

type Swap = { part: string; cellFile: string; why?: string };
type Table = Record<string, Swap[]>;

let table: Table | null = null;
let load: Promise<Table> | null = null;

function fetchTable(): Promise<Table> {
  if (!load) {
    load = fetch("/effects/force-show.json")
      .then(r => (r.ok ? r.json() : null))
      .then((j: { map?: Record<string, { parts?: string[]; swap?: Swap[] }> } | null) => {
        const out: Table = {};
        for (const [id, v] of Object.entries(j?.map ?? {})) {
          if (v?.swap?.length) out[id] = v.swap;
        }
        table = out;
        return out;
      })
      .catch(() => (table = {}));
  }
  return load;
}

/** 미리 읽어 둔다 — 문서보다 먼저 도착하면 첫 프레임부터 맞는 그림이 나온다. */
export function primeForceSwap() { void fetchTable(); }

/**
 * 문서의 셀 파일을 표대로 바꾼다. 표가 아직 없으면 기다린다.
 * 문서 캐시에 들어가기 전 한 번만 돈다.
 */
export async function applyForceSwaps(doc: AnssDocument | null) {
  if (!doc) return doc;
  const t = table ?? (await fetchTable());
  const swaps = t[String(doc.effectId)];
  if (!swaps) return doc;
  for (const s of swaps) {
    for (const p of doc.parts as { n?: string; c?: { file?: string } }[]) {
      if (p.n === s.part && p.c?.file) p.c.file = s.cellFile;
    }
  }
  return doc;
}
