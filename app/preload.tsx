"use client";
import { useEffect, useState } from "react";

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
const FILES = [
  "/data/cards.json",
  "/data/ref-stats.json",
  "/data/skills.json",
  "/effects/effect-index.json",
  "/effects/known-map.json",
];

export function Preload({ children }: { children: React.ReactNode }) {
  const [done, setDone] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    let n = 0;
    Promise.all(FILES.map(f =>
      fetch(f).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null)
        .then(v => { n += 1; if (alive) setDone(n); return v; })
    )).then(() => { if (alive) setReady(true); });
    // 5초를 넘기면 그냥 연다 — 로딩 화면에 갇히지 않게
    const t = setTimeout(() => { if (alive) setReady(true); }, 5000);
    return () => { alive = false; clearTimeout(t); };
  }, []);

  if (ready) return <>{children}</>;
  const pct = Math.round((done / FILES.length) * 100);
  return <div className="preload" role="status" aria-live="polite">
    <p className="preload-mark">PROSPI ARCHIVE</p>
    <div className="preload-bar"><i style={{ width: `${pct}%` }}/></div>
    <p className="preload-pct">{pct}%</p>
  </div>;
}
