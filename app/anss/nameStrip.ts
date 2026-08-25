"use client";

import { useEffect, useState } from "react";

/**
 * 카드 아틀라스에서 이름 글자만 잘라 가운데 정렬하기 위한 잉크 상자 측정.
 *
 * [문제] 고정 크롭(x 0~282)은 틀렸다. 이름은 왼쪽 x≈12 에서 시작해 **글자 수만큼
 *   오른쪽으로 늘어난다**: 清宮幸太郎 12~335 · 菊池 涼介 11~276 ·
 *   ウィットリー 12~258. 중심이 135~174 로 흩어져 한 상자로는 정렬이 안 된다.
 * [처리] CL 아틀라스(512x1024)의 y 880~1000 구간에서 **흰 글자 픽셀**의 좌우
 *   범위를 카드마다 재고, 그 상자를 기준으로 크롭·정렬한다. 결과는 카드 id 로
 *   캐시하므로 같은 카드는 한 번만 잰다.
 * [신뢰도] CONFIRMED (표본 측정)
 */
/** sx1 = 성(공백 앞) 끝 x. 공백이 없으면 x1 과 같다. */
export type InkBox = { x0: number; x1: number; y0: number; y1: number; sx1: number };

const cache = new Map<string, InkBox | null>();
const inflight = new Map<string, Promise<InkBox | null>>();

function measure(url: string): Promise<InkBox | null> {
  return new Promise(resolve => {
    const im = new Image();
    im.decoding = "async";
    im.onerror = () => resolve(null);
    im.onload = () => {
      try {
        const cv = document.createElement("canvas");
        cv.width = 512; cv.height = 1024;
        const g = cv.getContext("2d", { willReadFrequently: true });
        if (!g) return resolve(null);
        g.drawImage(im, 0, 0, 512, 1024);
        const TOP = 880, H = 120;
        const d = g.getImageData(0, TOP, 512, H).data;
        let x0 = 512, x1 = -1, y0 = H, y1 = -1;
        for (let y = 0; y < H; y += 1) {
          for (let x = 0; x < 512; x += 1) {
            const i = (y * 512 + x) * 4;
            // 흰 글자만: 알파 높고 밝은 픽셀
            if (d[i + 3] > 150 && (d[i] + d[i + 1] + d[i + 2]) / 3 > 150) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
          }
        }
        if (x1 < 0) return resolve(null);
        /**
         * 성(姓)만 남기기.
         *
         * 인게임 목록은 공백 앞 글자들만 보여준다(田淵 幸一 -> 田淵). 열마다
         * 잉크 픽셀을 세어 **첫 번째 넓은 공백**을 찾고 거기서 자른다.
         * 공백이 없으면(외국인 선수 등) 전체를 쓴다.
         */
        const col = new Int32Array(512);
        for (let y = 0; y < H; y += 1) {
          for (let x = x0; x <= x1; x += 1) {
            const i = (y * 512 + x) * 4;
            if (d[i + 3] > 150 && (d[i] + d[i + 1] + d[i + 2]) / 3 > 150) col[x] += 1;
          }
        }
        /**
         * [측정] 단어 공백은 34~38px, 같은 단어 안 글자 사이는 4~14px 이다.
         *   小笠原道大 34 · 長谷川哉 38 · 清宮幸太郎 38 · 菊池 涼介 35 ·
         *   三森 大貴 35 / 글자 사이 최대 14(長谷川의 谷-川).
         *   임계 14 로 두면 3글자 성이 中間에서 잘렸다 → 24 로 올린다.
         *   가타카나 이름(ウィットリー)은 최대 갭 6 이라 잘리지 않고 전체가 남는다.
         */
        const GAP = 24;
        let cut = x1, run = 0;
        for (let x = x0; x <= x1; x += 1) {
          if (col[x] === 0) {
            run += 1;
            if (run >= GAP) { cut = x - run; break; }
          } else run = 0;
        }
        resolve({ x0, x1, y0: TOP + y0, y1: TOP + y1, sx1: Math.max(x0 + 8, cut) });
      } catch {
        resolve(null);
      }
    };
    im.src = url;
  });
}

export function useNameInk(cardId: string, url: string) {
  const [box, setBox] = useState<InkBox | null>(() => cache.get(cardId) ?? null);
  useEffect(() => {
    const hit = cache.get(cardId);
    if (hit !== undefined) { setBox(hit); return; }
    let alive = true;
    let p = inflight.get(cardId);
    if (!p) { p = measure(url); inflight.set(cardId, p); }
    p.then(v => {
      cache.set(cardId, v);
      inflight.delete(cardId);
      if (alive) setBox(v);
    });
    return () => { alive = false; };
  }, [cardId, url]);
  return box;
}
