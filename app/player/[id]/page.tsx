"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import AnssStage from "../../anss/AnssStage";
import { useAnss } from "../../anss/useAnss";
import { useEffectPool, useKnownMap } from "../../anss/useEffectPool";
import { MATCH_LABEL, effectCandidates, resolveEffect } from "../../anss/resolve";
import { FX_CARD_FILL, fxCanvasFor, fxScaleFor } from "../../anss/types";
import { APTITUDE_LABEL, type Card, type Pitch } from "../../search";
import { PLAYER_NOTE, PLAYER_REV } from "../../anss/version";
import { useRefStatsForId } from "../../refStats";
import { Grade, GradeMark, grade } from "../../grade";
import { Skills } from "../../skills";
import { Trajectory } from "../../trajectory";
import { LangSwitch, ThemeSwitch, useT } from "../../i18n";


/**
 * 이펙트 캔버스 = 원본 기준 화면(640×1136 논리단위)을 카드 배율로 옮긴 크기.
 *
 * [확인된 사실] GetBaseScreenWidth = 0x280(640), GetBaseScreenHeight = 0x470(1136).
 * [문제] 이전에는 캔버스를 760×900 px 로 넉넉히 잡았는데, 카드 배율 0.82 에서
 *   그것은 927×1098 논리단위다 — 기준 화면 640 보다 넓다. 화면을 덮도록 만든
 *   불투명 판(1152055 의 bg_base 768, black_2 768, black_3 640)이 캔버스를 못
 *   덮어 판의 사각 경계가 그대로 드러났다.
 * [처리] 캔버스를 정확히 기준 화면 크기로 맞춘다. 640 폭 판은 딱 맞게 덮고,
 *   카드 틀(420 px)보다는 여전히 넓어 바깥으로 번지는 연출도 살아 있다.
 */
const CARD_FRAME_H = 541;
const FX_SCALE = fxScaleFor(CARD_FRAME_H);
/** 이펙트만 키우는 실효 배율. 카드는 cardArtScale 역수로 되돌려 크기를 유지한다. */
const FX_FILL_SCALE = FX_SCALE * FX_CARD_FILL;


const meet = (card: Card) => card.base ? Math.round((card.base.meetR + card.base.meetL) / 2) : undefined;
const maxPitchPower = (card: Card) => card.pitching?.pitches.reduce((best, pitch) => Math.max(best, pitch.power), 0);
const imageUrl = (card: Card) => `/api/card-image?group=${card.group}&file=${encodeURIComponent(card.largeFile)}`;

/**
 * 능력 한 칸. 막대는 뺐다 — 0~100 스케일이 게임 표기와 맞지 않아
 * 길이가 정보를 주지 않고 숫자만 가린다는 지적을 반영.
 */
function StatCell({ label, value, suffix }: { label: string; value?: number; suffix?: string }) {
  const known = value != null;
  return <div className="scell" data-grade={known && !suffix ? grade(value) : undefined}>
    <span>{label}</span>
    <b>{known ? `${value}${suffix ?? ""}` : "—"}</b>
    {known && !suffix ? <Grade value={value}/> : <em className="grade grade-none"/>}
  </div>;
}

function StatRow({ label, value, suffix, floor = 0, ceil = 100 }:
  { label: string; value?: number; suffix?: string; floor?: number; ceil?: number }) {
  const known = value != null;
  const showGrade = known && !suffix;
  const fill = known ? Math.max(0, Math.min(100, ((value - floor) / (ceil - floor)) * 100)) : 0;
  return <div className="stat-row" data-grade={showGrade ? grade(value) : undefined}>
    <span className="stat-label">{label}</span>
    <span className="stat-bar"><i style={{ width: `${fill}%` }} /></span>
    <b className="stat-value">{known ? `${value}${suffix ?? ""}` : "—"}</b>
    <Grade value={showGrade ? value : null}/>
  </div>;
}

/**
 * Break chart. The app's ledger keeps twelve pitch slots: six break directions
 * (→ ↘ ↓ ↙ ← and straight) in two groups, so `direction % 6` is the direction
 * and `direction / 6` the group. Ray length is the recorded break level.
 */
const ANGLES: Record<number, number | null> = { 0: 180, 1: 135, 2: 90, 3: 45, 4: 0, 5: null };
function BreakChart({ pitches }: { pitches: Pitch[] }) {
  const rays = pitches.filter(pitch => ANGLES[pitch.direction % 6] != null);
  const straight = pitches.filter(pitch => ANGLES[pitch.direction % 6] == null);
  // Break directions fan downward from the release point, so the hub sits high.
  const cx = 110, cy = 22, reach = 84;
  return <div className="break-chart">
    <svg viewBox="0 0 220 114" role="img" aria-label="구종 변화 방향 도표">
      {[0, 45, 90, 135, 180].map(angle => {
        const rad = (angle * Math.PI) / 180;
        return <line key={angle} className="guide" x1={cx} y1={cy}
          x2={cx + Math.cos(rad) * reach} y2={cy + Math.sin(rad) * reach} />;
      })}
      {rays.map((pitch, index) => {
        const rad = (ANGLES[pitch.direction % 6]! * Math.PI) / 180;
        const len = 24 + Math.min(pitch.level, 7) * 9;
        return <line key={`${pitch.direction}-${index}`} className={`ray group-${Math.floor(pitch.direction / 6)}`}
          x1={cx} y1={cy} x2={cx + Math.cos(rad) * len} y2={cy + Math.sin(rad) * len} strokeWidth={4} />;
      })}
      <circle className="hub" cx={cx} cy={cy} r={straight.length ? 7 : 4} />
    </svg>
    <ul className="break-legend">
      {pitches.map((pitch, index) => <li key={`${pitch.direction}-${pitch.kind}-${index}`}>
        <i>{pitch.arrow}</i><span>{pitch.name || "오리지널"}</span>
        <Grade value={pitch.power}/>
        <b>{pitch.level ? "■".repeat(pitch.level) : "—"}</b>
        <small>{pitch.speed}km/h</small>
      </li>)}
    </ul>
  </div>;
}

/**
 * 인게임식 구종 차트 (game8 카드 페이지의 캡처와 같은 표현).
 * 공에서 변화 방향으로 세그먼트 바(변화량 = 칠해진 칸 수)가 뻗고,
 * 끝에 구종 라벨 + 랭크 메달 + 구속을 단다. ● 는 스트레이트로 공 위에 단다.
 * 방향 0~5 = 제1구종 세트, 6~11 = 제2구종 세트 (12방향 원장).
 */
const FAN_DIR: Record<number, [number, number]> = {
  0: [-1, 0], 1: [-0.72, 0.72], 2: [0, 1], 3: [0.72, 0.72], 4: [1, 0],
};

function PitchFan({ pitches, title }: { pitches: Pitch[]; title: string }) {
  const W = 480, H = 348, BX = 240, BY = 96, R0 = 40, SEG = 15, GAP = 3, SLOTS = 7;
  const breaks = pitches.filter(x => (x.direction % 6) !== 5);
  const straights = pitches.filter(x => (x.direction % 6) === 5);
  const maxLv = Math.max(0, ...breaks.map(x => x.level));
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const label = (cx: number, cy: number, pitch: Pitch, key: string) => {
    const w = Math.max(96, pitch.name.length * 13 + 34);
    const x = clamp(cx - w / 2, 6, W - w - 6);
    return <g key={key}>
      <rect x={x} y={cy} width={w} height={27} rx={7} fill="#14181f" stroke="#434b5e" strokeWidth={1.4}/>
      <text x={x + w / 2} y={cy + 18} textAnchor="middle" fontSize={13} fontWeight={800} fill="#f2f4f8">{pitch.name}</text>
      <GradeMark value={pitch.power} x={x + w - 3} y={cy + 2} size={24}/>
      <rect x={x + w / 2 - 44} y={cy + 31} width={88} height={20} rx={5} fill="#0d1015"/>
      <text x={x + w / 2} y={cy + 45} textAnchor="middle" fontSize={12} fontWeight={800} fill="#ffd977">{pitch.speed} km/h</text>
    </g>;
  };

  return <div className="pitch-fan">
    <p className="pf-title">{title}</p>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
      {/* 변화 방향 바 */}
      {breaks.map((x, i) => {
        const [dx, dy] = FAN_DIR[x.direction % 6] ?? [0, 1];
        const hot = x.level === maxLv && maxLv > 0;
        const segs = Array.from({ length: SLOTS }, (_, k) => {
          const d = R0 + k * (SEG + GAP);
          const cx = BX + dx * d, cy = BY + dy * d;
          const ang = Math.atan2(dy, dx) * 180 / Math.PI;
          const on = k < x.level;
          return <rect key={k} x={-SEG / 2} y={-6} width={SEG} height={12} rx={3}
            transform={`translate(${cx},${cy}) rotate(${ang})`}
            fill={on ? (hot ? "#ff5f8a" : (k % 2 ? "#ffd977" : "#f5b52e")) : "#262c3a"}/>;
        });
        const end = R0 + SLOTS * (SEG + GAP) + 12;
        const lx = BX + dx * end, ly = BY + dy * end;
        return <g key={i}>{segs}{label(lx, dy > 0.2 ? ly : ly - 14, x, `l${i}`)}</g>;
      })}
      {/* 공 */}
      <circle cx={BX} cy={BY} r={24} fill="#f5f6f8" stroke="#c9cdd6" strokeWidth={1.5}/>
      <path d={`M ${BX - 17} ${BY - 15} q 10 15 0 30`} fill="none" stroke="#d0483f" strokeWidth={2.2}/>
      <path d={`M ${BX + 17} ${BY - 15} q -10 15 0 30`} fill="none" stroke="#d0483f" strokeWidth={2.2}/>
      {/* 스트레이트 (공 위) */}
      {straights.map((x, i) => label(BX, 8 + i * 58, x, `s${i}`))}
    </svg>
  </div>;
}

export default

function PlayerPage() {
  const params = useParams<{ id: string }>();
  const [card, setCard] = useState<Card | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    fetch(`/data/card-shards/${params.id.slice(0, 2)}.json`).then(response => response.json()).then((cards: Card[]) => {
      const found = cards.find(item => item.id === params.id);
      if (found) setCard(found); else setMissing(true);
    }).catch(() => setMissing(true));
  }, [params.id]);

  // 카드 → 배경 이펙트. 훅 순서를 고정하려고 조기 return 앞에서 호출한다.
  const pool = useEffectPool();
  const known = useKnownMap();
  const [picked, setPicked] = useState<string | null>(null);
  // 기본값은 카드 틀에 맞춰 눈으로 맞춘 값이다(원본 규칙이 아니라 표시 설정).
  const [fxScale, setFxScale] = useState(100);   // 카드 아트 기준 배율(541/660) 대비 %
  const [fxX, setFxX] = useState(0);
  const [fxY, setFxY] = useState(0);
  const [fxSpeed, setFxSpeed] = useState(100);       // 원본 30fps 대비 %
  const [fxLight, setFxLight] = useState(100);       // 전체 밝기 %
  const [fxView, setFxView] = useState(150);         // 보이는 범위(캔버스/스테이지) %
  const [mute, setMute] = useState<Set<string>>(new Set());
  useEffect(() => { setPicked(null); }, [card?.id]);
  const match = card && pool.length
    ? resolveEffect(card.group, card.variant, pool, known, card.id) : null;
  const candidates = card && pool.length
    ? effectCandidates(card.group, card.variant, pool, known) : [];
  const effectId = picked ?? match?.effectId ?? null;
  const level = picked
    ? candidates.find(c => c.effectId === picked)?.level ?? "manual"
    : match?.level;
  useEffect(() => { setMute(new Set()); }, [effectId]);
  const noEffect = !picked && match?.level === "none";
  const doc = useAnss(!noEffect && effectId ? Number(effectId) : null);
  const ref = useRefStatsForId(params?.id);
  const { t, tv, ta } = useT();
  // 캔버스는 이펙트마다 다르다. 640x1136 로 고정하면 85% 가 가로로,
  // 31% 가 세로로 잘린다(스테이지 분포 720x1136 350 · 720x1484 208 · 640x1136 102).
  const fxBox = useMemo(
    () => fxCanvasFor(FX_FILL_SCALE, doc?.stageW, doc?.stageH, fxView / 100 / FX_CARD_FILL),
    [doc?.stageW, doc?.stageH, fxView]);

  // 어느 레이어가 원본과 다른지 이름으로 짚기 위한 목록
  const layers = useMemo(() => {
    if (!doc) return [] as { name: string; count: number; add: number }[];
    const m = new Map<string, { name: string; count: number; add: number }>();
    for (const p of doc.parts) {
      if (p.k !== 1) continue;
      const e = m.get(p.n) ?? { name: p.n, count: 0, add: 0 };
      e.count += 1;
      if (p.bl === 2) e.add += 1;
      m.set(p.n, e);
    }
    return [...m.values()].sort((a, b) => b.count - a.count).slice(0, 40);
  }, [doc]);
  const effectStats = useMemo(() => {
    if (!doc) return null;
    return {
      parts: doc.parts.length,
      additive: doc.parts.filter(p => p.bl === 2).length,
      uv: doc.parts.filter(p => p.t.uvx || p.t.uvy || p.t.uvrot || p.t.uvsx || p.t.uvsy).length,
      deform: doc.parts.filter(p => p.xt?.length).length,
      front: doc.parts.filter(p => p.role === "front").length,
    };
  }, [doc]);

  if (!card) return <main className="player-detail-page"><header className="topbar"><a className="brand" href="/"><span className="brand-glyph">P</span><span>PROSPI<br/><b>PLAYER DATA</b></span></a></header><div className="detail-state">{missing ? "선수 카드를 찾을 수 없습니다." : "선수 데이터를 불러오는 중…"}<a href="/">← 목록으로</a></div></main>;

  const pitching = card.pitching;
  return <main className="player-detail-page">
    <header className="topbar">
      <a className="brand" href="/"><span className="brand-glyph">P</span><span>PROSPI<br/><b>PLAYER DATA</b></span></a>
      <a className="back-link" href="/">{t("backToList")}</a>
      <LangSwitch/><ThemeSwitch/>
    </header>
    <section className="detail-page">
      <div className="detail-art">
        <div className="card-frame">
          <span className="fx-layer whole">
            <AnssStage doc={doc} width={fxBox.w} height={fxBox.h}
              scale={FX_FILL_SCALE * (fxScale / 100)}
              cardArtScale={1 / FX_CARD_FILL}
              offsetX={fxX} offsetY={fxY} speed={fxSpeed / 100} intensity={fxLight / 100}
              cardArt={imageUrl(card)} mute={mute}/>
          </span>
          <span className="detail-series">{card.playerType === "pitcher" ? t("tabPitcher") : t("tabBatter")}</span>
          <span className="effect-id-label"><i/> EFFECT {effectId ?? "—"} · {PLAYER_REV}</span>
        </div>
        <div className="card-caption original">
          <span className="cap-strip cap-strip-series"><img src={imageUrl(card)} alt={`${card.year} 시리즈 표기 원본`}/></span>
          <span className="cap-strip cap-strip-name"><img src={imageUrl(card)} alt={`${card.name} 이름 표기 원본`}/></span>
          <span className="cap-meta">{card.year} · VAR {card.variant} · CL ART SLOT 512×660</span>
        </div>

        <details className="fx-dev">
          <summary>
            <span className="fx-dev-title">배경 <b>{effectId ?? "—"}</b></span>
            <span className={`fx-match-level lv-${level ?? "none"}`}>{level ? MATCH_LABEL[level] : "후보 없음"}</span>
            <span className="fx-dev-hint">{t("devTools")}</span>
          </summary>
          <p className="fx-match-why">
            이펙트 id는 <code>group + series + sub + 등급</code> 구조다(682개 파일명 전수 확인).
            그런데 카드 VAR <code>{card.variant}</code>의 앞 2자리가 이펙트 series와 같다는 가설은
            실측 3건에서 전부 틀렸다 — 카드 종류 → series 표가 따로 있고 그 표는 서버에만 있다.
            그래서 실측값이 없는 카드는 <b>미검증 추정</b>으로 표시한다.
          </p>
          {effectStats && <div className="fx-source-stats" aria-label="원본 이펙트 구성">
            <span><b>{effectStats.parts.toLocaleString()}</b>원본 파츠</span>
            <span><b>{effectStats.additive.toLocaleString()}</b>가산 빛</span>
            <span><b>{effectStats.uv.toLocaleString()}</b>UV 애니메이션</span>
            <span><b>{effectStats.deform.toLocaleString()}</b>4모서리 왜곡</span>
            <span><b>{effectStats.front.toLocaleString()}</b>선수 앞 레이어</span>
          </div>}
          <div className="fx-adjust">
            <label>
              <span>크기</span>
              <input type="range" min={20} max={400} step={5} value={fxScale}
                     onChange={e => setFxScale(Number(e.target.value))}/>
              <b>{fxScale}%</b>
            </label>
            <label>
              <span>X</span>
              <input type="range" min={-300} max={300} step={2} value={fxX}
                     onChange={e => setFxX(Number(e.target.value))}/>
              <b>{fxX > 0 ? `+${fxX}` : fxX}px</b>
            </label>
            <label>
              <span>Y</span>
              <input type="range" min={-400} max={400} step={2} value={fxY}
                     onChange={e => setFxY(Number(e.target.value))}/>
              <b>{fxY > 0 ? `+${fxY}` : fxY}px</b>
            </label>
            <label>
              <span>속도</span>
              <input type="range" min={10} max={200} step={5} value={fxSpeed}
                     onChange={e => setFxSpeed(Number(e.target.value))}/>
              <b>{fxSpeed}%</b>
            </label>
            <label>
              <span>밝기</span>
              <input type="range" min={10} max={150} step={5} value={fxLight}
                     onChange={e => setFxLight(Number(e.target.value))}/>
              <b>{fxLight}%</b>
            </label>
            <label>보이는 범위
              <input type="range" min={100} max={250} step={5} value={fxView}
                     onChange={e => setFxView(Number(e.target.value))}/>
              <b>{fxView}%</b>
            </label>
            <p className="fx-adjust-read">
              스테이지 {doc ? `${doc.stageW ?? "?"}×${doc.stageH ?? "?"}` : "—"} ·
              캔버스 {fxBox.w}×{fxBox.h} · 기준 배율 {FX_SCALE.toFixed(3)} · 적용 배율{" "}
              {(FX_SCALE * (fxScale / 100)).toFixed(3)} · 원점 카드중심
              {fxX ? ` X${fxX > 0 ? "+" : ""}${fxX}` : ""}{fxY ? ` Y${fxY > 0 ? "+" : ""}${fxY}` : ""}
              {" · "}fps {Math.round((doc?.fps || 30) * fxSpeed / 100)}
              {" · "}<b>{PLAYER_REV}</b> {PLAYER_NOTE}
              {(fxScale !== 100 || fxX !== -22 || fxY !== 14 || fxSpeed !== 100 || fxLight !== 100 || fxView !== 150) ? (
                <button type="button" onClick={() => {
                  setFxScale(100); setFxX(0); setFxY(0); setFxSpeed(100); setFxLight(100);
                }}>초기화</button>
              ) : null}
            </p>
          </div>
          <div className="fx-pick-id">
            <input type="text" placeholder="ANSS_EF_1201005_L.CHK 또는 1201005"
                   onKeyDown={e => {
                     if (e.key !== "Enter") return;
                     const num = (e.currentTarget.value.match(/\d{6,7}/) || [])[0];
                     if (num && pool.some(k => k.effectId === num)) setPicked(num);
                     else if (num) e.currentTarget.setAttribute("data-bad", "1");
                   }}
                   onChange={e => e.currentTarget.removeAttribute("data-bad")}/>
            <span>파일명에서 숫자만 떼어 그 id를 그대로 적용한다. 재생 가능한 id {pool.length}개</span>
          </div>
          {layers.length > 0 && (
            <div className="fx-layers">
              <p>레이어 {layers.length}종 — 원본과 다른 것을 꺼서 알려 주세요</p>
              <div className="fx-layer-list">
                {layers.map((l: { name: string; count: number; add: number }) => (
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
          {candidates.length > 1 && (
            <select className="fx-match-pick" value={effectId ?? ""}
                    onChange={e => setPicked(e.target.value)}>
              {candidates.slice(0, 60).map(c => (
                <option key={c.effectId} value={c.effectId}>
                  {c.effectId} · {MATCH_LABEL[c.level]} · 등급 {c.rank}
                </option>
              ))}
            </select>
          )}
        </details>
      </div>

      <div className="detail-info">
        <p className="eyebrow">PLAYER DETAIL</p>
        <p className="reading">{card.roman || `IMAGE ${card.id}`}</p>
        <h1>{card.name}</h1>
        <div className="detail-tags">
          <span>{card.year}</span>
          <span>{card.playerType === "pitcher" ? t("pitcherCard") : t("batterCard")}</span>
          {(ref?.trajectory || card.trajectory) &&
            <span className="traj"><Trajectory value={ref?.trajectory ?? card.trajectory}/></span>}
          <span>VAR {card.variant}</span>
          <span className={card.verified ? "ok" : "warn"}>{card.verified ? t("verified") : t("unverified")}</span>
        </div>

        {ref?.max && <>
          <h3>{t("secCardAbility")} <small>{t("secCardAbilitySub")} ({ref.series})</small></h3>
          {/* 좌 3 = 주능력, 우 3 = 수비. 한 덩어리로 본다. */}
          <div className="stat-grid">
            <div className="sgcol">
              {ref.kind === "batter" ? <>
                <StatCell label={t("colMeet")} value={ref.max.meet}/>
                <StatCell label={t("colPower")} value={ref.max.power}/>
                <StatCell label={t("colSpeed")} value={ref.max.speed}/>
              </> : <>
                <StatCell label={t("colVelocity")} value={ref.max.velocity}/>
                <StatCell label={t("colControl")} value={ref.max.control}/>
                <StatCell label={t("colStamina")} value={ref.max.stamina}/>
              </>}
            </div>
            <div className="sgcol">
              <StatCell label={t("colCatch")} value={ref.defense?.catch ?? card.defense?.catching}/>
              <StatCell label={t("colThrow")} value={ref.defense?.throw ?? card.defense?.throwing}/>
              <StatCell label={t("colArm")} value={ref.defense?.arm ?? card.defense?.shoulder}/>
            </div>
          </div>
          <div className="ref-chips">
            <span><b>{t("spirits")}</b><i>{(ref.spirits ?? 0).toLocaleString()}</i></span>
            <span><b>{t("cost")}</b><i>{ref.cost}</i></span>
            {ref.hand && <span><b>{ref.kind === "batter" ? t("bats") : t("throws")}</b><i>{tv(ref.hand)}</i></span>}
            {ref.pos && <span><b>{t("position")}</b><i>{tv(ref.pos)}</i></span>}
            {ref.pitchRanks && <span><b>{t("pitchRanks")}</b><i>{ref.pitchRanks}</i></span>}
          </div>
          {(ref.abilities?.length ?? 0) > 0 && <>
            <h3>{t("secSkills")} <small>{ref.abilities!.length}{t("secSkillsSub")}</small></h3>
            <Skills names={ref.abilities!}/>
          </>}
        </>}
        {card.playerType === "pitcher" && pitching ? <>
          {!ref && <>
            <h3>{t("secPlayerBase")} <small>{t("secPlayerBaseSub")}</small></h3>
            <div className="stat-list scope-player">
              <StatRow label={t("colSpeedKmh")} value={pitching.maxSpeed} suffix="km/h" floor={115} ceil={165}/>
              <StatRow label={t("colStamina")} value={pitching.stamina}/>
            </div>
          </>}
          <h3>{t("secCardAbility")}</h3>
          <div className="stat-list">
            {ref && <StatRow label={t("colSpeedKmh")} value={pitching.maxSpeed} suffix="km/h" floor={115} ceil={165}/>}
            {!ref && <StatRow label={t("colVelocity")} value={maxPitchPower(card)}/>}
            <StatRow label={t("colArm")} value={card.defense?.shoulder}/>
          </div>
          <h3>{t("secPitches")} <small>{pitching.pitches.length} · {t("secPitchesSub")}</small></h3>
          {(() => {
            const s1 = pitching.pitches.filter(x => x.direction < 6);
            const s2 = pitching.pitches.filter(x => x.direction >= 6);
            return <>
              {s1.length > 0 && <PitchFan pitches={s1} title={t("pitch1")}/>}
              {s2.length > 0 && <PitchFan pitches={s2} title={t("pitch2")}/>}
            </>;
          })()}
        </> : <>
          {/*
            타격 3종은 카드가 아니라 **선수** 레코드에서 온다.
            [확인된 사실] 카드가 2장 이상인 타자 676/676(100%)이 미트·파워·주력이
              전 카드 동일하다. 坂本 勇人은 2016~2026 48장 전부 40/53/57 이다.
              반면 포구·송구·어깨는 카드마다 바뀐다(동일한 선수는 22%뿐).
            [근거] tools/generate_site_cards.py 가 base 는 players.csv(선수당 1행),
              defense 는 cards_with_images.csv(카드당 1행)에서 읽는다.
            [해석] 그러므로 이 값을 "이 카드의 타격 능력"으로 표시하면 거짓이다.
              레퍼런스(prospi-a.rakda3.net)의 菊池 2026 미트 A81 에 우리 값은 45 다.
            [처리] 출처를 라벨에 드러낸다. 카드별 타격치는 contents_personal 의
              가변길이 레코드를 해독해야 얻을 수 있다 — docs/DATA-VERIFY.md 참고.
          */}
          {!ref && <>
            <h3>{t("secPlayerBase")} <small>{t("secPlayerBaseSub")}</small></h3>
            <div className="stat-list scope-player">
              <StatRow label={t("colMeet")} value={meet(card)}/>
              <StatRow label={t("colPower")} value={card.base?.power}/>
              <StatRow label={t("colSpeed")} value={card.base?.run}/>
            </div>
          </>}
          {!ref?.max && <>
            <h3>{t("secDefense")}</h3>
            <div className="stat-grid">
              <div className="sgcol">
                <StatCell label={t("colCatch")} value={card.defense?.catching}/>
                <StatCell label={t("colThrow")} value={card.defense?.throwing}/>
                <StatCell label={t("colArm")} value={card.defense?.shoulder}/>
              </div>
            </div>
          </>}
          {card.aptitude && <>
            <h3>{t("secAptitude")} <small>{t("secAptitudeSub")}</small></h3>
            <div className="apt-grid">
              {APTITUDE_LABEL.filter(([k]) => card.aptitude?.[k]).map(([k]) =>
                <span key={k}><b>{ta(k)}</b><Grade value={card.aptitude![k]!}/><i>{card.aptitude![k]}</i></span>)}
            </div>
          </>}
        </>}

        <details className="res-fold">
          <summary>{t("secResources")}</summary>
        <dl>
          <div><dt>PLAYER ID</dt><dd>{card.playerId || "2015 구형 이미지 ID"}</dd></div>
          <div><dt>IMAGE ID</dt><dd>{card.id}</dd></div>
          <div><dt>EFFECT</dt><dd>{effectId ? `ANSS_EF_${effectId}_L.CHK` : "—"}</dd></div>
          <div><dt>THUMBNAIL</dt><dd>{card.file}</dd></div>
          <div><dt>LARGE PHOTO</dt><dd>{card.largeFile}</dd></div>
        </dl>
        </details>
        <div className="proof">
          <span>{card.verified ? "✓" : "△"}</span>
          <p><strong>{card.verified ? "이미지 · 매니페스트 검증 완료" : "CDN 갱신 파일"}</strong><br/>
          이미지와 파일 해시는 앱 매니페스트로 검증했습니다. 배경은 해당 연도 대표 S등급 효과(ANSS_EF)의 원본 스프라이트 셀을 선수 이미지 앞뒤로 나눠 재생합니다.</p>
        </div>
        {!ref && <div className="proof warn">
          <span>!</span>
          <p><strong>능력치 미검증</strong><br/>
          아래 수치는 앱의 선수-시즌 원장(CARDMASTERDATA)에서 온 값으로, 게임이 카드에 표시하는 값과 다를 수 있습니다. 카드별 능력치와 effect_id는 암호화된 <code>RES*.RDB</code>에 있어 아직 해독하지 못했습니다.</p>
        </div>}
      </div>
    </section>
  </main>;
}
