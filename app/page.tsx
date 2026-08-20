"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import OriginalCardEffect, { effectIdForGroup } from "./OriginalCardEffect";

type Ability = { meetR: number; meetL: number; power: number; run: number };
type Defense = { catching: number; throwing: number; shoulder: number; version: number };
type Pitch = { direction: number; arrow: string; kind: number; name: string; power: number; level: number; speed: number };
type Pitching = { maxSpeed: number; stamina: number; pitches: Pitch[] };
type Card = {
  id: string; playerId: string; name: string; roman: string; year: number; group: number;
  variant: string; file: string; largeFile: string; md5: string; size: number; verified: boolean;
  playerType: "batter" | "pitcher"; base: Ability | null; defense: Defense | null; pitching: Pitching | null;
};

const imageUrl = (card: Card, large = false) => `/api/card-image?group=${card.group}&file=${encodeURIComponent(large ? card.largeFile : card.file)}`;
const grade = (value: number) => value >= 80 ? "A" : value >= 70 ? "B" : value >= 60 ? "C" : value >= 50 ? "D" : value >= 40 ? "E" : "F";
const meet = (card: Card) => card.base ? Math.round((card.base.meetR + card.base.meetL) / 2) : undefined;
const maxPitchPower = (card: Card) => card.pitching?.pitches.reduce((best, pitch) => Math.max(best, pitch.power), 0);
const maxPitchLevel = (card: Card) => card.pitching?.pitches.reduce((best, pitch) => Math.max(best, pitch.level), 0);

function Score({ label, value, suffix = "" }: { label: string; value?: number; suffix?: string }) {
  return <span className="score" data-label={label}>{value == null ? "—" : <><b>{value}{suffix}</b>{!suffix && <em>{grade(value)}</em>}</>}</span>;
}

function PlayerRow({ card }: { card: Card }) {
  return <Link className="player-row" href={`/player/${card.id}`}>
    <span className="player-identity"><span className="row-photo"><img loading="lazy" decoding="async" src={imageUrl(card)} alt=""/></span><span><strong>{card.name}</strong><small>{card.roman || `ID ${card.playerId || card.id}`}</small></span></span>
    <span className="series-cell"><b>{card.year}</b><small>{card.variant}</small></span>
    {card.playerType === "batter" ? <><Score label="미트" value={meet(card)}/><Score label="파워" value={card.base?.power}/><Score label="주력" value={card.base?.run}/><Score label="포구" value={card.defense?.catching}/><Score label="송구" value={card.defense?.throwing}/><Score label="어깨" value={card.defense?.shoulder}/></> : <><Score label="최고 구속" value={card.pitching?.maxSpeed} suffix=" km/h"/><Score label="최고 구위" value={maxPitchPower(card)}/><span className="level-cell" data-label="변화량">{"■".repeat(maxPitchLevel(card) || 0) || "—"}</span><Score label="스태미나" value={card.pitching?.stamina}/><span className="pitch-count" data-label="구종">{card.pitching?.pitches.length || 0}구종</span></>}
    <span className="row-arrow">›</span>
  </Link>;
}

export default function Home() {
  const [cards, setCards] = useState<Card[]>([]); const [query, setQuery] = useState(""); const [year, setYear] = useState("전체"); const [variant, setVariant] = useState("전체");
  const [playerType, setPlayerType] = useState<"batter" | "pitcher">("batter"); const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(25);
  useEffect(() => { fetch("/data/cards.json").then(response => response.json()).then(setCards); }, []);
  const years = useMemo(() => ["전체", ...Array.from(new Set(cards.map(card => String(card.year))))], [cards]);
  const variants = useMemo(() => ["전체", ...Array.from(new Set(cards.map(card => card.variant))).sort()], [cards]);
  const filtered = useMemo(() => cards.filter(card => { const needle = query.trim().toLowerCase(); return card.playerType === playerType && (!needle || `${card.name}${card.roman}${card.id}${card.playerId}`.toLowerCase().includes(needle)) && (year === "전체" || String(card.year) === year) && (variant === "전체" || card.variant === variant); }), [cards, query, year, variant, playerType]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize)); const visible = filtered.slice((page - 1) * pageSize, page * pageSize);
  const showcase = cards.find(card => card.group === 12 && card.playerType === "batter") || cards.find(card => card.group === 12) || cards[0];
  const columns = playerType === "batter" ? ["선수", "시리즈", "미트", "파워", "주력", "포구", "송구", "어깨", ""] : ["선수", "시리즈", "최고 구속", "최고 구위", "변화량", "스태미나", "구종", ""];
  return <main><header className="topbar"><a className="brand" href="#top"><span className="brand-glyph">P</span><span>PROSPI<br/><b>PLAYER DATA</b></span></a><nav><a className="active" href="#players">선수 목록</a><a href="#about">추출 정보</a></nav><div className="live"><span/> APP DATA · 2026</div></header>
    <section className="hero" id="top"><div><p className="eyebrow">PROFESSIONAL BASEBALL SPIRITS A</p><h1>모든 시리즈를<br/><em>한 번에.</em></h1><p className="hero-copy">앱에서 직접 추출한 선수 이미지와 카드별 능력 데이터를<br/>시리즈에 맞춰 연결한 선수 데이터베이스.</p></div><div className="hero-stats"><div><strong>{cards.length ? cards.length.toLocaleString() : "…"}</strong><span>전체 카드</span></div><div><strong>{cards.filter(card => card.playerType === "pitcher").length.toLocaleString()}</strong><span>투수 카드</span></div><div><strong>30,588</strong><span>이미지 리소스</span></div></div></section>
    <section className="effect-showcase" id="effects"><div className="effect-demo"><OriginalCardEffect group={12}/>{showcase && <img className="effect-player" src={imageUrl(showcase, true)} alt={`${showcase.name} 카드 효과 미리보기`}/>}<span className="effect-live"><i/> ANIMATION LIVE</span></div><div className="effect-copy"><p className="eyebrow">ORIGINAL ANIMSS EFFECT</p><h2>원본 배경 효과를<br/><em>움직이는 카드로.</em></h2><p>앱에서 추출한 불꽃·광원·입자 텍스처를 여러 레이어로 재생합니다. 선수 상세 화면에서는 해당 연도의 대표 원본 효과가 자동으로 표시됩니다.</p><dl><div><dt>현재 효과</dt><dd>ANSS_EF_{effectIdForGroup(12)}_L.CHK</dd></div><div><dt>원본 구성</dt><dd>19 TEXTURES · 41 LOOP MARKERS</dd></div></dl></div></section>
    <section className="finder" id="players"><div className="type-tabs"><button className={playerType === "batter" ? "active" : ""} onClick={() => { setPlayerType("batter"); setPage(1); }}>타자</button><button className={playerType === "pitcher" ? "active" : ""} onClick={() => { setPlayerType("pitcher"); setPage(1); }}>투수</button></div><div className="searchbox"><span>⌕</span><input value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="선수명 · PLAYER ID · IMAGE ID 검색" aria-label="선수 검색"/></div><div className="select-row"><label>시리즈<select value={year} onChange={event => { setYear(event.target.value); setPage(1); }}>{years.map(item => <option key={item}>{item}</option>)}</select></label><label>이미지 변형<select value={variant} onChange={event => { setVariant(event.target.value); setPage(1); }}>{variants.map(item => <option key={item}>{item}</option>)}</select></label><label>페이지당<select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}><option>25</option><option>50</option><option>100</option></select></label><button onClick={() => { setQuery(""); setYear("전체"); setVariant("전체"); setPage(1); }}>필터 초기화</button></div></section>
    <section className="results-head"><div><span className="section-index">01</span><h2>{playerType === "pitcher" ? "투수" : "타자"} 카드 목록</h2><span className="count">{filtered.length.toLocaleString()}</span></div><p>{filtered.length ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, filtered.length)} 표시` : "데이터 불러오는 중"}</p></section>
    <section className={`player-table ${playerType}`}><div className="table-head">{columns.map((column, index) => <span key={`${column}-${index}`}>{column}</span>)}</div>{visible.map(card => <PlayerRow card={card} key={`${card.group}-${card.file}`}/>)}</section>
    <div className="pagination"><button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>← 이전</button><span><b>{page}</b> / {pages.toLocaleString()}</span><button disabled={page >= pages} onClick={() => setPage(value => value + 1)}>다음 →</button></div>
    <section className="pipeline" id="about"><div><span className="section-index">02</span><h2>추출 범위</h2></div><div className="pipeline-grid"><div><b>01</b><span>15,222개 카드</span><p>전 시리즈 이미지와 선수 ID 연결</p></div><div><b>02</b><span>카드 유형 분리</span><p>투수와 타자를 카드 원장 기준으로 구분</p></div><div><b>03</b><span>12방향 구종</span><p>구종·구위·변화량·구속을 원장값으로 해독</p></div><div><b>04</b><span>지연 로딩</span><p>현재 페이지의 작은 선수 이미지만 로드</p></div></div></section>
    <footer><div className="brand mini"><span className="brand-glyph">P</span><span>PROSPI <b>PLAYER DATA</b></span></div><p>Unofficial archive · locally extracted app resources</p><span>BUILD 2026.08.20</span></footer></main>;
}
