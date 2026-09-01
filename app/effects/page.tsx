"use client";
import { loadCards } from "../cardsData";

import { useEffect, useMemo, useRef, useState } from "react";
import OriginalCardEffect, { useAllEffectPlans } from "../OriginalCardEffect";
import AnimSSPlayer from "../AnimSSPlayer";
import AnimSSPlayerGL from "../AnimSSPlayerGL";
import AnssStage from "../anss/AnssStage";
import { useAnss } from "../anss/useAnss";
import { PLAYER_REV } from "../anss/version";
import { FX_CARD_FILL } from "../anss/types";
import { type Card } from "../search";
import { useRefStats } from "../refStats";
import { useEffectPool, useKnownMap, useKnownMeta } from "../anss/useEffectPool";
import { cardKind, decodeEffectId, resolveEffect } from "../anss/resolve";
import { teamOf } from "../teams";
import { verdictOf, VERDICT_LABEL, type QualityTab, type Verdict } from "../anss/quality";

const YEAR_OF_GROUP = (group: number) => 2014 + group;

/**
 * 카드 이미지 자체가 이펙트 구성의 일부인 콜라보 효과.
 * 1285005의 MAJOR 캐릭터는 ANSS 스프라이트가 아니라 variant 1500의
 * CL 카드 아트에 선수와 함께 들어 있으므로 일반 역추정 카드로 대체하면 안 된다.
 */
const EFFECT_CARD_OVERRIDES: Record<string, string> = {
  "1285005": "1251041500", // 齋藤友貴哉 × 本田吾郎
};





export default function EffectsPage() {
  const plans = useAllEffectPlans();
  const [group, setGroup] = useState("전체");
  const [series, setSeries] = useState("전체");
  const [rank, setRank] = useState("전체");
  const [current, setCurrent] = useState<number | null>(null);
  const [anim, setAnim] = useState(true);
  const [rebuilt, setRebuilt] = useState(true);
  const [backdrop, setBackdrop] = useState(true);
  const [showPlayer, setShowPlayer] = useState(true);
  const [speed, setSpeed] = useState(100);   // 원본 30fps 대비 %
  const [mute, setMute] = useState<Set<string>>(new Set());
  const [renderScale, setRenderScale] = useState(100);  // 내부 렌더 해상도 %
  const [zoom, setZoom] = useState(100);                // 이펙트 크기 % (기준 360/640)
  const [gl, setGl] = useState(true);
  const [tab, setTab] = useState<QualityTab>("all");
  /**
   * 손으로 고친 품질 판정. 자동 분류(app/anss/quality.ts) 위에 덮어쓴다.
   * 눈으로 보고 "양호 <-> 점검 필요" 를 바꾼 뒤 JSON 으로 내보내 작업에 쓴다.
   */
  const [marks, setMarks] = useState<Record<string, Verdict>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem("prospi.quality.overrides");
      if (raw) {
        // 옛 저장본의 "check" 는 "minor" 로 읽는다
        const got = JSON.parse(raw) as Record<string, string>;
        const fixed: Record<string, Verdict> = {};
        for (const [k, v] of Object.entries(got)) {
          fixed[k] = (v === "check" ? "minor" : v) as Verdict;
        }
        setMarks(fixed);
      }
    } catch { /* 저장소가 막혀 있으면 그냥 기본값 */ }
  }, []);
  const setMark = (id: number, v: Verdict | null) => {
    setMarks(prev => {
      const next = { ...prev };
      if (v === null) delete next[String(id)]; else next[String(id)] = v;
      try { localStorage.setItem("prospi.quality.overrides", JSON.stringify(next)); } catch { /* noop */ }
      return next;
    });
  };
  /** 저장된 판정 + 이번 세션 손수정을 합친 최종 값 */
  const quality = (id: number): Verdict => marks[String(id)] ?? verdictOf(id);

  const all = useMemo(() => Object.values(plans ?? {}).sort((a, b) => a.effectId - b.effectId), [plans]);
  const groups = useMemo(() => ["전체", ...Array.from(new Set(all.map(p => String(p.group)))).sort((a, b) => Number(a) - Number(b))], [all]);
  const seriesList = useMemo(() => ["전체", ...Array.from(new Set(all.map(p => p.series))).sort()], [all]);
  const ranks = useMemo(() => ["전체", ...Array.from(new Set(all.map(p => String(p.rank)))).sort()], [all]);

  /**
   * 품질 탭. 사용자가 지목한 대조군(1281005 정상 / 1285005 이상)의 차이가
   * `_t`/`_u` 스크롤 창과 정점색 그라데이션 두 구조에 몰려서, 그것을 쓰는
   * 이펙트만 따로 모아 본다. (app/anss/quality.ts · docs §39)
   */
  const shown = all.filter(p =>
    (group === "전체" || String(p.group) === group) &&
    (series === "전체" || p.series === series) &&
    (rank === "전체" || String(p.rank) === rank) &&
    (tab === "all" || quality(p.effectId) === tab));

  // 101001 holds a single mask cell and renders nothing, so prefer a
  // playable effect when nothing has been picked yet.
  const active = current ?? (shown.find(p => p.layers.length)?.effectId ?? shown[0]?.effectId ?? null);

  /**
   * 좌우 방향키로 목록을 훑는다. 71개를 하나씩 눈으로 보려면 클릭보다 빠르다.
   * 입력 요소에 포커스가 있을 때는 캐럿 이동을 방해하지 않도록 넘긴다.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const list = shownRef.current;
      if (!list.length) return;
      e.preventDefault();
      const at = list.findIndex(p => p.effectId === activeRef.current);
      const step = e.key === "ArrowRight" ? 1 : -1;
      const next = list[(((at < 0 ? 0 : at) + step) % list.length + list.length) % list.length];
      if (next) setCurrent(next.effectId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const activeRef = useRef(active);
  activeRef.current = active;

  const activePlan = active != null ? all.find(p => p.effectId === active) : undefined;
  const anssDoc = useAnss(active);
  /**
   * 캔버스 크기는 **열 폭에 맞춰 props 로** 정한다.
   * AnssStage 가 인라인 style 로 캔버스 크기를 못박기 때문에 CSS(max-width)로는
   * 줄일 수 없다 — 예전에 캔버스 675px 가 382px 열에서 잘리던 원인이 이것이다.
   * 스테이지 전체(720x1136 등)를 그대로 담아 오버스캔 없이 보여 준다.
   */
  const FX_W = 380;
  const fxBox = useMemo(() => {
    const sw = anssDoc?.stageW || 720, sh = anssDoc?.stageH || 1136;
    return { w: FX_W, h: Math.round(FX_W * (sh / sw)), scale: FX_W / sw };
  }, [anssDoc?.stageW, anssDoc?.stageH]);
  /**
   * 가운데에 세울 선수 카드.
   * 이펙트만 띄우면 크기 감각이 없어 잘려 보이는지도 알기 어렵다.
   * 이펙트의 group(=연도)과 같은 카드를 하나 골라 상세 화면과 같은 구도로 만든다.
   */
  const [cards, setCards] = useState<Card[]>([]);
  useEffect(() => { void loadCards().then(rows => { if (rows) setCards(rows); }); }, []);
  const refAll = useRefStats();
  const pool = useEffectPool();
  const known = useKnownMap();
  const knownMeta = useKnownMeta();
  /**
   * 미리보기 카드 — **실제 선수 사진**이 나오게 고른다.
   *
   * [문제] 사용자 보고 "no image 말고 실제 선수 사진 보여줘".
   *   종전에는 그룹 안에서 variant 가 "01" 인 **첫 카드**를 집었는데, 카드
   *   목록이 이름순이라 매번 알파벳 첫 외국인 선수가 나왔고, 그룹 7 은
   *   `アメリカ 先発5`(playerId 6510) 같은 **가상 카드**라 선수 사진이 없다.
   * [처리] ① playerId 6xxx 대(調子くん·대표팀 더미 등 비선수)와 빈 playerId 를
   *   빼고, ② 스피리츠가 가장 높은 카드를 고른다 = 그 연도의 대표 선수.
   *   스피리츠 표기값이 없으면 종전 규칙으로 내려간다.
   */
  const sampleCard = useMemo(() => {
    if (!cards.length || !activePlan) return undefined;
    const exactCard = EFFECT_CARD_OVERRIDES[String(activePlan.effectId)];
    if (exactCard) {
      const original = cards.find(c => c.id === exactCard);
      if (original) return original;
    }
    const inGroup = cards.filter(c => c.group === activePlan.group);
    const real = inGroup.filter(c => c.playerId && !/^6\d{3}$/.test(String(c.playerId)));
    /**
     * ① 지금 보고 있는 **이 이펙트를 실제로 쓰는 선수**를 먼저 찾는다.
     *    (사용자 요청: "선수 사진에 맞게 이펙트는 유동적으로 바뀌어야 함")
     *    카드->이펙트 해석은 목록과 같은 resolveEffect 를 쓴다 —
     *    실측(known) > 실측전파(family) > 규칙(rule) 순으로 신뢰도가 높은 것부터.
     * ② 그런 선수가 여럿이면 스피리츠가 가장 높은 카드 = 그 이펙트의 대표 선수.
     * ③ 못 찾으면 같은 연도의 최고 스피리츠 선수로 내려간다.
     */
    const want = String(activePlan.effectId ?? "");
    const pick = (list: Card[]) => {
      let best: Card | undefined; let bestS = -1;
      for (const c of list) {
        const sp = refAll?.[c.id]?.spirits ?? 0;
        if (sp > bestS) { best = c; bestS = sp; }
      }
      return best;
    };
    if (pool.length && want) {
      const target = decodeEffectId(want);
      let best: Card | undefined;
      let bestScore = -1;
      let bestSpirits = -1;
      for (const c of real) {
        const r = refAll?.[c.id];
        const m = resolveEffect(c.group, c.variant, pool, known, c.id,
          { kind: cardKind(r?.series), league: teamOf(r?.team ?? "")?.league ?? null, meta: knownMeta });
        if (!m || m.level === "none") continue;
        const got = decodeEffectId(String(m.effectId));
        if (!got || !target) continue;

        // Rank 3/4/5 are the A/A+/S renderings of the same authored family.
        // The card archive mainly contains the S artwork, so an exact-id-only
        // reverse lookup left lower-rank effects paired with an unrelated
        // fallback player.  Match the family first and ignore only rank.
        const score = got.effectId === target.effectId ? 4
          : got.group === target.group && got.series === target.series && got.sub === target.sub ? 3
          : got.group === target.group && got.series === target.series ? 2
          : -1;
        const spirits = refAll?.[c.id]?.spirits ?? 0;
        if (score > bestScore || (score === bestScore && spirits > bestSpirits)) {
          best = c;
          bestScore = score;
          bestSpirits = spirits;
        }
      }
      if (best) return best;
    }
    return pick(real)
      ?? real.find(c => c.variant.startsWith("01"))
      ?? real[0] ?? inGroup[0] ?? cards[0];
  }, [cards, activePlan, refAll, pool, known, knownMeta]);

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
            ? <AnssStage doc={anssDoc} width={fxBox.w} height={fxBox.h}
                scale={fxBox.scale * FX_CARD_FILL * (zoom / 100)} cardArtScale={1 / FX_CARD_FILL}
                cardArt={showPlayer && sampleCard ? `/api/card-image?group=${sampleCard.group}&file=${encodeURIComponent(sampleCard.largeFile)}` : undefined}
                backdrop={backdrop} speed={speed / 100} mute={mute} renderScale={renderScale / 100}/>
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
        {activePlan && <div className="fx-judge">
          <span className="fj-label">이 이펙트 판정</span>
          {(["clean", "minor", "broken"] as const).map(v => (
            <button key={v} type="button"
              className={quality(activePlan.effectId) === v ? "on " + v : v}
              onClick={() => setMark(activePlan.effectId, v)}>
              {VERDICT_LABEL[v]}
            </button>
          ))}
          {marks[String(activePlan.effectId)] && (
            <button type="button" className="fj-reset"
              onClick={() => setMark(activePlan.effectId, null)}>자동 분류로</button>
          )}
          <span className="fj-hint">← → 로 이동</span>
        </div>}
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
          <label>연도<select value={group} onChange={e => { setGroup(e.target.value); setCurrent(null); }}>
            {/* 그룹 1~12 = 2015~2026 (사용자 확정). 값은 그룹 번호 그대로 쓰고 표기만 연도로. */}
            {groups.map(g => <option key={g} value={g}>
              {g === "전체" ? g : `${YEAR_OF_GROUP(Number(g))} (G${g})`}
            </option>)}</select></label>
          <label>시리즈<select value={series} onChange={e => { setSeries(e.target.value); setCurrent(null); }}>{seriesList.map(s => <option key={s}>{s}</option>)}</select></label>
          <label>랭크<select value={rank} onChange={e => { setRank(e.target.value); setCurrent(null); }}>{ranks.map(r => <option key={r}>{r}</option>)}</select></label>
          <button onClick={() => { setGroup("전체"); setSeries("전체"); setRank("전체"); setCurrent(null); }}>필터 초기화</button>
          <button onClick={() => setRebuilt(v => !v)}>{rebuilt ? "재작성 플레이어" : "이전 플레이어"}</button>
          <button onClick={() => setBackdrop(v => !v)}>{backdrop ? "배경 레이어 ON" : "배경 레이어 OFF"}</button>
          <button onClick={() => setShowPlayer(v => !v)}>{showPlayer ? "선수 ON" : "선수 OFF"}</button>
          <label className="fx-speed">
            <span>크기</span>
            <input type="range" min={50} max={300} step={5} value={zoom}
                   onChange={e => setZoom(Number(e.target.value))}/>
            <b>{zoom}% · ×{(fxBox.scale * FX_CARD_FILL * (zoom / 100)).toFixed(3)}</b>
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
        <div className="fx-tabs">
          {([["all", "전체"], ["clean", VERDICT_LABEL.clean],
             ["minor", VERDICT_LABEL.minor], ["broken", VERDICT_LABEL.broken]] as const)
            .map(([k, label]) => {
              const n = k === "all" ? all.length
                : all.filter(p => quality(p.effectId) === k).length;
              return (
            <button key={k} type="button"
              className={tab === k ? `on ${k}` : k}
              onClick={() => { setTab(k as QualityTab); setCurrent(null); }}>
              {label} <b>{n}</b>
            </button>
          ); })}
        </div>
        {Object.keys(marks).length > 0 && (
          <div className="fx-export">
            <span>손수정 <b>{Object.keys(marks).length}</b>건</span>
            <button type="button" onClick={() => {
              /**
               * 자동 분류 + 손수정을 합쳐 내려받는다. 파일을 작업 쪽에서 읽어
               * tools/classify_quality.py 결과를 덮어쓰는 데 쓴다.
               */
              const payload = {
                generatedAt: new Date().toISOString(),
                overrides: marks,
                clean: all.filter(p => quality(p.effectId) === "clean").map(p => String(p.effectId)),
                minor: all.filter(p => quality(p.effectId) === "minor").map(p => String(p.effectId)),
                broken: all.filter(p => quality(p.effectId) === "broken").map(p => String(p.effectId)),
              };
              const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = "quality-overrides.json";
              a.click();
              URL.revokeObjectURL(a.href);
            }}>JSON 내보내기</button>
            <button type="button" onClick={() => {
              setMarks({});
              try { localStorage.removeItem("prospi.quality.overrides"); } catch { /* noop */ }
            }}>손수정 비우기</button>
          </div>
        )}
        <p className="fx-count">{shown.length.toLocaleString()}개 표시</p>
        <div className="fx-grid">
          {shown.map(p => <button key={p.effectId}
            className={[p.effectId === active ? "active" : "",
                        quality(p.effectId) === "broken" ? "worst"
                          : quality(p.effectId) === "minor" ? "check" : "",
                        marks[String(p.effectId)] ? "edited" : ""]
                       .filter(Boolean).join(" ")}
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
