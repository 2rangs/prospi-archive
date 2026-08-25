"use client";

import { useEffect, useState } from "react";
import { AnssDocument } from "./types";
import { fetchGzipJson } from "./fetchGzip";

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

function fetchDoc(url: string) {
  return fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
}

export function loadAnss(effectId: number, size: AnssSize = "L") {
  const key = `${size}:${effectId}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  let p = inflight.get(key);
  if (!p) {
    p = fetchGzipJson<AnssDocument>(
      `/effects/anim${size === "S" ? "-s" : ""}-gz/${effectId}.json.gz`)
      .then((doc: AnssDocument | null) => {
        cache.set(key, doc);
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
