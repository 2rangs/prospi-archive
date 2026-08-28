"use client";
import { loadCards } from "./cardsData";

import { useEffect, useMemo, useState } from "react";
import AnssStage from "./anss/AnssStage";
import { useAnss } from "./anss/useAnss";
import { type KnownMeta, useEffectPool, useKnownMap, useKnownMeta } from "./anss/useEffectPool";
import { type EffectKey, type ResolveOpts, cardKind, resolveEffect } from "./anss/resolve";
import { type Card, type PlayerGroup, type PlayerType, type StatKey,
  BATTER_STATS, DEFENSE_STATS, PITCHER_STATS, searchPlayers, seriesKind, teamLabel, typeCounts } from "./search";
import { GRADES } from "./grade";
import { LangSwitch, ThemeSwitch, useT } from "./i18n";
import { HeroStage } from "./heroStage";
import { TRAJECTORY_ORDER, TrajArrow, Trajectory, trajColor } from "./trajectory";
import { useScrollRestore, useUrlState } from "./useUrlState";
import { type RefStats, useRefStats } from "./refStats";
import { preloadTiles, useEffectFrontTile, useEffectTile } from "./anss/thumb";

/**
 * 메인 미리보기 카드. 실측 매핑이 있는 카드를 써서, 보여주는 이펙트가
 * 추정이 아니라 확인된 조합이 되게 한다.
 *   1139455100 (大谷 翔平 · 2025 · variant 5100) → ANSS_EF_1152055_L.CHK
 */
/** 메인 쇼케이스 카드와 그 배경. 사용자가 지정한 조합. */
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
import { Grade } from "./grade";
import { teamOf } from "./teams";

/** URL 에 콤마로 실린 다중 선택 값을 배열로. */
const list = (v: unknown) => String(v ?? "").split(",").filter(Boolean);

const imageUrl = (card: Card, large = false) => `/api/card-image?group=${card.group}&file=${encodeURIComponent(large ? card.largeFile : card.file)}`;
const meet = (card: Card) => card.base ? Math.round((card.base.meetR + card.base.meetL) / 2) : undefined;
const maxPitchPower = (card: Card) => card.pitching?.pitches.reduce((best, pitch) => Math.max(best, pitch.power ?? 0), 0);

/** 구단 배지 — 게임 원본 로고(SELECT2220 스프라이트에서 추출). */
function TeamBadge({ code }: { code?: string | null }) {
  const t = teamOf(code);
  if (!t) return null;
  return <em className={`team-badge ${t.league}`} title={t.name}>
    {/* 12종 176KB 뿐이고 행마다 재사용 — lazy 는 팝인만 만든다 */}
    <img src={t.icon} alt={t.name} width={96} height={96} decoding="async"/>
  </em>;
}

/** 행의 1순위 소속 정보. 팀명은 ID보다 먼저 읽히게 하고 ID는 보조로 내린다. */
function PlayerMeta({ team, fallback }: { team?: string | null; fallback: string }) {
  const { t, tv } = useT();
  return <small className="player-meta">
    <TeamBadge code={team}/>
    <span className="team-name">{team ? tv(teamLabel(team)) : t("teamUnknown")}</span>
    <span className="player-id">{fallback}</span>
  </small>;
}

function Score({ label, value, suffix = "" }: { label: string; value?: number; suffix?: string }) {
  // 없는 값은 굵은 대시 대신 흐린 점 — 빈칸이 눈에 덜 밟히게.
  return <span className="score" data-label={label}>{value == null ? <i className="score-none">·</i> : <><b>{value}{suffix}</b>{!suffix && <Grade value={value}/>}</>}</span>;
}

/**
 * 매칭 문맥 — 종류 코드와 소속 리그. 둘 다 표기값(ref)에서 온다.
 * (group, variant) 만으로는 SL1/SL2/SL3 가 안 갈리고, BEST NINE·TITLE HOLDER 의
 * sub 는 리그로 갈린다.
 */
function ctxOf(card: Card, ref: { series?: string; team?: string } | null | undefined,
               meta: KnownMeta): ResolveOpts {
  return { kind: cardKind(ref?.series), league: teamOf(ref?.team ?? "")?.league ?? null, meta };
}

/** 카드 → 이펙트 id (훅 아님 — 목록에서 map 안에서도 안전하게 쓴다) */
function rowEffectId(card: Card, pool: EffectKey[], known: Record<string, string>,
                     opts?: ResolveOpts) {
  if (!pool.length) return null;
  const m = resolveEffect(card.group, card.variant, pool, known, card.id, opts);
  return m && m.level !== "none" ? Number(m.effectId) : null;
}

function NameStrip({ card }: { card: Card }) {
  const name = card.iconName || card.name.split(/[\s\u3000]/)[0] || card.name;
  const length = Array.from(name).length;
  return <i className={`rp-name${length === 2 ? " two-glyph" : ""}${length === 3 ? " three-glyph" : ""}${length >= 6 ? " long" : ""}`} aria-hidden>{name}</i>;
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
  const fxFrontRef = useEffectFrontTile(effectId);
  return <span className="row-photo">
    {effectId != null && <canvas className="rp-fx" ref={fxRef} aria-hidden/>}
    {/*
      선수 사진은 **즉시** 싣는다.
      [문제] 이 이미지는 lazy 였는데, 같은 행의 이름 띠(CL 아틀라스 512x1024,
        약 131KB)는 eager 였다. 순서가 거꾸로라 스크롤 중에 배경 이펙트와 이름만
        뜨고 선수가 비는 구간이 생긴다 — "에셋이 적용 안 되고 배경만 날것으로
        노출"되는 것처럼 보인다.
      [근거] 목록은 한 번에 25행만 그린다(페이지 단위). CS 사진은 20~30KB 이라
        25장 다 실어도 600KB 남짓이고, 이미 eager 인 이름 띠(3.3MB)보다 훨씬 가볍다.
      [처리] eager + fetchPriority high 로 사진이 먼저 오게 한다.
    */}
    {/*
      [문제] 사용자 보고 "선수가 no image 로 들어간다".
        스켈레톤(게임 기본 마스코트)을 **이펙트 캔버스**의 data-ready 로만
        걷었는데, 카드 아트는 배경이 투명한 컷아웃이라 뒤에 깔린 마스코트가
        그대로 비친다. 게다가 화면 밖 행은 이펙트를 그리지 않으므로(r68 가시
        영역 렌더링) data-ready 가 영영 안 붙어 25/25 행에서 마스코트가 남았다.
      [처리] 사진이 뜨는 순간 행에 data-loaded 를 달아 스켈레톤을 없앤다.
        캐시로 이미 로드된 경우( load 이벤트가 안 오는 경우 )도 ref 에서 처리.
    */}
    <img className="rp-art" loading="eager" fetchPriority="high" decoding="async"
      ref={el => { if (el?.complete && el.naturalWidth > 0) el.closest(".row-photo")?.setAttribute("data-loaded", "1"); }}
      onLoad={e => e.currentTarget.closest(".row-photo")?.setAttribute("data-loaded", "1")}
      onError={e => e.currentTarget.closest(".row-photo")?.setAttribute("data-loaded", "1")}
      src={imageUrl(card)} alt=""/>
    {/* 사인·로고 등 front 파츠는 인게임처럼 사진 **위**에 얹는다 */}
    {effectId != null && <canvas className="rp-fx rp-fx-front" ref={fxFrontRef} aria-hidden/>}
    <NameStrip card={card}/>
  </span>;
}


function PlayerRow({ card, nested = false, ref: refStats, effectId }: { card: Card; nested?: boolean; ref?: RefStats | null; effectId?: number | null }) {
  return <a className={`player-row${nested ? " card-row" : ""}`} href={`/player/${card.id}`}>
    <span className="player-identity"><RowIcon card={card} effectId={effectId ?? null}/><span><strong>{card.name}</strong><PlayerMeta team={refStats?.team} fallback={card.roman || `ID ${card.playerId || card.id}`}/></span></span>
    {/* 카드 시즌 종류 — rakda3 표기(2026S1 · 2015SP(侍) · OB 등). 없으면 연도. */}
    <span className="series-cell"><b>{refStats?.series ?? card.year}</b><small>VAR {card.variant}</small></span>
    <StatCells card={card} ref={refStats}/>
    <span className="row-arrow">›</span>
  </a>;
}

/**
 * 능력 셀. 카드별 표기값(ref, prospi-a.rakda3.net)이 있으면 그것을 쓴다 —
 * 선수워드 기본값은 카드 능력이 아니라는 게 검증됐기 때문(docs/DATA-VERIFY.md).
 */
/**
 * 능력 칸 — 모든 탭 공통 배치 (사용자 지정):
 *   [탄도(타자) | 구속(투수)] · [윗줄 = 스텟 / 아랫줄 = 특수능력] 한 칸.
 * 없는 값은 나열하지 않고 생략한다. 스피리츠는 시리즈 옆 고정.
 */
function StatCells({ card, ref }: { card: Card; ref?: RefStats | null }) {
  const { t } = useT();
  const isBatter = card.playerType === "batter";
  const bm = ref?.kind === "batter" ? ref.max : undefined;
  const pm = ref?.kind === "pitcher" ? ref.max : undefined;
  // 수비 포지션은 스피리츠 옆 배지로 — 이름 밑 작은 칩은 안 보인다는 지적 반영
  const spirits = <span className="score spirits" data-label={t("colSpirits")}>
    {ref?.pos && <em className="pos-badge">{ref.pos}</em>}
    <span className="sp-value"><small>{t("spiritsInline")}</small>{ref?.spirits != null ? <b>{ref.spirits.toLocaleString()}</b> : <i className="score-none">·</i>}</span></span>;
  const lead = isBatter
    ? <span className="lead-cell batter-lead"><Trajectory value={ref?.trajectory ?? card.trajectory}/></span>
    : <span className="lead-cell speed" data-label={t("colSpeedKmh")}>
        <span>{card.pitching?.maxSpeed != null ? <><b>{card.pitching.maxSpeed}</b><small>km/h</small></> : <i className="score-none">·</i>}</span>
        {card.pitching?.pitches.length ? <em>{card.pitching.pitches.length} {t("pitchCount")}</em> : null}
      </span>;
  const pairs: [string, number][] = (isBatter
    ? [[t("colMeet"), bm?.meet ?? meet(card)], [t("colPower"), bm?.power ?? card.base?.power], [t("colSpeed"), bm?.speed ?? card.base?.run]]
    : [[t("colVelocity"), pm?.velocity ?? maxPitchPower(card)], [t("colControl"), pm?.control], [t("colStamina"), pm?.stamina ?? card.pitching?.stamina],
       ]
  ).filter((pair): pair is [string, number] => pair[1] != null);
  const repeated = new Set<number>();
  for (const [, value] of pairs) {
    if (pairs.filter(([, other]) => other === value).length >= 2) repeated.add(value);
  }
  const skills = (ref?.abilities ?? []).slice(0, 3);
  return <>{spirits}{lead}
    <span className="stat-stack" data-label={t("colStats")}>
      <span className="stat-line">
        {pairs.length
          ? pairs.map(([k, v]) => <span key={String(k)} className={`stat-item${repeated.has(v) ? " same-value" : ""}`}>
              <small>{k}</small><b>{v}</b>
              {/* 인게임 등급 아이콘 — 능력치 스케일 값에만 (구종 개수엔 없음) */}
              {k !== t("colPitches") && typeof v === "number" && <Grade value={v} size={15}/>}
            </span>)
          : <i className="stat-none">{t("noStats")}</i>}
      </span>
      {skills.length > 0 && <span className="skill-line">
        {skills.map(a => <em key={a}>{a}</em>)}
      </span>}
    </span></>;
}

/**
 * 선수 한 명(한 유형)을 한 줄로. 대표는 가장 최신 카드다.
 * "ohtani" 50건이 이 방식으로 4줄이 된다.
 */
/**
 * 그룹의 대표 카드 = 그 선수의 **최고 스피리츠 카드**.
 *
 * [문제] 행은 이 카드를 그리는데 프리로드는 `group.cards[0]`(=최신 카드)를
 *   받고 있었다. 둘이 다른 카드라 이미지가 두 장씩 요청되고(실측 25행에서
 *   44건), 정작 화면에 나올 이미지는 게이트가 열린 뒤에 도착했다 — "에셋을
 *   다 받고 열어 달라"던 요구가 반쯤만 지켜지던 원인.
 * [처리] 행과 프리로드가 같은 함수를 쓴다.
 */
function repCard(group: PlayerGroup, refAll: Record<string, RefStats> | null): Card {
  let best: Card | null = null; let bestS = -1;
  for (const c of group.cards) {
    const sp = refAll?.[c.id]?.spirits;
    if (sp != null && sp > bestS) { best = c; bestS = sp; }
  }
  return best ?? group.cards.find(c => refAll?.[c.id]) ?? group.rep;
}

function PlayerGroupRow({ group, open, onToggle, showType, refAll, pool, known, knownMeta }:
    { group: PlayerGroup; open: boolean; onToggle: () => void; showType: boolean;
      refAll: Record<string, RefStats> | null; pool: EffectKey[];
      known: Record<string, string>; knownMeta: KnownMeta }) {
  const { t, tv } = useT();
  const top = repCard(group, refAll);
  /**
   * 그룹 요약은 대표 카드 하나가 아니라 **그룹 전체에서 값을 모아** 채운다.
   * 대표 카드에 스피리츠·제구 같은 필드가 비어 있어도 다른 카드에 있으면
   * 그 값을 쓴다(스피리츠는 최대값 = 그 선수의 최고 카드). 빈칸 지적 반영.
   */
  const topRef = (() => {
    const base = refAll?.[top.id] ? { ...refAll[top.id] } : null;
    if (!refAll) return base;
    let merged = base;
    for (const c of group.cards) {
      const r = refAll[c.id];
      if (!r) continue;
      if (!merged) { merged = { ...r }; continue; }
      if (r.spirits != null && (merged.spirits == null || r.spirits > merged.spirits)) merged.spirits = r.spirits;
      if (!merged.series && r.series) merged.series = r.series;
      if (!merged.trajectory && r.trajectory) merged.trajectory = r.trajectory;
      if ((!merged.abilities || !merged.abilities.length) && r.abilities?.length) merged.abilities = r.abilities;
      if (!merged.pos && r.pos) merged.pos = r.pos;
      if (!merged.team && r.team) merged.team = r.team;
      if (r.max && merged.max) {
        for (const k of Object.keys(r.max) as (keyof typeof r.max)[]) {
          if (merged.max[k] == null && r.max[k] != null) merged.max[k] = r.max[k];
        }
      } else if (r.max && !merged.max) merged.max = { ...r.max };
    }
    return merged;
  })();
  const topEffect = rowEffectId(top, pool, known, ctxOf(top, refAll?.[top.id], knownMeta));
  const many = group.cards.length > 1;
  const span = group.minYear === group.maxYear ? `${group.maxYear}` : `${group.minYear}–${group.maxYear}`;
  return <>
    <div className={`player-row group-row${open ? " open" : ""}`}
         role={many ? "button" : "link"} tabIndex={0}
         onClick={many ? onToggle : () => window.location.assign(`/player/${top.id}`)}
         onKeyDown={e => {
           if (e.key !== "Enter" && e.key !== " ") return;
           e.preventDefault();
           if (many) onToggle(); else window.location.assign(`/player/${top.id}`);
         }}>
      <span className="player-identity">
        <RowIcon card={top} effectId={topEffect}/>
        <span>
          <strong>{group.name}</strong>
          <small className="player-meta">
            {showType && <em className={`type-chip ${group.playerType}`}>{t(group.playerType === "pitcher" ? "tabPitcher" : "tabBatter")}</em>}
            <TeamBadge code={topRef?.team}/>
            <span className="team-name">{topRef?.team ? tv(teamLabel(topRef.team)) : t("teamUnknown")}</span>
            <span className="player-id">{group.roman || `ID ${group.playerId || top.id}`}</span>
          </small>
        </span>
      </span>
      <span className="series-cell"><b>{span}</b><small>{topRef?.series ? `${topRef.series} ${t("other")} ` : ""}{group.cards.length}{t("cardsUnit")} · {group.variants}{t("variantsUnit")}</small></span>
      <StatCells card={top} ref={topRef}/>
      <span className="row-arrow">{many ? (open ? "▾" : "▸") : <a href={`/player/${top.id}`} onClick={e => e.stopPropagation()}>›</a>}</span>
    </div>
    {open && <div className="group-cards">
      <div className="group-cards-head">
        <span><b>{group.name}</b> · {t(group.playerType === "pitcher" ? "tabPitcher" : "tabBatter")} · {group.cards.length}{t("cardsUnit")}</span>
        <span className="gch-span">{span} · 변형 {group.variants}종</span>
      </div>
      {group.cards.map(card => <PlayerRow card={card} nested ref={refAll?.[card.id] ?? null} effectId={rowEffectId(card, pool, known, ctxOf(card, refAll?.[card.id], knownMeta))} key={`${card.group}-${card.file}`}/>)}
    </div>}
  </>;
}

export default function Home() {
  const { t, tv } = useT();
  const layoutMode = typeof window !== "undefined"
    && new URLSearchParams(location.search).get("layout") === "1";
  const [cards, setCards] = useState<Card[]>([]);
  const [ui, setUi] = useUrlState({ q: "", type: "all", year: "전체", var: "전체",
    team: "", kind: "", half: "전체", sp: "전체", spirits: 0, traj: "", st: "", eq: "", page: 1, size: 25, open: "" });
  const query = ui.q, year = ui.year, variant = ui.var, page = ui.page, pageSize = ui.size;
  const playerType = ui.type as PlayerType | "all";
  const openKey = ui.open;
  useEffect(() => { void loadCards().then(rows => { if (rows) setCards(rows); }); }, []);
  useScrollRestore("home", cards.length > 0);
  const refAll = useRefStats();
  const years = useMemo(() => ["전체", ...Array.from(new Set(cards.map(card => String(card.year))))], [cards]);
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
    team: list(ui.team), kind: list(ui.kind), half: ui.half, special: ui.sp,
    spiritsMin: Number(ui.spirits) || 0, trajectory: list(ui.traj), stats, equalStats: ui.eq === "1",
  }), [query, playerType, year, variant, ui.team, ui.kind, ui.half, ui.sp, ui.spirits, ui.traj, ui.eq, stats]);
  const groups = useMemo(() => searchPlayers(cards, f, refAll), [cards, f, refAll]);
  const counts = useMemo(() => typeCounts(cards, f, refAll), [cards, f, refAll]);
  const teams = useMemo(() => {
    if (!refAll) return [] as string[];
    const c = new Map<string, number>();
    for (const r of Object.values(refAll)) if (r.team) c.set(r.team, (c.get(r.team) ?? 0) + 1);
    return [...c.keys()].sort((a, b) => (c.get(b) ?? 0) - (c.get(a) ?? 0));
  }, [refAll]);
  /**
   * 종류 칩 목록. 원장에 실제로 있는 계열만, 장수 많은 순.
   * 게임 라벨 아틀라스(연도 · Series · 종류)의 세 번째 축이다.
   */
  const kinds = useMemo(() => {
    if (!refAll) return [] as [string, number][];
    const c = new Map<string, number>();
    for (const r of Object.values(refAll)) {
      const k = seriesKind(r.series);
      if (k) c.set(k, (c.get(k) ?? 0) + 1);
    }
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [refAll]);
  const activeCount = (year !== "전체" ? 1 : 0) + (variant !== "전체" ? 1 : 0)
    + list(ui.team).length + list(ui.kind).length + (ui.half !== "전체" ? 1 : 0) + (ui.sp !== "전체" ? 1 : 0)
    + (Number(ui.spirits) > 0 ? 1 : 0) + list(ui.traj).length + Object.keys(stats).length + (ui.eq === "1" ? 1 : 0);
  /** 칩 토글 — 이미 켜져 있으면 끈다. */
  const toggle = (field: "team" | "traj" | "kind", v: string) => {
    const cur = list(ui[field]);
    const next = cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v];
    setUi({ [field]: next.join(","), page: 1, open: "" });
  };
  const cardTotal = useMemo(() => groups.reduce((n, g) => n + g.cards.length, 0), [groups]);
  const pages = Math.max(1, Math.ceil(groups.length / pageSize));
  const safePage = Math.min(page, pages);
  const visible = groups.slice((safePage - 1) * pageSize, safePage * pageSize);
  const pool = useEffectPool();
  /** 배너 배경 이펙트 — 사용자가 지정한 1182205. */
  const heroDoc = useAnss(Number(SHOWCASE_EFFECT));
  const known = useKnownMap();
  const knownMeta = useKnownMeta();

  /**
   * 검색·페이지 이동 결과를 **에셋이 다 준비된 뒤에** 보여 준다.
   *
   * [문제] 행이 먼저 그려지고 아이콘이 하나씩 뒤늦게 튀어나왔다.
   *   목록이 완성된 화면으로 보이지 않는다는 지적.
   * [처리] 이번 페이지에 필요한 것을 먼저 다 받아 두고 그동안 로딩 표시를 낸다:
   *   (1) 선수 아이콘 이미지(카드 아트) (2) 아이콘에 쓰이는 이펙트 문서·텍스처.
   *   [_L 배경 이펙트는 제외] 그건 상세 화면에서만 쓰고 한 장이 평균 231KB·
   *   최대 1.4MB 라, 25행치를 미리 받으면 목록이 오히려 한참 멈춘다.
   *   문서 캐시 상한도 _L 은 6개다.
   * [안전] 카드 목록 자체가 아직 없거나(pool 미도착) 프리로드가 실패해도
   *   화면이 막히지 않도록, 실패·빈 목록이면 즉시 통과시킨다.
   */
  const wantKey = useMemo(
    () => visible.map(g => {
      const c = repCard(g, refAll);
      return `${c.id}:${rowEffectId(c, pool, known, ctxOf(c, refAll?.[c.id], knownMeta)) ?? 0}`;
    }).join(","),
    [visible, pool, known, refAll, knownMeta]);
  const [tilesFor, setTilesFor] = useState<string | null>(null);
  useEffect(() => {
    if (!visible.length) { setTilesFor(wantKey); return; }
    let alive = true;
    const entries = wantKey.split(",").filter(Boolean).map(t => t.split(":"));
    const ids = entries.map(e => Number(e[1])).filter(n => n > 0);
    /**
     * 선수 아이콘 이미지도 같이 받는다 — 이것도 늦게 도착해 하나씩 튀어나온다.
     *
     * [문제] 여기서 받던 것은 **CL(대형)** 인데 행이 그리는 것은 `imageUrl(card)`
     *   = **CS(소형)** 이다. 그래서 한 행이 이미지를 두 장 받았고, 그중 큰 쪽은
     *   화면에 한 번도 쓰이지 않았다. 실측: CL 평균 185KB · CS 평균 25KB —
     *   25행 한 페이지에서 4.6MB 가 버려지고, 로딩 게이트도 그만큼 늦게 열렸다.
     * [처리] 행이 그리는 것과 **같은 URL** 을 예열한다. 카드 id 가 곧 파일명이라
     *   `CS{id}.CHK` 로 만들 수 있다(전 15,222장 형식 동일).
     */
    const arts = entries.map(e => e[0]).filter(Boolean).map(id => new Promise<void>(done => {
      const im = new Image();
      im.onload = () => done(); im.onerror = () => done();
      im.src = `/api/card-image?group=${Number(id.length === 9 ? id.slice(0, 1) : id.slice(0, 2))}&file=${encodeURIComponent(`CS${id}.CHK`)}`;
    }));
    if (!ids.length && !arts.length) { setTilesFor(wantKey); return; }
    Promise.all([preloadTiles(ids).catch(() => undefined), ...arts])
      .then(() => { if (alive) setTilesFor(wantKey); });
    return () => { alive = false; };
  }, [wantKey, visible.length]);
  const tilesReady = tilesFor === wantKey;
  // 모든 탭 공통 열 (사용자 지정 배치): 선수 · 시리즈 · 스피리츠 · 탄도/구속 · 능력+스킬
  const leadCol = playerType === "pitcher" ? t("colSpeedKmh")
    : playerType === "batter" ? t("colTraj") : t("colTrajSpeed");
  const columns = [t("colPlayer"), t("colSeries"), t("colSpirits"), leadCol, t("colStats"), ""];
  const tableKind = playerType;
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
            q: "", year: "전체", var: "전체", team: "", kind: "", half: "전체", sp: "전체",
            spirits: 0, traj: "", st: "", eq: "", page: 1, open: "" }); }}>{t("filterReset")}</button>}
        </summary>

        {teams.length > 0 && <div className="frow">
          <b>{t("fTeam")}</b>
          <div className="chips">
            {teams.map(t => {
              const on = list(ui.team).includes(t);
              return <button key={t} className={`team-filter${on ? " on" : ""}`}
                onClick={() => toggle("team", t)} title={teamOf(t)?.name ?? t} aria-pressed={on}>
                <TeamBadge code={t}/><span>{tv(teamLabel(t))}</span>
              </button>;
            })}
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

        {kinds.length > 0 && <div className="frow">
          <b>{t("fKind")}</b>
          <div className="chips kind-chips">
            {kinds.map(([k, n]) => {
              const on = list(ui.kind).includes(k);
              return <button key={k} className={on ? "on" : ""} aria-pressed={on}
                onClick={() => toggle("kind", k)}><span>{k === "覚" ? t("fAwaken") : k}</span><i>{n}</i></button>;
            })}
          </div>
        </div>}

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

        <div className="frow equal-filter-row">
          <b>{t("fStats")}</b>
          <div className="chips">
            <button className={`equal-filter${ui.eq === "1" ? " on" : ""}`}
              aria-pressed={ui.eq === "1"}
              onClick={() => setUi({ eq: ui.eq === "1" ? "" : "1", page: 1, open: "" })}>
              <span>{t("equalStatsOn")}</span>
            </button>
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
          <span>{t("noteRefFilter").replace("{n}", refAll ? Object.keys(refAll).length.toLocaleString() : "…")}</span>
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
        ? t("resultSummary").replace("{p}", groups.length.toLocaleString()).replace("{c}", cardTotal.toLocaleString())
            .replace("{a}", String(groups.length ? (safePage - 1) * pageSize + 1 : 0)).replace("{b}", String(Math.min(safePage * pageSize, groups.length)))
        : t("loading")}</p>
    </section>
    <section className={`player-table ${tableKind}`}>
      <div className="table-head">{columns.map((column, index) => <span key={`${column}-${index}`}>{column}</span>)}</div>
      {!tilesReady && visible.length > 0 &&
        <p className="table-loading" role="status">{t("loading")}</p>}
      {tilesReady && visible.map(group => <PlayerGroupRow key={group.key} group={group} refAll={refAll} pool={pool} known={known} knownMeta={knownMeta}
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
