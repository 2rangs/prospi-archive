"use client";

import { useEffect, useMemo, useState } from "react";
import OriginalCardEffect, { useAllEffectPlans } from "../OriginalCardEffect";
import AnimSSPlayer from "../AnimSSPlayer";
import AnimSSPlayerGL from "../AnimSSPlayerGL";
import AnssStage from "../anss/AnssStage";
import { useAnss } from "../anss/useAnss";
import { PLAYER_NOTE, PLAYER_REV } from "../anss/version";
import { fxCanvasFor, fxScaleFor } from "../anss/types";

const YEAR_OF_GROUP = (group: number) => 2014 + group;

/** 카드 틀 높이 464(=360폭 x 660/512)에 맞춘 배율 — 선수 상세와 같은 기준 */
const FX_SCALE = fxScaleFor(464);




export default function EffectsPage() {
  const plans = useAllEffectPlans();
  const [group, setGroup] = useState("전체");
  const [series, setSeries] = useState("전체");
  const [rank, setRank] = useState("전체");
  const [current, setCurrent] = useState<number | null>(null);
  const [anim, setAnim] = useState(true);
  const [rebuilt, setRebuilt] = useState(true);
  const [backdrop, setBackdrop] = useState(true);
  const [speed, setSpeed] = useState(100);   // 원본 30fps 대비 %
  const [mute, setMute] = useState<Set<string>>(new Set());
  const [renderScale, setRenderScale] = useState(100);  // 내부 렌더 해상도 %
  const [zoom, setZoom] = useState(100);                // 이펙트 크기 % (기준 360/640)
  const [gl, setGl] = useState(true);

  const all = useMemo(() => Object.values(plans ?? {}).sort((a, b) => a.effectId - b.effectId), [plans]);
  const groups = useMemo(() => ["전체", ...Array.from(new Set(all.map(p => String(p.group)))).sort((a, b) => Number(a) - Number(b))], [all]);
  const seriesList = useMemo(() => ["전체", ...Array.from(new Set(all.map(p => p.series))).sort()], [all]);
  const ranks = useMemo(() => ["전체", ...Array.from(new Set(all.map(p => String(p.rank)))).sort()], [all]);

  const shown = all.filter(p =>
    (group === "전체" || String(p.group) === group) &&
    (series === "전체" || p.series === series) &&
    (rank === "전체" || String(p.rank) === rank));

  // 101001 holds a single mask cell and renders nothing, so prefer a
  // playable effect when nothing has been picked yet.
  const active = current ?? (shown.find(p => p.layers.length)?.effectId ?? shown[0]?.effectId ?? null);
  const activePlan = active != null ? all.find(p => p.effectId === active) : undefined;
  const anssDoc = useAnss(active);
  const fxBox = useMemo(
    () => fxCanvasFor(FX_SCALE, anssDoc?.stageW, anssDoc?.stageH),
    [anssDoc?.stageW, anssDoc?.stageH]);
  useEffect(() => { setMute(new Set()); }, [active]);
  // 파츠를 이름별로 묶은 목록 — 어느 레이어가 원본과 다른지 이름으로 짚기 위한 검사 도구
  const layers = useMemo(() => {
    if (!anssDoc) return [] as { name: string; count: number; add: number }[];
    const m = new Map<string, { name: string; count: number; add: number }>();
    for (const p of anssDoc.parts) {
      if (p.k !== 1) continue;
      const e = m.get(p.n) ?? { name: p.n, count: 0, add: 0 };
      e.count += 1;
      if (p.bl === 2) e.add += 1;
      m.set(p.n, e);
    }
    return [...m.values()].sort((a, b) => b.count - a.count).slice(0, 40);
  }, [anssDoc]);

  return <main className="player-detail-page">
    <header className="topbar">
      <a className="brand" href="/"><span className="brand-glyph">P</span><span>PROSPI<br/><b>PLAYER DATA</b></span></a>
      <a className="back-link" href="/">← 선수 목록</a>
    </header>

    <section className="fx-page">
      <div className="fx-stage-col">
        <div className="card-frame">
          {active != null && (rebuilt
            ? <AnssStage doc={anssDoc} width={fxBox.w} height={fxBox.h} scale={FX_SCALE * (zoom / 100)} backdrop={backdrop} speed={speed / 100} mute={mute} renderScale={renderScale / 100}/>
            : gl
            ? <AnimSSPlayerGL key={active} effectId={active} size={320}/>
            : anim
            ? <>
                <AnimSSPlayer effectId={active}/>
                <AnimSSPlayer effectId={active} layer="front"/>
              </>
            : <>
                <OriginalCardEffect group={12} effectId={active}/>
                <OriginalCardEffect group={12} effectId={active} layer="front"/>
              </>)}
          <span className="effect-id-label"><i/> {active ?? "—"} · {PLAYER_REV}</span>
          {activePlan && !activePlan.layers.length && <span className="fx-empty">재생 가능한 셀 없음</span>}
        </div>
        {layers.length > 0 && (
            <div className="fx-layers">
              <p>레이어 {layers.length}종 — 원본과 다른 것을 꺼서 알려 주세요</p>
              <div className="fx-layer-list">
                {layers.map(l => (
                  <label key={l.name} className={mute.has(l.name) ? "off" : ""}>
                    <input type="checkbox" checked={!mute.has(l.name)}
                      onChange={() => setMute(prev => {
                        const next = new Set(prev);
                        if (next.has(l.name)) next.delete(l.name); else next.add(l.name);
                        return next;
                      })}/>
                    <b>{l.name}</b>
                    <span>×{l.count}{l.add ? " 가산" : " 일반"}</span>
                  </label>
                ))}
              </div>
              {mute.size > 0 && (
                <button type="button" onClick={() => setMute(new Set())}>전부 켜기</button>
              )}
            </div>
        )}
        {activePlan && <div className="fx-meta">
          <dl>
            <div><dt>EFFECT</dt><dd>ANSS_EF_{activePlan.effectId}_L.CHK</dd></div>
            <div><dt>연도 그룹</dt><dd>{activePlan.group} · {YEAR_OF_GROUP(activePlan.group)}</dd></div>
            <div><dt>시리즈 · 서브</dt><dd>{activePlan.series} · {activePlan.sub}</dd></div>
            <div><dt>랭크</dt><dd>{activePlan.rank}</dd></div>
            <div><dt>클립</dt><dd>{activePlan.frames}F @ {activePlan.fps}FPS · {activePlan.canvasW}×{activePlan.canvasH}</dd></div>
            <div><dt>스프라이트 셀</dt><dd>{activePlan.spriteCount}개 중 {activePlan.layers.length}개 재생</dd></div>
          </dl>
        </div>}
      </div>

      <div className="fx-list-col">
        <p className="eyebrow">ORIGINAL ANIMSS EFFECTS</p>
        <h1>{all.length ? all.length.toLocaleString() : "…"}개 원본 효과</h1>
        <p className="fx-note">
          `ANSS_EF_&lt;effect_id&gt;_L.CHK`의 AnimSS 데이터를 해독해 원본 파트·키프레임·정점 색으로 재생합니다.
          effect_id는 <code>그룹 + 시리즈 + 서브 + 랭크</code> 4개 필드이고 실제 조합은 682가지입니다.
          카드가 어느 조합을 쓰는지는 앱이 서버 HTTP 응답에서 받는 값이라
          (<code>carddef::PlayerCardMinInfo.effectId</code>) 로컬 파일로는 확인할 수 없습니다.
          그래서 여기서는 682개를 직접 골라 비교하도록 했습니다.
        </p>
        <div className="select-row">
          <label>연도 그룹<select value={group} onChange={e => { setGroup(e.target.value); setCurrent(null); }}>{groups.map(g => <option key={g}>{g}</option>)}</select></label>
          <label>시리즈<select value={series} onChange={e => { setSeries(e.target.value); setCurrent(null); }}>{seriesList.map(s => <option key={s}>{s}</option>)}</select></label>
          <label>랭크<select value={rank} onChange={e => { setRank(e.target.value); setCurrent(null); }}>{ranks.map(r => <option key={r}>{r}</option>)}</select></label>
          <button onClick={() => { setGroup("전체"); setSeries("전체"); setRank("전체"); setCurrent(null); }}>필터 초기화</button>
          <button onClick={() => setRebuilt(v => !v)}>{rebuilt ? "재작성 플레이어" : "이전 플레이어"}</button>
          <button onClick={() => setBackdrop(v => !v)}>{backdrop ? "배경 레이어 ON" : "배경 레이어 OFF"}</button>
          <label className="fx-speed">
            <span>크기</span>
            <input type="range" min={50} max={300} step={5} value={zoom}
                   onChange={e => setZoom(Number(e.target.value))}/>
            <b>{zoom}% · ×{(FX_SCALE * (zoom / 100)).toFixed(3)}</b>
          </label>
          <label className="fx-speed">
            <span>해상</span>
            <input type="range" min={20} max={100} step={5} value={renderScale}
                   onChange={e => setRenderScale(Number(e.target.value))}/>
            <b>{renderScale}% · {Math.round(360 * renderScale / 100)}px</b>
          </label>
          <label className="fx-speed">
            <span>속도</span>
            <input type="range" min={10} max={200} step={5} value={speed}
                   onChange={e => setSpeed(Number(e.target.value))}/>
            <b>{speed}% · {Math.round((anssDoc?.fps || 30) * speed / 100)}fps</b>
          </label>
          <button onClick={() => setAnim(v => !v)}>{anim ? "원본 애니메이션 ON" : "정적 배치"}</button>
          <button onClick={() => setGl(v => !v)}>{gl ? "WebGL(가산) ON" : "DOM 렌더"}</button>
        </div>
        <p className="fx-count">{shown.length.toLocaleString()}개 표시</p>
        <div className="fx-grid">
          {shown.map(p => <button key={p.effectId}
            className={p.effectId === active ? "active" : ""}
            onClick={() => setCurrent(p.effectId)}>
            <b>{p.effectId}</b>
            <small>G{p.group} · {p.series} · R{p.rank}</small>
            <em>{p.layers.length} layers</em>
          </button>)}
        </div>
      </div>
    </section>
  </main>;
}
