"use client";
import { useEffect, useState } from "react";
import { loadCards } from "./cardsData";
import { loadRefStats } from "./refStats";
import { loadSkills } from "./skills";
import { loadEffectPool, loadKnown } from "./anss/useEffectPool";

/**
 * 초기 일괄 로드.
 *
 * [문제] 카드 15,222장 · 표기값 · 스킬 · 이펙트 색인을 화면마다 따로 받으면
 *   첫 상호작용까지 매번 기다린다. 이펙트 스프라이트는 더 심해서, 카드를
 *   고를 때마다 수십 장을 새로 내려받느라 첫 프레임이 늦는다.
 * [처리] 앱을 열 때 **데이터 파일 네 개를 한 번에** 받아 두고 진행률을 보여 준다.
 *   스프라이트까지 전부(395MB) 받는 것은 비현실적이라 하지 않는다 — 대신
 *   데이터가 준비되면 화면을 열고, 이펙트는 고른 것만 받는다.
 * [주의] fetch 는 브라우저 캐시에 남으므로 이후 화면에서 재요청해도 즉시 끝난다.
 */
/**
 * [수정 1] 미리 받는 URL 이 화면에서 쓰는 URL 과 **정확히 같아야** 캐시가 맞는다.
 *   종전에는 여기서 `/data/cards.json`, 목록에서 `/data/cards.json?v=…` 로
 *   달라서 10.7MB 를 두 번 받았다(실측 데이터 전송 21.9MB).
 *
 * [수정 2] 예열을 **버리는 fetch 가 아니라 실제 로더**로 한다.
 *   종전에는 `fetch(url).arrayBuffer()` 로 받아 버리고, 화면의 훅이 같은 URL 을
 *   다시 받아 다시 gunzip + JSON.parse 했다. 전송은 HTTP 캐시가 막아 주지만
 *   **파싱은 두 번 돈다** — 카드 원장은 15,222객체라 파싱이 전송보다 비싸다.
 *   이제 훅과 같은 모듈 캐시를 채우므로, 예열이 끝나면 화면은 파싱 없이 즉시
 *   그 배열을 받는다.
 *
 * [수정 3] `/effects/effect-index.json`(291KB, 비압축)을 목록에서 뺐다.
 *   앱 어디에서도 읽지 않는다(주석에만 남아 있었다). 이펙트 목록 화면이 쓰는
 *   것은 `effect-keys.json` 이다.
 */
const STEPS: (() => Promise<unknown>)[] = [
  loadCards,
  loadRefStats,
  loadSkills,
  loadKnown,
  loadEffectPool,
];

export function Preload({ children }: { children: React.ReactNode }) {
  const [done, setDone] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    let n = 0;
    Promise.all(STEPS.map(step =>
      step().catch(() => null)
        .then(v => { n += 1; if (alive) setDone(n); return v; })
    )).then(() => { if (alive) setReady(true); });
    // 5초를 넘기면 그냥 연다 — 로딩 화면에 갇히지 않게
    const t = setTimeout(() => { if (alive) setReady(true); }, 5000);
    return () => { alive = false; clearTimeout(t); };
  }, []);

  if (ready) return <>{children}</>;
  const pct = Math.round((done / STEPS.length) * 100);
  return <div className="preload" role="status" aria-live="polite">
    <p className="preload-mark">PROSPI ARCHIVE</p>
    <div className="preload-bar"><i style={{ width: `${pct}%` }}/></div>
    <p className="preload-pct">{pct}%</p>
  </div>;
}
