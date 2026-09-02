"use client";
import { fetchGzipJson } from "../../anss/fetchGzip";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import AnssStage from "../../anss/AnssStage";
import { useAnss } from "../../anss/useAnss";
import { useEffectPool, useKnownMap, useKnownMeta } from "../../anss/useEffectPool";
import { MATCH_LABEL, cardKind, effectCandidates, resolveEffect } from "../../anss/resolve";
import { teamOf } from "../../teams";
import { FX_CARD_FILL, fxCanvasFor, fxScaleFor } from "../../anss/types";
import { APTITUDE_LABEL, type AptitudePos, type Card, type Pitch, teamLabel } from "../../search";
import { PLAYER_NOTE, PLAYER_REV } from "../../anss/version";
import { useRefStatsForId } from "../../refStats";
import { Grade, grade } from "../../grade";
import { PITCH_NAME_JA } from "../../pitchNames";
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
// 레퍼런스로 채운 카드는 power 가 없다(등급 문자만) — 그런 값은 건너뛴다.
const maxPitchPower = (card: Card) =>
  card.pitching?.pitches.reduce((best, pitch) => Math.max(best, pitch.power ?? 0), 0);
const imageUrl = (card: Card) => `/api/card-image?group=${card.group}&file=${encodeURIComponent(card.largeFile)}&v=2`;

/**
 * 타자의 주 수비 포지션 = 守備適性 딕셔너리에서 값이 가장 높은 포지션(투수 제외).
 * [왜 positionName 을 안 쓰나] 카드 마스터의 position(+0x14) 은 신규/조인 불완전
 *   카드에서 0(=투수)으로 잘못 붙는 경우가 있어 타자가 "투수"로 표시됐다.
 *   적성 워드는 선수 레코드에서 직접 뽑은 값이라 더 신뢰할 수 있다.
 * APTITUDE_LABEL 순서(포수→…→우익)대로 훑어 동점이면 앞선(더 안쪽) 포지션을 남긴다.
 */
const primaryFieldPos = (card: Card): AptitudePos | null => {
  const apt = card.aptitude;
  if (!apt) return null;
  let best: AptitudePos | null = null;
  let bestVal = -1;
  for (const [key] of APTITUDE_LABEL) {
    if (key === "pitcher") continue;
    const value = apt[key];
    if (value != null && value > bestVal) { bestVal = value; best = key; }
  }
  return best;
};

/** 원본 수비 화면의 포지션 배치(화면 좌상단 기준 %). */
const DEFENSE_POS: Record<AptitudePos, [number, number]> = {
  pitcher: [50, 57], catcher: [50, 83], first: [72, 57], second: [62, 39],
  third: [28, 57], short: [38, 39], left: [20, 24], center: [50, 15], right: [80, 24],
};

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
 * 인게임 구종 차트 — **원본 좌표계를 그대로 쓴다.**
 *
 * [프레임] 사용자가 준 원본 캡처와 동일한 632x311, 공 중심 (311,133) r=27.
 *   공은 그 캡처에서 잘라 온 원본 파츠다. 그래서 막대/라벨도 캡처에서 잰
 *   값을 1:1 로 쓴다 — 비율을 새로 잡을 이유가 없다.
 * [라벨 위치] 캡처에서 판 5개의 경계상자를 실측했다(모두 136x47):
 *     위      중심( 308, 35)  공기준 (  -2,  -98)
 *     왼쪽    중심( 136,129)  공기준 (-174,   -4)
 *     왼아래  중심( 158,222)  공기준 (-154,  +89)
 *     오른아래중심( 462,222)  공기준 (+152,  +89)
 *     아래    중심( 308,250)  공기준 (  -2, +117)
 *   반지름이 일정하지 않다 — 방향별 고정 오프셋이므로 그대로 표에 넣는다.
 *   오른쪽(→)은 캡처에 없어 왼쪽을 좌우 대칭한 값을 쓴다.
 * [손] 저장된 direction 은 **우완 기준 정본**이다. 카드 5,190장 실측 결과
 *   좌완/우완의 kind별 방향 분포가 같다(예: 슬라이더 kind 4 는 양쪽 다 0).
 *   원본은 `VarietyPitches::GetVarietyPitchesForHander` /
 *   `ReverseVarietyPitchesDirection` 로 표시할 때 뒤집는다. 그래서 좌완이면
 *   0<->4, 1<->3 으로 좌우 반전한다(2 아래·5 직구는 그대로).
 */
const FAN_DIR: Record<number, [number, number]> = {
  0: [-1, 0], 1: [-0.72, 0.72], 2: [0, 1], 3: [0.72, 0.72], 4: [1, 0],
};
/** 방향별 라벨 판 중심 오프셋 (원본 실측). */
const FAN_LABEL: Record<number, [number, number]> = {
  0: [-174, -4], 1: [-154, 89], 2: [-2, 117], 3: [152, 89], 4: [174, -4],
};
/** 좌완 좌우 반전 (5=직구는 그대로). */
const MIRROR_DIR: Record<number, number> = { 0: 4, 1: 3, 2: 2, 3: 1, 4: 0, 5: 5 };

function PitchFan({ pitches, title, lefty, ja }:
  { pitches: Pitch[]; title: string; lefty: boolean; ja: boolean }) {
  /**
   * 변화량 막대 치수 — 원본 캡처 화소 실측.
   *   트랙 시작 R=24 · 칸 피치 7.5 · 칸 길이 5.5 · 칸 폭 15 · 칸 7개
   *   칸 색 켜짐 #d26688(등급색으로 채움) / 꺼짐 #8f9092, 칸 사이는 거의 검정,
   *   각 칸 위 약 40% 가 밝다. 7번째 칸은 바깥으로 뾰족한 화살촉이다.
   */
  // R0 는 **칸이 시작하는 반지름**이다. 24 는 어두운 캡슐 트랙이 시작하는
  // 자리고(공 뒤로 들어간다), 원본에서 첫 칸의 잉크는 y=163 = 반지름 30
  // 부터다. 24 로 두면 첫 칸이 공(r=27)에 가려 안 보인다.
  const W = 632, H = 311, BX = 311, BY = 133, R0 = 30, TRACK0 = 24, SLOTS = 7;
  const PITCH = 7.5, CELL = 5.5, CW = 15;
  const dirOf = (p: Pitch) => (lefty ? MIRROR_DIR[p.direction % 6] : p.direction % 6);
  const nameOf = (p: Pitch) => (ja ? (PITCH_NAME_JA[p.kind] ?? p.name) : p.name);
  const breaks = pitches.filter(x => dirOf(x) !== 5);
  const straights = pitches.filter(x => dirOf(x) === 5);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const movementGrade = (level: number) => ["G", "F", "E", "D", "C", "B", "A", "S"][clamp(level, 0, 7)];
  const movementColors: Record<string, string> = {
    S: "#ffe1f5", A: "#ff9be1", B: "#f56464", C: "#eb7824",
    D: "#f5af1a", E: "#91b445", F: "#5573a5", G: "#5f5a73",
  };

  /**
   * 구종 등급 코인 — 글자가 파인 원형 배지.
   *
   * [원본 확인] 사용자가 준 캡처를 10배로 확대해 보면 `public/grade/*.png`
   *   (글자만 있는 스탯 등급 아이콘)와 **다른 물건**이다. 원형 판에 글자가
   *   어둡게 파여 있고 위쪽에 광택이 있다.
   * [실측 색] 캡처에 있는 두 등급만 잴 수 있었다:
   *     B  밝은부분 #de628c · 중앙 #c4587a   (분홍)
   *     C  밝은부분 #f1a15a · 중앙 #de9148   (주황)
   * [미확인] S·A·D·E·F·G 코인은 이 캡처에 없다. 원본 스프라이트도 지금
   *   확보한 컨테이너(로컬 65개 + 새로 받은 ARSHOWALL1500/ARSPSKILL1820/
   *   GA_UI1850/ALBUM1630, 이미지 647장)에서 찾지 못했다. 색 검색
   *   (#de628c/#f1a15a)으로도 나오지 않았다. 그래서 나머지는 사용자가 준
   *   변화량 팔레트를 임시로 쓴다 — **확정값이 아니다.**
   * [다음 검증] 다른 등급 배지가 보이는 화면 캡처 1장이면 전부 확정된다.
   */
  const COIN: Record<string, string> = {
    B: "#de628c", C: "#f1a15a",                       // 원본 실측
    S: "#ffe1f5", A: "#ff9be1", D: "#f5af1a",         // 미확인 (임시)
    E: "#91b445", F: "#5573a5", G: "#5f5a73",
  };
  const rankCoin = (rank: string | null, cx: number, cy: number) => {
    const r = rank ?? "G";
    return <g>
      <circle cx={cx} cy={cy} r={16} fill="#0a0b0c"/>
      <circle cx={cx} cy={cy} r={14} fill={COIN[r] ?? "#888"} stroke="#08090a" strokeWidth={1.5}/>
      <path d={`M${cx - 11} ${cy - 4} a 11 11 0 0 1 22 0 z`} fill="#fff" opacity={0.22}/>
      <text className="pf-rank" x={cx} y={cy + 6} textAnchor="middle">{r}</text>
    </g>;
  };

  /**
   * 라벨 판 — 원본 실측 136x47, 아래 구속띠 136x27, 등급 코인 r 14.
   *
   * [글자 맞춤] 원본은 판을 넓히지 않는다. **가로로 눌러서** 맞춘다.
   *   캡처 실측(잉크 경계상자):
   *     ストレート(5자)      폭 92  높이 16  → 글자당 18.4
   *     ナックルカーブ(7자)   폭 102 높이 16  → 글자당 14.6
   *     サークルチェンジ(8자) 폭 102 높이 16  → 글자당 12.8
   *   길이가 늘어도 **폭은 102 에서 멈추고 높이는 16 그대로**다. 즉 세로는
   *   두고 가로만 압축한다. SVG 의 textLength + lengthAdjust=spacingAndGlyphs
   *   가 정확히 같은 동작이라 그대로 쓴다. 짧은 이름은 자연폭이라 안 눌린다.
   */
  const PW = 136, PH = 47, SH = 27, TXT_MAX = 102, FS = 18;
  /** 전각(가나·한자·전각영숫자)은 1em, 그 외는 약 0.55em 로 자연폭을 추정. */
  const textW = (t: string) => {
    let u = 0;
    for (const ch of t) u += /[\u3000-\u30ff\u3400-\u9fff\uff00-\uff60]/.test(ch) ? 1 : 0.55;
    return u * FS;
  };
  const label = (cx: number, cy: number, pitch: Pitch, key: string) => {
    const nm = nameOf(pitch);
    const nat = textW(nm);
    const tl = nat > TXT_MAX ? TXT_MAX : undefined;
    const x = clamp(cx - PW / 2, 3, W - PW - 3), y = clamp(cy - PH / 2, 3, H - PH - SH - 3);
    return <g key={key}>
      <rect x={x - 2} y={y - 2} width={PW + 4} height={PH + 4} rx={6} fill="#07090b" stroke="#050607" strokeWidth={2}/>
      <rect x={x} y={y} width={PW} height={PH} rx={5} fill="url(#pitchPlate)" stroke="#d5d7d8" strokeWidth={1.5}/>
      <rect x={x + 3} y={y + 3} width={PW - 6} height={PH - 6} rx={3} fill="none" stroke="#5e6265" strokeWidth={1}/>
      <text className="pf-name" x={x + PW / 2} y={y + PH / 2 + 6} textAnchor="middle"
        style={{ fontSize: FS }} textLength={tl} lengthAdjust={tl ? "spacingAndGlyphs" : undefined}>{nm}</text>
      {rankCoin(pitch.rank ?? (pitch.power != null ? grade(pitch.power) : null), x + PW - 2, y + 2)}
      <rect x={x} y={y + PH + 2} width={PW} height={SH} rx={2} fill="url(#speedPlate)"/>
      <text className="pf-speed" x={x + PW / 2} y={y + PH + 21} textAnchor="middle">{pitch.speed}<tspan style={{ fontSize: 13 }}> km/h</tspan></text>
    </g>;
  };

  // 직구 캡 — 원본은 공 위에 뾰족한 마무리 캡만 둔다.
  // 실측: 공 바깥 R 31, 길이 7, 밑변 14, 윗변 9, 색 (137,130,153)=#898299.
  const CAP_R = 31, CAP_L = 7, CAP_WB = 14, CAP_WT = 9;
  const straightCap = <g transform={`translate(${BX},${BY}) rotate(-90)`}>
    <rect x={CAP_R - 2.5} y={-CAP_WB / 2 - 2.5} width={CAP_L + 5} height={CAP_WB + 5} rx={4} fill="#0b0c0d"/>
    <polygon points={`${CAP_R},${-CAP_WB / 2} ${CAP_R + CAP_L},${-CAP_WT / 2} ${CAP_R + CAP_L},${CAP_WT / 2} ${CAP_R},${CAP_WB / 2}`} fill="#898299"/>
    <rect x={CAP_R} y={-CAP_WB / 2} width={CAP_L * 0.55} height={CAP_WB * 0.4} fill="#fff" opacity={0.2}/>
  </g>;

  return <div className="pitch-fan">
    <p className="pf-title">{title}</p>
    {/* 좌표는 원본 632x311 그대로 두고, **빈 여백만 잘라** 보이는 크기를 키운다.
        내용 최대 범위: x 67..555 (좌우 라벨판), y 9.5..302.5 (직구판~아래 구속띠).
        기하는 하나도 안 바꾸고 뷰박스만 좁히므로 원본 실측값이 그대로 유지된다. */}
    <svg viewBox="63 5 496 302" role="img" aria-label={title}>
      <defs>
        <linearGradient id="pitchPlate" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5a5d60"/><stop offset=".18" stopColor="#282b2e"/><stop offset=".72" stopColor="#1b1e20"/><stop offset="1" stopColor="#3f4244"/>
        </linearGradient>
        <linearGradient id="speedPlate" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#050505"/><stop offset="1" stopColor="#111"/>
        </linearGradient>
        <clipPath id="originalBall"><circle cx={BX} cy={BY} r="27"/></clipPath>
      </defs>
      {/* 변화 방향 바 — 어두운 캡슐 트랙 + 칸 + 끝 화살촉 */}
      {breaks.map((x, i) => {
        const d6 = dirOf(x);
        const [dx, dy] = FAN_DIR[d6] ?? [0, 1];
        const ang = Math.atan2(dy, dx) * 180 / Math.PI;
        const fill = movementColors[movementGrade(x.level)] ?? "#8f9092";
        const track = SLOTS * PITCH;
        const cells = Array.from({ length: SLOTS }, (_, k) => {
          const d = R0 + k * PITCH;
          const c = k < x.level ? fill : "#8f9092";
          const tip = k === SLOTS - 1;
          const shape = tip
            ? <polygon points={`${d},${-CW / 2} ${d + CELL * 0.45},${-CW / 2} ${d + CELL},0 ${d + CELL * 0.45},${CW / 2} ${d},${CW / 2}`} fill={c}/>
            : <rect x={d} y={-CW / 2} width={CELL} height={CW} rx={1} fill={c}/>;
          return <g key={k}>
            {shape}
            <rect x={d} y={-CW / 2} width={tip ? CELL * 0.45 : CELL} height={CW * 0.4} rx={1} fill="#fff" opacity={0.26}/>
          </g>;
        });
        const [ox, oy] = FAN_LABEL[d6] ?? [0, 117];
        return <g key={i}>
          <g transform={`translate(${BX},${BY}) rotate(${ang})`}>
            <rect x={TRACK0} y={-CW / 2 - 2.5} width={R0 - TRACK0 + track + 4} height={CW + 5} rx={(CW + 5) / 2} fill="#0b0c0d"/>
            {cells}
          </g>
          {label(BX + ox, BY + oy, x, `l${i}`)}
        </g>;
      })}
      {straights.length > 0 && straightCap}
      {/* 사용자가 제공한 원본 화면에서 그대로 가져온 야구공 파츠. */}
      <image href="/img/pitch-ui/original-pitch-atlas.png" x={BX - 311} y={BY - 133} width="632" height="311" clipPath="url(#originalBall)"/>
      {/* 직구는 공 위 (원본 실측 오프셋 -2,-98) */}
      {straights.map((x, i) => label(BX - 2, BY - 98 + i * (PH + SH + 8), x, `s${i}`))}
    </svg>
  </div>;
}

export default function PlayerPage() {
  const params = useParams<{ id: string }>();
  const [card, setCard] = useState<Card | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    // 카드 데이터가 갱신되면 브라우저 캐시 때문에 옛 샤드가 그대로 쓰인다.
    // cards.json 과 같은 방식으로 버전 꼬리표를 붙인다(구종 복구 48장, r111).
    fetchGzipJson<Card[]>(`/data/card-shards/${params.id.slice(0, 2)}.json.gz?v=20260831`).then((cards: Card[] | null) => {
      if (!cards) { setMissing(true); return; }
      const found = cards.find(item => item.id === params.id);
      if (found) setCard(found); else setMissing(true);
    }).catch(() => setMissing(true));
  }, [params.id]);

  /**
   * 같은 선수의 다른 버전 — 히어로 옆 세로 레일에서 바로 갈아탄다 (사용자 요청).
   * cards.json 은 홈에서 이미 받는 파일이라 HTTP 캐시로 재사용된다.
   */
  const [versions, setVersions] = useState<Card[]>([]);
  useEffect(() => {
    if (!card?.playerId) { setVersions([]); return; }
    let alive = true;
    fetch("/data/cards.json?v=20260831").then(r => r.json()).then((all: Card[]) => {
      if (!alive) return;
      const list = all.filter(c => c.playerId === card.playerId)
        .sort((a, b) => b.year - a.year || a.variant.localeCompare(b.variant));
      setVersions(list);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [card?.playerId]);

  // 카드 → 배경 이펙트. 훅 순서를 고정하려고 조기 return 앞에서 호출한다.
  const pool = useEffectPool();
  const known = useKnownMap();
  const knownMeta = useKnownMeta();
  // 매칭 문맥(종류·리그)이 표기값에서 오므로 매칭보다 먼저 읽는다.
  const ref = useRefStatsForId(params?.id);
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
  /**
   * 매칭 문맥 — 종류 코드(SL3 …)와 소속 리그. (group, variant) 만으로는
   * SL1/SL2/SL3 가 안 갈리고, BEST NINE·TITLE HOLDER 의 sub 는 리그로 갈린다.
   */
  const fxCtx = { kind: cardKind(ref?.series), league: teamOf(ref?.team ?? "")?.league ?? null,
                  meta: knownMeta };
  const match = card && pool.length
    ? resolveEffect(card.group, card.variant, pool, known, card.id, fxCtx) : null;
  const candidates = card && pool.length
    ? effectCandidates(card.group, card.variant, pool, known, fxCtx) : [];
  const effectId = picked ?? match?.effectId ?? null;
  const level = picked
    ? candidates.find(c => c.effectId === picked)?.level ?? "manual"
    : match?.level;
  useEffect(() => { setMute(new Set()); }, [effectId]);
  const noEffect = !picked && match?.level === "none";
  const doc = useAnss(!noEffect && effectId ? Number(effectId) : null);
  const { t, tv, ta, lang } = useT();
  const growthLabel = (label: string) => ({
    "ミート": t("colMeet"),
    "パワー": t("colPower"),
    "走力": t("colSpeed"),
    "球威": t("colVelocity"),
    "制球": t("colControl"),
    "スタミナ": t("colStamina"),
  } satisfies Record<string, string>)[label] ?? label;
  // 캔버스는 이펙트마다 다르다. 640x1136 로 고정하면 85% 가 가로로,
  // 31% 가 세로로 잘린다(스테이지 분포 720x1136 350 · 720x1484 208 · 640x1136 102).
  /**
   * 캔버스는 고정 픽셀로 렌더되므로, 틀 폭이 바뀌면 CSS 배율(--fx-fit)로 따라간다.
   * 기준 460px = 현재 렌더 배율(CARD_FRAME_H 541)에서 카드가 틀을 채우는 폭.
   * (ref 콜백이 이 트리에서 실행되지 않아 effect + ResizeObserver 로 건다)
   */
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".detail-page .card-frame");
    if (!el) return;
    const apply = () => el.style.setProperty("--fx-fit", String(el.clientWidth / 460));
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [card?.id]);

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
      {/* [상단] 선수 이름 · 시리즈 · 스피리츠 (사용자 지정 5구역 배치) */}
      <header className="detail-head">
        <div className="dh-id">
          <p className="reading">{card.roman || `IMAGE ${card.id}`}</p>
          <h1>{card.name}</h1>
        </div>
        <div className="detail-tags">
          <span>{ref?.series ?? card.year}</span>
          {ref?.team && <span>{tv(teamLabel(ref.team))}</span>}
          <span>{card.playerType === "pitcher" ? t("pitcherCard") : t("batterCard")}</span>
          {(ref?.trajectory || card.trajectory) &&
            <span className="traj"><Trajectory value={ref?.trajectory ?? card.trajectory}/></span>}
        </div>
        <div className="ref-chips dh-chips">
          {ref?.spirits != null && <span className="spirit"><b>{t("spirits")}</b><i>{ref.spirits.toLocaleString()}</i></span>}
          {ref?.cost != null && <span><b>{t("cost")}</b><i>{ref.cost}</i></span>}
          {ref?.hand && <span><b>{ref.kind === "batter" ? t("bats") : t("throws")}</b><i>{tv(ref.hand)}</i></span>}
          {(() => {
            // 포지션: rakda 표기값(ref.pos) 우선, 없으면 타자는 수비적성 최고
            // 포지션을 보여준다(투수는 rakda 값만).
            let label: string | null = ref?.pos ? tv(ref.pos) : null;
            if (!label && card.playerType === "batter") {
              const pos = primaryFieldPos(card);
              if (pos) label = ta(pos);
            }
            return label ? <span><b>{t("position")}</b><i>{label}</i></span> : null;
          })()}
        </div>
      </header>
      <div className="detail-art">
      {/* 선수 이미지 좌측 세로 버전 레일 (사용자 지시) */}
      {versions.length > 1 && <nav className="version-rail" aria-label="다른 버전">
        <p className="vr-title">다른 버전 <b>{versions.length}</b></p>
        {versions.map(v => {
          const on = v.id === card.id;
          return <a key={v.id} href={`/player/${v.id}`} className={on ? "on" : ""}
            title={`${v.year} · VAR ${v.variant}`}>
            <img src={`/api/card-image?group=${v.group}&file=${encodeURIComponent(v.file)}&v=2`}
              alt="" decoding="async"
              onError={e => { e.currentTarget.style.visibility = "hidden"; }}/>
            <span><b>{v.year}</b><small>VAR {v.variant}</small></span>
          </a>;
        })}
      </nav>}
        <div className="card-frame">
          <span className="fx-layer whole">
            <AnssStage doc={doc} width={fxBox.w} height={fxBox.h}
              scale={FX_FILL_SCALE * (fxScale / 100)}
              cardArtScale={1 / FX_CARD_FILL}
              offsetX={fxX} offsetY={fxY} speed={fxSpeed / 100} intensity={fxLight / 100}
              cardArt={imageUrl(card)} mute={mute} renderScale={0.75}
              /* 상세 카드는 원본 합성 순서를 따른다. WS처럼 화면 크기 배경판 위에
                 가산 지도·지구광·파티클을 쌓는 이펙트는 배경판을 빼면 색과 밀도가
                 크게 사라진다. 구장 배경은 이 원본 판보다 아래의 폴백이다. */
              backdrop/>
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

      {/* [우측] 핵심 데이터 — 스텟 + 스킬 */}
      <aside className="detail-side">
        {ref?.max && <div className="detail-quad">
          {/* 윗줄 = 스텟 | 스킬, 아랫줄 = 구종 | 제2구종.
              아래 .pitch-fans 와 같은 2열·같은 간격이라 열이 맞는다. */}
          <div className="quad-cell">
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
                <StatCell label={t("colSpeedKmh")} value={card.pitching?.maxSpeed} suffix="km/h"/>
              </>}
            </div>
            {ref.kind !== "batter" && <div className="sgcol">
              <StatCell label={t("colCatch")} value={ref.defense?.catch ?? card.defense?.catching}/>
              <StatCell label={t("colThrow")} value={ref.defense?.throw ?? card.defense?.throwing}/>
              <StatCell label={t("colArm")} value={ref.defense?.arm ?? card.defense?.shoulder}/>
            </div>}
          </div>
          </div>
          {(ref.abilities?.length ?? 0) > 0 && <div className="quad-cell">
            <h3>{t("secSkills")} <small>{ref.abilities!.length}{t("secSkillsSub")}</small></h3>
            <Skills names={ref.abilities!}/>
            {/*
              [확인된 사실] rakda3 는 각성 전 **기본형** 특능만 수록한다.
                上沢 2026 SL3 실측: 인게임은 超キレ◎, rakda3 라이브/보관본 모두
                キレ◎. 로컬 게임 데이터·libAll 에 스킬 문자열이 아예 없어
                (서버 전송) 카드별 超 승급 여부를 확정할 원본이 없다.
              [처리] 값을 지어내지 않고, 표가 기본형임을 고지한다.
            */}
            <small className="skill-tier-note">{t("skillTierNote")}</small>
          </div>}
        </div>}
        {card.playerType === "batter" && <section className="batter-defense">
          <h3>{t("secDefense")}</h3>
          {card.aptitude && <div className="defense-field" aria-label={t("secAptitude")}>
            <svg className="defense-diamond" viewBox="0 0 100 70" aria-hidden="true">
              <path d="M50 61 18 35 50 9 82 35Z"/>
              <path d="M50 61V35M18 35h64M50 9v26"/>
              <rect x="47" y="57" width="6" height="6"/><rect x="79" y="32" width="6" height="6"/>
              <rect x="47" y="6" width="6" height="6"/><rect x="15" y="32" width="6" height="6"/>
            </svg>
            {APTITUDE_LABEL.filter(([k]) => card.aptitude?.[k]).map(([k]) => {
              const value = card.aptitude![k]!;
              const [x, y] = DEFENSE_POS[k];
              return <span className="defense-position" key={k} style={{left:`${x}%`,top:`${y}%`}}
                title={`${ta(k)} ${value}`}>
                <Grade value={value}/><b>{value}</b><small>{ta(k)}</small>
              </span>;
            })}
            <div className="defense-tabs" aria-hidden="true"><b>守備</b><span>走塁</span><span>盗塁</span></div>
          </div>}
          <div className="stat-grid defense-stat-grid">
            <div className="sgcol">
              <StatCell label={t("colCatch")} value={ref?.defense?.catch ?? card.defense?.catching}/>
              <StatCell label={t("colThrow")} value={ref?.defense?.throw ?? card.defense?.throwing}/>
              <StatCell label={t("colArm")} value={ref?.defense?.arm ?? card.defense?.shoulder}/>
            </div>
          </div>
        </section>}
        {card.playerType === "pitcher" && pitching ? <>
          {!ref && <>
            <h3>{t("secPlayerBase")} <small>{t("secPlayerBaseSub")}</small></h3>
            <div className="quick-stat-grid scope-player">
              <StatCell label={t("colSpeedKmh")} value={pitching.maxSpeed} suffix="km/h"/>
              <StatCell label={t("colVelocity")} value={maxPitchPower(card)}/>
              <StatCell label={t("colStamina")} value={pitching.stamina}/>
              <StatCell label={t("colArm")} value={card.defense?.shoulder}/>
            </div>
          </>}
          <h3>{t("secPitches")} <small>{pitching.pitches.length} · {t("secPitchesSub")}</small></h3>
          {pitching.pitches.length === 0 && <p className="empty-data">{t("noPitchData")}</p>}
          {(() => {
            const s1 = pitching.pitches.filter(x => x.direction < 6);
            const s2 = pitching.pitches.filter(x => x.direction >= 6);
            // 좌완이면 원본처럼 좌우 반전한다 (ref.hand 의 '左').
            const lefty = ref?.hand === "左";
            const ja = lang !== "ko";
            return <div className="pitch-fans">
              {s1.length > 0 && <PitchFan pitches={s1} title={t("pitch1")} lefty={lefty} ja={ja}/>}
              {s2.length > 0 && <PitchFan pitches={s2} title={t("pitch2")} lefty={lefty} ja={ja}/>}
            </div>;
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
        </>}
      {/* [우측 하단] 성장 데이터 — 구종 아래 (사용자 지시) */}
      {ref?.growth && <div className="detail-growth">
        <h3>{t("secGrowth")} <small>{t("secGrowthSub")}</small></h3>
        <div className="growth-table-wrap">
          <table className="growth-table">
            <thead><tr><th>STAT</th>{ref.growth.rows.map(row => <th key={row.level}>Lv.{row.level}</th>)}</tr></thead>
            <tbody>{ref.growth.labels.map((label, statIndex) => <tr key={label}>
              <th>{growthLabel(label)}</th>
              {ref.growth!.rows.map(row => <td key={row.level} data-grade={grade(row.values[statIndex])}>{row.values[statIndex]}</td>)}
            </tr>)}</tbody>
          </table>
        </div>
      </div>}
      </aside>
      {/* [하단] 기타 정보 — 원본/매칭 */}
      <div className="detail-info">

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
