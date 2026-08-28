"use client";

import { useEffect, useState } from "react";
import { AnssDocument } from "./types";
import { fetchGzipJson } from "./fetchGzip";
import { applyForceSwaps } from "./forceSwap";

/**
 * Loads one exported ANSS document. Nothing here is effect specific: the same
 * loader and player handle any ANSS_EF_*.CHK that tools/export_anim.py emits.
 */
/**
 * 게임은 이펙트를 **두 벌** 배포한다: ANSS_EF_<id>_L.CHK 와 _S.CHK.
 * _S 는 목록 아이콘용 저작본이라 파츠 수가 두 자릿수로 줄어 있다
 * (1201005: 1,525 파츠 -> 15 파츠, 텍스처 19장 -> 5장).
 * 큰 이펙트를 아이콘 크기로 줄여 쓰면 원본에 없는 뿌연 층이 쌓이므로,
 * 아이콘은 _S 를 쓴다. 22개는 _S 가 없어 _L 로 되돌아간다.
 */
export type AnssSize = "L" | "S";

const cache = new Map<string, AnssDocument | null>();
const inflight = new Map<string, Promise<AnssDocument | null>>();
/**
 * 문서 캐시 상한을 **크기 등급별로** 나눈다.
 *
 * [문제] 한 벌로 40개를 쥐고 있었다. 그런데 두 등급의 덩치가 30배 차이난다.
 * [측정] 해제된 JSON 텍스트 기준:
 *     _L(무대) 682개 — 중앙값 163KB · 평균 231KB · 최대 1,416KB
 *                     40개면 평균 9.0MB, 최악(상위 40개) **33.4MB**
 *     _S(아이콘) 663개 — 중앙값 8KB · 평균 12KB · 최대 156KB
 *                     40개면 0.5MB
 *   파싱된 JS 객체는 보통 텍스트의 3~6배라, _L 40개는 실제로 수십~수백 MB다.
 * [해석] _L 은 한 번에 한두 개만 화면에 있고(상세 1개, 이펙트 페이지 1개),
 *   _S 는 목록 행 수만큼 동시에 필요하다. 같은 상한을 쓸 이유가 없다.
 * [처리] _L 은 6개(앞뒤 이동에 재요청 안 나는 최소), _S 는 160개.
 *   텍스트 기준 각각 약 1.4MB / 1.9MB 로, 종전 최악 33MB 대비 크게 준다.
 * [비용] 밀려난 문서는 다시 받는다 — gz 로 수십 KB라 체감이 없다.
 */
const DOC_CACHE_CAP: Record<AnssSize, number> = { L: 6, S: 160 };

function remember(key: string, doc: AnssDocument | null) {
  cache.delete(key);
  cache.set(key, doc);
  const size = key.startsWith("S:") ? "S" : "L";
  let over = 0;
  for (const k of cache.keys()) if (k.startsWith(`${size}:`)) over += 1;
  if (over <= DOC_CACHE_CAP[size]) return;
  for (const k of cache.keys()) {
    if (over <= DOC_CACHE_CAP[size]) break;
    if (k.startsWith(`${size}:`)) { cache.delete(k); over -= 1; }
  }
}

export function loadAnss(effectId: number, size: AnssSize = "L") {
  const key = `${size}:${effectId}`;
  if (cache.has(key)) {
    const hit = cache.get(key)!;
    remember(key, hit); // LRU touch
    return Promise.resolve(hit);
  }
  let p = inflight.get(key);
  if (!p) {
    p = fetchGzipJson<AnssDocument>(
      `/effects/anim${size === "S" ? "-s" : ""}-gz/${effectId}.json.gz`)
      .then(applyForceSwaps)
      .then((doc: AnssDocument | null) => {
        remember(key, doc);
        inflight.delete(key);
        return doc;
      });
    inflight.set(key, p);
  }
  return p;
}

/**
 * 아이콘용 로더. _S 가 없으면(663/685 만 있다) _L 로 되돌아가는데, 두 벌은
 * 좌표 기준이 달라서(아이콘 픽셀 vs 카드 아트 픽셀) 어느 쪽을 받았는지
 * 호출부가 알아야 배율을 맞출 수 있다.
 */
export async function loadAnssIcon(effectId: number) {
  const small = await loadAnss(effectId, "S");
  if (small) return { doc: small, size: "S" as const };
  const large = await loadAnss(effectId, "L");
  return large ? { doc: large, size: "L" as const } : null;
}

export function useAnss(effectId: number | null) {
  const [doc, setDoc] = useState<AnssDocument | null>(
    effectId != null ? cache.get(`L:${effectId}`) ?? null : null);
  useEffect(() => {
    if (effectId == null) { setDoc(null); return; }
    let alive = true;
    loadAnss(effectId).then(d => { if (alive) setDoc(d); });
    return () => { alive = false; };
  }, [effectId]);
  return doc;
}
