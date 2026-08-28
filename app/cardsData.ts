"use client";
import { fetchGzipJson } from "./anss/fetchGzip";
import { CARDS_URL } from "./dataUrls";
import type { Card } from "./search";

/**
 * 카드 원장(15,222장) 단일 로더.
 *
 * [문제] 목록 화면과 이펙트 화면이 각각 `fetchGzipJson(CARDS_URL)` 을 직접
 *   불러서, 모듈 캐시가 없어 화면을 옮길 때마다 **다시 받고 다시 파싱**했다.
 *   전송은 브라우저 HTTP 캐시가 막아 주더라도 gunzip + JSON.parse(10.7MB 배열,
 *   15,222객체)는 매번 다시 돈다 — 목록이 늦게 뜨는 주된 원인.
 * [처리] 모듈 수준에서 한 번만 받아 파싱하고 그 배열을 공유한다. 초기 일괄
 *   로드(Preload)도 같은 함수를 써서, 예열이 곧 본 데이터가 되게 한다.
 */
let cache: Card[] | null = null;
let inflight: Promise<Card[] | null> | null = null;

export function cardsNow(): Card[] | null { return cache; }

export function loadCards(): Promise<Card[] | null> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetchGzipJson<Card[]>(CARDS_URL)
      .then(rows => { if (rows) cache = rows; return cache; })
      .catch(() => null);
  }
  return inflight;
}
