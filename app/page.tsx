"use client";

import { useEffect, useMemo, useState } from "react";
import AnssStage from "./anss/AnssStage";
import { useAnss } from "./anss/useAnss";
import { useEffectPool, useKnownMap } from "./anss/useEffectPool";
import { type EffectKey, MATCH_LABEL, resolveEffect } from "./anss/resolve";
import { fxCanvasFor, fxScaleFor } from "./anss/types";
import { type Card, type PlayerGroup, type PlayerType, type StatKey,
  BATTER_STATS, DEFENSE_STATS, PITCHER_STATS, parseSeries, searchPlayers, teamLabel, typeCounts } from "./search";
import { GRADES } from "./grade";
import { LangSwitch, ThemeSwitch, useT } from "./i18n";
import { HeroStage } from "./heroStage";
import { TRAJECTORY_ORDER, TrajArrow, Trajectory, trajColor } from "./trajectory";
import { useScrollRestore, useUrlState } from "./useUrlState";
import { type RefStats, useRefStats } from "./refStats";
import { useEffectTile } from "./anss/thumb";
import { useNameInk } from "./anss/nameStrip";

/**
 * 메인 미리보기 카드. 실측 매핑이 있는 카드를 써서, 보여주는 이펙트가
 * 추정이 아니라 확인된 조합이 되게 한다.
 *   1139455100 (大谷 翔平 · 2025 · variant 5100) → ANSS_EF_1152055_L.CHK
 */
/** 메인 쇼케이스 카드와 그 배경. 사용자가 지정한 조합. */
const SHOWCASE_ID = "1160013200";
const SHOWCASE_EFFECT = "1182205";
/** 배너 이펙트 캔버스. 스테이지 720x1136 을 가로로 눕혀 배너를 덮는다. */
const HERO_SCALE = 0.84;
/**
 * 배너 캔버스 크기. AnssStage 는 인라인 style 로 캔버스 크기를 못박으므로
 * CSS 로 줄일 수 없다 — **props 로 박스에 맞는 크기를 넘겨야** 한다.
 * 실측: scale 0.95 에서 내용이 752x692px 였다 -> 논리 약 791x728.
 * scale 0.66 이면 522x481 이라 아래 박스(560x800) 안에 들어온다.
 */
const HERO_FX = { w: 620, h: 640 };
/** 캔버스 = 기준 화면 640×1136 을 카드 배율로 옮긴 크기 (상세 페이지와 동일) */
const FX_SCALE = fxScaleFor(541);
const FX_W = fxCanvasFor(FX_SCALE).w;
const FX_H = fxCanvasFor(FX_SCALE).h;
import { Grade } from "./grade";

/** URL 에 콤마로 실린 다중 선택 값을 배열로. */
const list = (v: unknown) => String(v ?? "").split(",").filter(Boolean);

const imageUrl = (card: Card, large = false) => `/api/card-image?group=${card.group}&file=${encodeURIComponent(large ? card.largeFile : card.file)}`;
const meet = (card: Card) => card.base ? Math.round((card.base.meetR + card.base.meetL) / 2) : undefined;
const maxPitchPower = (card: Card) => card.pitching?.pitches.reduce((best, pitch) => Math.max(best, pitch.power), 0);
const maxPitchLevel = (card: Card) => card.pitching?.pitches.reduce((best, pitch) => Math.max(best, pitch.level), 0);

function Score({ label, value, suffix = "" }: { label: string; value?: number; suffix?: string }) {
  return <span className="score" data-label={label}>{value == null ? "—" : <><b>{value}{suffix}</b>{!suffix && <Grade value={value}/>}</>}</span>;
}

/** 카드 → 이펙트 id (훅 아님 — 목록에서 map 안에서도 안전하게 쓴다) */
function rowEffectId(card: Card, pool: EffectKey[], known: Record<string, string>) {
  if (!pool.length) return null;
  const m = resolveEffect(card.group, card.variant, pool, known, card.id);
  return m && m.level !== "none" ? Number(m.effectId) : null;
}

/**
 * 이름 띠. 카드마다 잰 잉크 상자를 기준으로 크롭해 **가운데 정렬**한다.
 * 아직 못 쟀으면 아무것도 그리지 않는다(치우친 채 잠깐 보이는 것보다 낫다).
 */
function NameStrip({ card }: { card: Card }) {
  const url = imageUrl(card, true);
  const ink = useNameInk(card.id, url);
  if (!ink) return null;
  /**
   * 인게임 목록은 성만 보여주지만 여기서는 **이름 전체**를 보여준다.
   * (성만 자르는 규칙은 useNameInk 의 sx1 로 언제든 되살릴 수 있다.)
   */
  const inkW = ink.x1 - ink.x0;
  const pad = 8;
  const bx = Math.max(0, ink.x0 - pad);
  const bw = Math.min(512 - bx, inkW + pad * 2);
  const by = Math.max(0, ink.y0 - 4);
  const bh = ink.y1 - ink.y0 + 8;
  /**
   * 밴드 크기. 아이콘이 정사각이라 폭 % 와 높이 % 를 그대로 비교할 수 있다.
   * 기준 높이 18% · 폭 상한 82%. 이름판 높이(27/128 = 21%)에 딱 맞추면 글자가
   * 판을 꽉 채워 답답해서 한 단계 줄였다. 이름이 길면 그 높이로 잡은 폭이
   * 아이콘을 넘으므로 폭에서 막고 높이를 함께 줄인다.
   */
  const ar = bw / bh;
  const wPct = Math.min(82, 18 * ar);
  const hPct = wPct / ar;
  // 컨테이너 폭 = bw 로 보고 배율을 잡는다. margin 의 % 는 컨테이너 폭 기준.
  const pc = (v: number) => `${(v / bw) * 100}%`;
  return <i className="rp-name" aria-hidden style={{ width: `${wPct}%`, height: `${hPct}%` }}>
    <img decoding="async" src={url} alt=""
      style={{ width: pc(512), marginLeft: pc(-bx), marginTop: pc(-by) }}/>
  </i>;
}

/**
 * 목록 아이콘.
 *
 * [구성] 뒤 = 매칭된 이펙트의 대표 프레임(공유 오프스크린에서 구움),
 *   가운데 = 선수 이미지 **전체**(자르지 않는다 · object-fit: contain),
 *   아래 = 아틀라스의 인게임 이름 타이포 띠(512x1024 중 y 896~988).
 */
function RowIcon({ card, effectId }: { card: Card; effectId: number | null }) {
  const fxRef = useEffectTile(effectId);
  return <span className="row-photo">
    {effectId != null && <canvas className="rp-fx" ref={fxRef} aria-hidden/>}
    <img className="rp-art" loading="lazy" decoding="async" src={imageUrl(card)} alt=""/>
    <NameStrip card={card}/>
  </span>;
}


function PlayerRow({ card, nested = false, ref: refStats, effectId }: { card: Card; nested?: boolean; ref?: RefStats | null; effectId?: number | null }) {
  return <a className={`player-row${nested ? " card-row" : ""}`} href={`/player/${card.id}`}>
    <span className="player-identity"><RowIcon card={card} effectId={effectId ?? null}/><span><strong>{card.name}</strong><small>{card.roman || `ID ${card.playerId || card.id}`}</small></span></span>
    <span className="series-cell"><b>{card.year}</b><small>VAR {card.variant}</small></span>
    <StatCells card={card} ref={refStats}/>
    <span className="row-arrow">›</span>
  </a>;
}

/**
 * 능력 셀. 카드별 표기값(ref, prospi-a.rakda3.net)이 있으면 그것을 쓴다 —
 * 선수워드 기본값은 카드 능력이 아니라는 게 검증됐기 때문(docs/DATA-VERIFY.md).
 */
function StatCells({ card, ref }: { card: Card; ref?: RefStats | null }) {
  const { t } = useT();
  if (card.playerType === "batter") {
    const m = ref?.max;
    // 표기값이 있으면 그것을 쓴다 — 원장에 없는 グラウンダー가 여기에만 있다.
    return <><Trajectory value={ref?.trajectory ?? card.trajectory}/>
      <Score label={t("colMeet")} value={m?.meet ?? meet(card)}/><Score label={t("colPower")} value={m?.power ?? card.base?.power}/><Score label={t("colSpeed")} value={m?.speed ?? card.base?.run}/><Score label={t("colCatch")} value={card.defense?.catching}/><Score label={t("colThrow")} value={card.defense?.throwing}/><Score label={t("colArm")} value={card.defense?.shoulder}/></>;
  }
  const m = ref?.kind === "pitcher" ? ref.max : undefined;
  return <><Score label={t("colSpeedKmh")} value={card.pitching?.maxSpeed} suffix=" km/h"/><Score label={t("colVelocity")} value={m?.velocity ?? maxPitchPower(card)}/><Score label={t("colControl")} value={m?.control}/><Score label={t("colStamina")} value={m?.stamina ?? card.pitching?.stamina}/><span className="pitch-count" data-label={t("colPitches")}>{card.pitching?.pitches.length || 0}</span></>;
}

/**
 * 선수 한 명(한 유형)을 한 줄로. 대표는 가장 최신 카드다.
 * "ohtani" 50건이 이 방식으로 4줄이 된다.
 */
function PlayerGroupRow({ group, open, onToggle, showType, refAll, pool, known }:
    { group: PlayerGroup; open: boolean; onToggle: () => void; showType: boolean;
      refAll: Record<string, RefStats> | null; pool: EffectKey[]; known: Record<string, string> }) {
  // 표기값(ref)이 있는 카드를 대표로 우선한다 — cards 는 연도 내림차순
  const top = group.cards.find(c => refAll?.[c.id]) ?? group.rep;
  const topRef = refAll?.[top.id] ?? null;
  const topEffect = rowEffectId(top, pool, known);
  const many = group.cards.length > 1;
  const span = group.minYear === group.maxYear ? `${group.maxYear}` : `${group.minYear}–${group.maxYear}`;
  return <>
    <div className={`player-row group-row${open ? " open" : ""}`}
         role="button" tabIndex={0}
         onClick={many ? onToggle : undefined}
         onKeyDown={e => { if (many && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onToggle(); } }}>
      <span className="player-identity">
        <RowIcon card={top} effectId={topEffect}/>
        <span>
          <strong>{group.name}</strong>
          <small>
            {showType && <em className={`type-chip ${group.playerType}`}>{group.playerType === "pitcher" ? "투수" : "타자"}</em>}
            {group.roman || `ID ${group.playerId || top.id}`}
          </small>
        </span>
      </span>
      <span className="series-cell"><b>{span}</b><small>{group.cards.length}장 · 변형 {group.variants}</small></span>
      <StatCells card={top} ref={topRef}/>
      <span className="row-arrow">{many ? (open ? "▾" : "▸") : <a href={`/player/${top.id}`} onClick={e => e.stopPropagation()}>›</a>}</span>
    </div>
    {open && <div className="group-cards">
      <div className="group-cards-head">
        <span><b>{group.name}</b> {group.playerType === "pitcher" ? "투수" : "타자"} 카드 {group.cards.length}장</span>
        <span className="gch-span">{span} · 변형 {group.variants}종</span>
      </div>
      {group.cards.map(card => <PlayerRow card={card} nested ref={refAll?.[card.id] ?? null} effectId={rowEffectId(card, pool, known)} key={`${card.group}-${card.file}`}/>)}
    </div>}
  </>;
}

export default function Home() {
  const { t, tv } = useT();
  const layoutMode = typeof window !== "undefined"
    && new URLSearchParams(location.search).get("layout") === "1";
  const [cards, setCards] = useState<Card[]>([]);
  const [ui, setUi] = useUrlState({ q: "", type: "all", year: "전체", var: "전체",
    team: "", half: "전체", sp: "전체", spirits: 0, traj: "", st: "", page: 1, size: 25, open: "" });
  const query = ui.q, year = ui.year, variant = ui.var, page = ui.page, pageSize = ui.size;
  const playerType = ui.type as PlayerType | "all";
  const openKey = ui.open;
  useEffect(() => { fetch("/data/cards.json").then(response => response.json()).then(setCards); }, []);
  useScrollRestore("home", cards.length > 0);
  const refAll = useRefStats();
  const years = useMemo(() => ["전체", ...Array.from(new Set(cards.map(card => String(card.year))))], [cards]);
  const variants = useMemo(() => ["전체", ...Array.from(new Set(cards.map(card => card.variant))).sort()], [cards]);
  /** URL 에는 "meet80,power70" 한 줄로 싣는다. */
  const stats = useMemo(() => {
    const out: Partial<Record<StatKey, number>> = {};
    for (const part of String(ui.st).split(",")) {
      const m = /^([a-z]+)(\d+)$/.exec(part);
      if (m) out[m[1] as StatKey] = Number(m[2]);
    }
    return out;
  }, [ui.st]);
  const setStat = (k: StatKey, v: number) => {
    const next = { ...stats };
    if (v > 0) next[k] = v; else delete next[k];
    setUi({ st: Object.entries(next).map(([a, b]) => `${a}${b}`).join(","), page: 1, open: "" });
  };
  const f = useMemo(() => ({
    query, playerType, year, variant,
    team: list(ui.team), half: ui.half, special: ui.sp,
    spiritsMin: Number(ui.spirits) || 0, trajectory: list(ui.traj), stats,
  }), [query, playerType, year, variant, ui.team, ui.half, ui.sp, ui.spirits, ui.traj, stats]);
  const groups = useMemo(() => searchPlayers(cards, f, refAll), [cards, f, refAll]);
  const counts = useMemo(() => typeCounts(cards, f, refAll), [cards, f, refAll]);
  const teams = useMemo(() => {
    if (!refAll) return [] as string[];
    const c = new Map<string, number>();
    for (const r of Object.values(refAll)) if (r.team) c.set(r.team, (c.get(r.team) ?? 0) + 1);
    return [...c.keys()].sort((a, b) => (c.get(b) ?? 0) - (c.get(a) ?? 0));
  }, [refAll]);
  const activeCount = (year !== "전체" ? 1 : 0) + (variant !== "전체" ? 1 : 0)
    + list(ui.team).length + (ui.half !== "전체" ? 1 : 0) + (ui.sp !== "전체" ? 1 : 0)
    + (Number(ui.spirits) > 0 ? 1 : 0) + list(ui.traj).length + Object.keys(stats).length;
  /** 칩 토글 — 이미 켜져 있으면 끈다. */
  const toggle = (field: "team" | "traj", v: string) => {
    const cur = list(ui[field]);
    const next = cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v];
    setUi({ [field]: next.join(","), page: 1, open: "" });
  };
  const cardTotal = useMemo(() => groups.reduce((n, g) => n + g.cards.length, 0), [groups]);
  const pages = Math.max(1, Math.ceil(groups.length / pageSize));
  const safePage = Math.min(page, pages);
  const visible = groups.slice((safePage - 1) * pageSize, safePage * pageSize);
  const showcase = cards.find(card => card.id === SHOWCASE_ID)
    || cards.find(card => card.group === 12 && card.playerType === "batter")
    || cards[0];
  const pool = useEffectPool();
  /** 배너 배경 이펙트 — 사용자가 지정한 1182205. */
  const heroDoc = useAnss(Number(SHOWCASE_EFFECT));
  const known = useKnownMap();
  // 쇼케이스는 배경을 고정한다 — 추정 규칙과 무관하게 지정한 것을 쓴다.
  const showMatch = showcase && pool.length
    ? (pool.some(e => e.effectId === SHOWCASE_EFFECT)
        ? { effectId: SHOWCASE_EFFECT, level: "known" as const,
            rank: pool.find(e => e.effectId === SHOWCASE_EFFECT)?.rank ?? 5 }
        : resolveEffect(showcase.group, showcase.variant, pool, known, showcase.id))
    : null;
  const showDoc = useAnss(
    showMatch && showMatch.level !== "none" ? Number(showMatch.effectId) : null);
  const columns = playerType === "pitcher"
    ? [t("colPlayer"), t("colSeries"), t("colSpeedKmh"), t("colVelocity"), t("colControl"), t("colStamina"), t("colPitches"), ""]
    : [t("colPlayer"), t("colSeries"), t("colTraj"), t("colMeet"), t("colPower"), t("colSpeed"), t("colCatch"), t("colThrow"), t("colArm"), ""];
  // 전체 탭은 타자/투수가 섞이므로 능력 칸 폭을 타자 기준으로 맞춘다
  const tableKind = playerType === "pitcher" ? "pitcher" : "batter";
  return <main><header className="topbar"><a className="brand" href="#top"><span className="brand-glyph">P</span><span>PROSPI<br/><b>{t("brandSub")}</b></span></a><nav><a className="active" href="#players">{t("navPlayers")}</a><a href="/effects">{t("navEffects")}</a><a href="#about">{t("navAbout")}</a></nav><div className="live"><span/> APP DATA · 2026</div><LangSwitch/><ThemeSwitch/></header>
    <section className="hero" id="top">
      {/* 배너 배경 = 카드 배경 이펙트. 원래 있던 거대한 "A" 글자를 대신한다. */}
      {/*
        배너 구성 — 에디토리얼 포스터.
        [뒤] 이펙트를 눕혀 가로 광원 띠로 깔고
        [중] 선수 컷아웃을 오른쪽에서 아래로 흘려 판을 벗어나게 두고
        [앞] 큰 제목이 인물과 겹치게 한다. 겹침이 깊이를 만든다.
      */}
      {/* 배너 인물 2인. ?layout=1 로 열면 화면에서 직접 구도를 잡을 수 있다. */}
      <HeroStage layout={layoutMode}
        src={id => `/api/card-image?group=${Number(id.length === 9 ? id.slice(0, 1) : id.slice(0, 2))}&file=${encodeURIComponent(`CL${id}.CHK`)}`}/>
      {/*
        오른쪽 = 선수 + 배경 이펙트를 **한 캔버스에서** 합성한다.
        따로 얹으면 좌표계가 달라 중심이 어긋난다(이전에 캐릭터가
        광원 옆에 붙어 보이던 문제). 게임과 같은 방식으로 한 번에 그린다.
      */}
      <span className="hero-media" aria-hidden>
        {heroDoc && <AnssStage doc={heroDoc} width={HERO_FX.w} height={HERO_FX.h}
          scale={HERO_SCALE} originY={0.5} speed={1}
          cardArt={`/api/card-image?group=8&file=${encodeURIComponent("CL814762700.CHK")}`}/>}
      </span>
      <div className="hero-copyblock">
        <p className="eyebrow"><i/>{t("heroEyebrow")}</p>
        <h1><span>PROSPI</span><span>ARCHIVE</span></h1>
        <p className="hero-tagline">{t("siteTagline")}</p>
        <a className="hero-cta" href="#players">
          {t("ctaBrowse")}
          <b>{cards.length ? cards.length.toLocaleString() : "…"}</b>
          <i>{t("ctaCount")}</i>
        </a>
      </div>
      {/* 세로 라벨 — 판의 오른쪽 끝을 잡아 주는 장치 */}
      <span className="hero-edge" aria-hidden>2015 &mdash; 2026 / CARD ARCHIVE</span>
      {/* 통계는 배너 바닥을 가로지르는 레일로 */}
      <div className="hero-rail">
        <div><strong>{cards.length ? cards.length.toLocaleString() : "…"}</strong><span>{t("statAllCards")}</span></div>
        <div><strong>{cards.filter(c => c.playerType === "pitcher").length.toLocaleString()}</strong><span>{t("statPitcherCards")}</span></div>
        <div><strong>30,588</strong><span>{t("statImages")}</span></div>
        <div><strong>12</strong><span>{t("fTeam")}</span></div>
      </div>
    </section>
    
    <section className="finder" id="players">
      <div className="type-tabs">
        {([["all", t("tabAll"), counts.all], ["batter", t("tabBatter"), counts.batter], ["pitcher", t("tabPitcher"), counts.pitcher]] as const).map(([key, label, n]) =>
          <button key={key} className={playerType === key ? "active" : ""}
                  onClick={() => setUi({ type: key, page: 1, open: "" })}>
            {label}<em>{n.toLocaleString()}</em>
          </button>)}
      </div>
      <div className="searchbox"><span>⌕</span><input value={query}
        onChange={event => setUi({ q: event.target.value, page: 1, open: "" })}
        placeholder={t("searchPlaceholder")} aria-label={t("searchPlaceholder")}/>
        {query && <button className="clear-q" onClick={() => setUi({ q: "", page: 1, open: "" })} aria-label={t("searchClear")}>×</button>}
      </div>
      <details className="filters" open>
        <summary>
          <span>{t("filters")}</span>
          {activeCount > 0 && <em>{activeCount}</em>}
          {activeCount > 0 && <button className="fb-reset" onClick={e => { e.preventDefault(); setUi({
            q: "", year: "전체", var: "전체", team: "", half: "전체", sp: "전체",
            spirits: 0, traj: "", st: "", page: 1, open: "" }); }}>전체 해제</button>}
        </summary>

        {teams.length > 0 && <div className="frow">
          <b>{t("fTeam")}</b>
          <div className="chips">
            {teams.map(t => <button key={t} className={list(ui.team).includes(t) ? "on" : ""}
              onClick={() => toggle("team", t)} title={t}>{tv(teamLabel(t))}</button>)}
          </div>
        </div>}

        {playerType !== "pitcher" && <div className="frow">
          <b>{t("fTraj")}</b>
          <div className="chips traj-chips">
            {TRAJECTORY_ORDER.map(t => {
              const on = list(ui.traj).includes(t);
              return <button key={t} className={on ? "on" : ""} onClick={() => toggle("traj", t)}
                style={on ? { borderColor: trajColor(t), background: `${trajColor(t)}22` } : undefined}>
                <TrajArrow value={t} size={16}/><span>{t}</span></button>;
            })}
          </div>
        </div>}

        <div className="frow">
          <b>{t("fYear")}</b>
          <div className="chips">
            {years.map(y => <button key={y} className={year === y ? "on" : ""}
              onClick={() => setUi({ year: y, page: 1, open: "" })}>{y === "전체" ? t("fAll") : y}</button>)}
          </div>
        </div>

        <div className="frow">
          <b>{t("fSeries")}</b>
          <div className="segs">
            {[[t("fAll"), t("fAll")], ["S1", "S1"], ["S2", "S2"]].map(([v, l]) =>
              <button key={v} className={ui.half === v ? "on" : ""}
                onClick={() => setUi({ half: v, page: 1, open: "" })}>{l}</button>)}
          </div>
          <div className="segs">
            {[["전체", t("fAll")], ["normal", t("fNormal")], ["sp", t("fSpecial")]].map(([v, l]) =>
              <button key={v} className={ui.sp === v ? "on" : ""}
                onClick={() => setUi({ sp: v, page: 1, open: "" })}>{l}</button>)}
          </div>
        </div>

        <div className="frow">
          <b>{t("fSpirits")}</b>
          <div className="segs">
            {[0, 3000, 3500, 4000, 4500, 5000, 5200].map(v =>
              <button key={v} className={Number(ui.spirits) === v ? "on" : ""}
                onClick={() => setUi({ spirits: v, page: 1, open: "" })}>{v ? `${v}+` : t("fAll")}</button>)}
          </div>
        </div>

        <div className="frow">
          <b>{t("fStats")}</b>
          <div className="stat-filter">
            {(playerType === "pitcher" ? PITCHER_STATS
              : playerType === "batter" ? BATTER_STATS
              : [...BATTER_STATS, ...PITCHER_STATS]).concat(DEFENSE_STATS).map(([k, label]) => (
              <label key={k} className={stats[k] ? "on" : ""}>
                <span>{t(label as Parameters<typeof t>[0])}</span>
                <select value={stats[k] ?? 0} onChange={e => setStat(k, Number(e.target.value))}>
                  <option value={0}>{t("fAll")}</option>
                  {GRADES.filter(([floor]) => floor > 0).map(([floor, g]) =>
                    <option key={g} value={floor}>{g}+ ({floor})</option>)}
                </select>
              </label>))}
          </div>
        </div>

        <p className="filter-note">
          팀 · 시리즈 · 스피리츠 · 능력치는 <b>카드 표기값</b>으로 거른다
          (있는 카드 {refAll ? Object.keys(refAll).length.toLocaleString() : "…"}장).
          탄도는 원장 값으로도 걸러 표기값 없는 카드도 남는다.
          <label className="pagesize">{t("perPage")}
            <select value={pageSize} onChange={e => setUi({ size: Number(e.target.value), page: 1 })}>
              <option>25</option><option>50</option><option>100</option></select></label>
        </p>
      </details>
    </section>
    <section className="results-head">
      <div><span className="section-index">01</span>
        <h2>{playerType === "pitcher" ? t("tabPitcher") : playerType === "batter" ? t("tabBatter") : t("resultsAll")} {t("resultsPlayers")}</h2>
        <span className="count">{groups.length.toLocaleString()}</span>
      </div>
      <p>{cards.length
        ? `${groups.length.toLocaleString()}명 · 카드 ${cardTotal.toLocaleString()}장 중 ${groups.length ? (safePage - 1) * pageSize + 1 : 0}–${Math.min(safePage * pageSize, groups.length)}번째 선수 표시`
        : "데이터 불러오는 중"}</p>
    </section>
    <section className={`player-table ${tableKind}`}>
      <div className="table-head">{columns.map((column, index) => <span key={`${column}-${index}`}>{column}</span>)}</div>
      {visible.map(group => <PlayerGroupRow key={group.key} group={group} refAll={refAll} pool={pool} known={known}
        open={openKey === group.key}
        onToggle={() => setUi({ open: openKey === group.key ? "" : group.key })}
        showType={playerType === "all"}/>)}
      {cards.length > 0 && groups.length === 0 &&
        <p className="empty">{t("empty")}</p>}
    </section>
    <div className="pagination">
      <button disabled={safePage <= 1} onClick={() => setUi({ page: safePage - 1, open: "" })}>{t("prev")}</button>
      <span><b>{safePage}</b> / {pages.toLocaleString()}</span>
      <button disabled={safePage >= pages} onClick={() => setUi({ page: safePage + 1, open: "" })}>{t("next")}</button>
    </div>
    
    <footer><div className="brand mini"><span className="brand-glyph">P</span><span>PROSPI <b>PLAYER DATA</b></span></div><p>Unofficial archive · locally extracted app resources</p><span>BUILD 2026.08.20</span></footer></main>;
}
