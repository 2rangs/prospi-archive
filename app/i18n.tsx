"use client";
import { useEffect, useState } from "react";

/**
 * 화면 문구. **기본은 일본어**, 한국어는 언어팩으로 얹는다.
 *
 * 게임 원문이 일본어라 능력·탄도·특능 같은 고유 명사는 어차피 일본어로 남는다.
 * 그 사이에 한국어 라벨이 섞이면 읽는 사람이 두 언어를 계속 오간다.
 * 그래서 기본을 일본어로 두고, ko 는 사전에서 덮어쓰는 구조로 만든다.
 * 사전에 없는 키는 자동으로 ja 로 떨어진다(누락돼도 화면이 비지 않는다).
 */
export type Lang = "ja" | "ko";

const JA = {
  brandSub: "PLAYER DATA",
  navPlayers: "選手一覧",
  navEffects: "カード背景",
  navAbout: "抽出情報",
  heroEyebrow: "PROFESSIONAL BASEBALL SPIRITS A",
  heroTitle1: "全シリーズを",
  heroTitle2: "ひとつに。",
  heroCopy: "アプリから直接抽出した選手画像とカード能力データを\nシリーズに合わせてつないだ選手データベース。",
  statAllCards: "全カード",
  statPitcherCards: "投手カード",
  statImages: "画像リソース",

  tabAll: "すべて",
  tabBatter: "野手",
  tabPitcher: "投手",
  searchPlaceholder: "選手名 · ローマ字 · PLAYER ID · IMAGE ID",
  searchClear: "検索語を消す",

  filters: "フィルター",
  filterReset: "すべて解除",
  fTeam: "球団",
  fTraj: "弾道",
  fYear: "年度",
  fSeries: "シリーズ",
  fKind: "種類",
  fAwaken: "覚醒",
  fSpirits: "スピリッツ",
  fStats: "能力",
  fEqualStats: "同値",
  equalStatsOn: "同値",
  fAll: "すべて",
  fNormal: "通常",
  fSpecial: "SP·限定",
  perPage: "1ページ",
  filterNote1: "球団 · シリーズ · スピリッツ · 能力は",
  filterNote2: "カード表記値",
  filterNote3: "で絞り込む（対象",
  filterNote4: "枚）。弾道は原簿の値でも絞るため表記値のないカードも残る。",

  colPlayer: "選手",
  colSeries: "シリーズ",
  colTraj: "弾道",
  colSpirits: "スピリッツ",
  colStats: "能力",
  colAbilities: "特殊能力",
  colTrajSpeed: "弾道・球速",
  colMeet: "ミート",
  colPower: "パワー",
  colSpeed: "走力",
  colCatch: "捕球",
  colThrow: "送球",
  colArm: "肩力",
  colSpeedKmh: "最速",
  colVelocity: "球威",
  colControl: "制球",
  colStamina: "スタミナ",
  colPitches: "球種",
  teamUnknown: "所属不明",
  spiritsInline: "スピリッツ",
  pitchCount: "球種",
  noStats: "表記値なし",
  cardsLabel: "カード",
  other: "ほか",
  variantsUnit: "種",
  playersUnit: "名",
  cardsUnit: "枚",
  empty: "該当する選手がいません。タブを「すべて」にするか、フィルターを緩めてください。",
  prev: "← 前へ",
  next: "次へ →",

  backToList: "← 選手一覧",
  detailEyebrow: "PLAYER DETAIL",
  secCardAbility: "カード能力",
  secCardAbilitySub: "表記値 · prospi-a.rakda3.net",
  secSkills: "特殊能力",
  skillTierNote: "※ 覚醒・限界突破後は実機で「超」表記に強化される場合があります（本表は基本形）",
  secSkillsSub: "件 · タップで説明",
  secDefense: "守備能力",
  secAptitude: "守備適性",
  secAptitudeSub: "選手基準値 · カード表記と異なる場合がある",
  secPitches: "球種",
  secPitchesSub: "12方向",
  noPitchData: "同年度の確認可能な球種データなし",
  secGrowth: "特訓成長",
  secGrowthSub: "Lv.0–10 · 実測値",
  secResources: "リソース",
  secPlayerBase: "選手基準値",
  secPlayerBaseSub: "全カード共通 · カード別の値ではない",
  spirits: "スピリッツ",
  cost: "コスト",
  bats: "打席",
  throws: "投球",
  position: "ポジション",
  pitchRanks: "球種ランク",
  devTools: "開発ツール",
  noDesc: "説明なし",
  batterCard: "野手カード",
  pitcherCard: "投手カード",
  verified: "マニフェスト検証済み",
  unverified: "CDN 更新",
  pitch1: "第1球種",
  pitch2: "第2球種",
  original: "オリジナル",
  fxTitle1: "オリジナル背景エフェクトを",
  fxTitle2: "動くカードで。",
  fxCopy: "CHK コンテナの AnimSS パートを解析し、ノード・キーフレーム・頂点カラーまでそのまま再生します。インスタンスは位相をずらして別フレームを読み、back パートは選手画像の後ろ、front パートは前に置かれます。UV アニメーションは原本どおりシートから clamp サンプリングします。",
  fxNow: "現在のエフェクト",
  fxWhy: "マッチング根拠",
  fxParts: "原本構成",
  fxTotal: "全エフェクト",
  fxSeeAll: "682件の原本エフェクトを見る →",
  resultsPlayers: "選手",
  resultsAll: "すべて",
  cardsOf: "枚 · バリアント",
  aboutTitle: "抽出範囲",
  about1: "15,222枚のカード",
  about1d: "全シリーズの画像と選手 ID を接続",
  about2: "カード種別の分離",
  about2d: "投手と野手をカード原簿基準で区分",
  about3: "12方向の球種",
  about3d: "球種·球威·変化量·球速を原簿値から解読",
  about4: "遅延読み込み",
  about4d: "現在のページの小さい選手画像だけを読み込む",
  siteTitle: "PROSPI ARCHIVE — プロスピA 選手図鑑",
  cardsVariants: "枚 · バリアント",
  noteRefFilter: "球団 · シリーズ · スピリッツ · 能力は表記値で絞り込む（対象 {n} 枚）。弾道は原簿の値でも絞るため表記値のないカードも残る。",
  resultSummary: "{p} 名 · カード {c} 枚のうち {a}–{b} 番目を表示",
  loading: "データ読み込み中",
  siteName: "PROSPI ARCHIVE",
  siteTagline: "プロスピA 選手データベース",
  ctaBrowse: "選手を探す",
  ctaCount: "件のカード",
} as const;

/** 매칭 근거 라벨의 한국어판. resolve.ts 의 MATCH_LABEL 이 일본어 기본. */
export const MATCH_LABEL_KO: Record<string, string> = {
  known: "실측 매핑", family: "실측 전파 (같은 그룹·variant)",
  "known-kind": "실측 전파 (같은 그룹·variant·종류)",
  league: "리그로 sub 결정 (BEST NINE / TITLE HOLDER)",
  none: "전용 이펙트 없음 (실측)",
  rule: "규칙 예측 (variant→series)", guess: "미검증 추정 (같은 연도)",
  other: "미검증 추정 (다른 연도)", manual: "직접 지정",
};

export type Key = keyof typeof JA;

const KO: Partial<Record<Key, string>> = {
  brandSub: "선수 데이터",
  navPlayers: "선수 목록",
  navEffects: "카드 배경",
  navAbout: "추출 정보",
  heroTitle1: "모든 시리즈를",
  heroTitle2: "한 번에.",
  heroCopy: "앱에서 직접 추출한 선수 이미지와 카드 능력 데이터를\n시리즈에 맞춰 연결한 선수 데이터베이스.",
  statAllCards: "전체 카드",
  statPitcherCards: "투수 카드",
  statImages: "이미지 리소스",

  tabAll: "전체",
  tabBatter: "타자",
  tabPitcher: "투수",
  searchPlaceholder: "선수명 · 로마자 · PLAYER ID · IMAGE ID",
  searchClear: "검색어 지우기",

  filters: "필터",
  filterReset: "전체 해제",
  fTeam: "팀",
  fTraj: "탄도",
  fYear: "연도",
  fSeries: "시리즈",
  fKind: "종류",
  fAwaken: "각성",
  fSpirits: "스피리츠",
  fStats: "능력치",
  fEqualStats: "동치",
  equalStatsOn: "동치",
  fAll: "전체",
  fNormal: "일반",
  fSpecial: "SP·한정",
  perPage: "페이지당",
  filterNote1: "팀 · 시리즈 · 스피리츠 · 능력치는",
  filterNote2: "카드 표기값",
  filterNote3: "으로 거른다 (대상",
  filterNote4: "장). 탄도는 원장 값으로도 걸러 표기값 없는 카드도 남는다.",

  colPlayer: "선수",
  colSeries: "시리즈",
  colTraj: "탄도",
  colSpirits: "스피리츠",
  colStats: "능력",
  colAbilities: "특수능력",
  colTrajSpeed: "탄도·구속",
  colMeet: "미트",
  colPower: "파워",
  colSpeed: "주력",
  colCatch: "포구",
  colThrow: "송구",
  colArm: "어깨",
  colSpeedKmh: "최고 구속",
  colVelocity: "구위",
  colControl: "제구",
  colStamina: "스태미나",
  colPitches: "구종",
  teamUnknown: "소속 미상",
  spiritsInline: "스피리츠",
  pitchCount: "구종",
  noStats: "표기값 없음",
  cardsLabel: "카드",
  other: "외",
  variantsUnit: "종",
  playersUnit: "명",
  cardsUnit: "장",
  empty: "찾는 선수가 없습니다. 탭을 «전체»로 바꾸거나 필터를 풀어 보세요.",
  prev: "← 이전",
  next: "다음 →",

  backToList: "← 선수 목록",
  secCardAbility: "카드 능력",
  secCardAbilitySub: "표기값 · prospi-a.rakda3.net",
  secSkills: "특수능력",
  skillTierNote: "※ 각성·한계돌파 후에는 인게임에서 「超」 표기로 강화될 수 있습니다 (이 표는 기본형)",
  secSkillsSub: "개 · 눌러서 설명",
  secDefense: "수비 능력",
  secAptitude: "수비 적성",
  secAptitudeSub: "선수 기준값 · 카드 표기와 다를 수 있음",
  secPitches: "구종",
  secPitchesSub: "12방향",
  noPitchData: "같은 연도의 확인 가능한 구종 데이터 없음",
  secGrowth: "특훈 성장",
  secGrowthSub: "Lv.0–10 · 실제 표기값",
  secResources: "리소스",
  secPlayerBase: "선수 기준값",
  secPlayerBaseSub: "전 카드 공통 · 카드별 값 아님",
  spirits: "스피리츠",
  cost: "코스트",
  bats: "타석",
  throws: "투구",
  position: "포지션",
  pitchRanks: "구종랭크",
  devTools: "개발 도구",
  noDesc: "설명 없음",
  batterCard: "타자 카드",
  pitcherCard: "투수 카드",
  verified: "매니페스트 검증",
  unverified: "CDN 갱신",
  pitch1: "제1구종",
  pitch2: "제2구종",
  original: "오리지널",
  fxTitle1: "원본 배경 효과를",
  fxTitle2: "움직이는 카드로.",
  fxCopy: "CHK 컨테이너의 AnimSS 파트를 파서 노드·키프레임·정점 색상까지 그대로 재생합니다. 인스턴스는 위상으로 서로 다른 프레임을 읽고, back 파트는 선수 이미지 뒤, front 파트는 앞에 놓입니다. UV 애니메이션은 원본과 같이 시트에서 clamp 샘플링합니다.",
  fxNow: "현재 효과",
  fxWhy: "매칭 근거",
  fxParts: "원본 구성",
  fxTotal: "전체 효과",
  fxSeeAll: "682개 원본 효과 보기 →",
  resultsPlayers: "선수",
  resultsAll: "전체",
  cardsOf: "장 · 변형",
  aboutTitle: "추출 범위",
  about1: "15,222개 카드",
  about1d: "전 시리즈 이미지와 선수 ID 연결",
  about2: "카드 유형 분리",
  about2d: "투수와 타자를 카드 원장 기준으로 구분",
  about3: "12방향 구종",
  about3d: "구종·구위·변화량·구속을 원장값으로 해독",
  about4: "지연 로딩",
  about4d: "현재 페이지의 작은 선수 이미지만 로드",
  siteTitle: "PROSPI ARCHIVE — 프로스피A 선수 도감",
  cardsVariants: "장 · 변형",
  noteRefFilter: "팀 · 시리즈 · 스피리츠 · 능력치는 표기값으로 거른다 (대상 {n}장). 탄도는 원장 값으로도 걸러 표기값 없는 카드도 남는다.",
  resultSummary: "{p}명 · 카드 {c}장 중 {a}–{b}번째 표시",
  loading: "데이터 불러오는 중",
  siteName: "PROSPI ARCHIVE",
  siteTagline: "프로스피A 선수 데이터베이스",
  ctaBrowse: "선수 찾기",
  ctaCount: "장의 카드",
};

/**
 * 데이터 값 사전. 게임에서 오는 값(탄도·적성·팀·투타·포지션)은 일본어 원문이
 * 그대로 들어온다. 한국어 모드에서만 여기를 거쳐 바꾼다.
 * 사전에 없으면 **원문 그대로** 내보낸다 — 새 값이 들어와도 화면이 비지 않는다.
 */
const TERMS_KO: Record<string, string> = {
  // 탄도
  "アーチスト": "아치스트", "パワーヒッター": "파워히터", "ラインドライブ": "라인드라이브",
  "高弾道": "고탄도", "中弾道": "중탄도", "低弾道": "저탄도", "グラウンダー": "그라운더",
  // 구단
  "日本ハム": "니혼햄", "ソフトバンク": "소프트뱅크", "ロッテ": "롯데", "西武": "세이부",
  "楽天": "라쿠텐", "オリックス": "오릭스", "巨人": "요미우리", "阪神": "한신",
  "中日": "주니치", "DeNA": "DeNA", "広島": "히로시마", "ヤクルト": "야쿠르트",
  // 투타
  "右投右打": "우투우타", "右投左打": "우투좌타", "左投左打": "좌투좌타",
  "左投右打": "좌투우타", "右投両打": "우투양타", "左投両打": "좌투양타",
  "右": "우", "左": "좌", "両": "양",
  // 포지션
  "先": "선발", "継": "중계", "抑": "마무리",
  "捕": "포수", "一": "1루", "二": "2루", "三": "3루", "遊": "유격",
  "左翼": "좌익", "中堅": "중견", "右翼": "우익", "投": "투수",
};

/** 적성 키 -> 표시 라벨 (ja 기본). */
export const APT_LABEL: Record<string, { ja: string; ko: string }> = {
  catcher: { ja: "捕手", ko: "포수" }, first: { ja: "一塁", ko: "1루" },
  second: { ja: "二塁", ko: "2루" }, third: { ja: "三塁", ko: "3루" },
  short: { ja: "遊撃", ko: "유격" }, left: { ja: "左翼", ko: "좌익" },
  center: { ja: "中堅", ko: "중견" }, right: { ja: "右翼", ko: "우익" },
  starter: { ja: "先発", ko: "선발" }, middle: { ja: "中継", ko: "중계" },
  closer: { ja: "抑え", ko: "마무리" }, pitcher: { ja: "投手", ko: "투수" },
};

const PACKS: Record<Lang, Partial<Record<Key, string>>> = { ja: JA, ko: KO };
const STORE = "prospi.lang";

let current: Lang = "ja";
const subs = new Set<(l: Lang) => void>();

export function setLang(l: Lang) {
  current = l;
  try { localStorage.setItem(STORE, l); } catch { /* 저장 불가 환경 */ }
  subs.forEach(f => f(l));
}

/** 현재 언어와 번역 함수. 사전에 없으면 일본어로 떨어진다. */
export function useT() {
  const [lang, setL] = useState<Lang>(current);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORE) as Lang | null;
      if (saved && saved !== current) { current = saved; setL(saved); }
    } catch { /* 무시 */ }
    subs.add(setL);
    return () => { subs.delete(setL); };
  }, []);
  const t = (k: Key) => PACKS[lang][k] ?? JA[k];
  /** 데이터 값 번역. 사전에 없으면 원문 그대로. */
  const tv = (v?: string | null) => (!v ? "" : lang === "ko" ? (TERMS_KO[v] ?? v) : v);
  /** 적성 키 라벨. */
  const ta = (k: string) => APT_LABEL[k]?.[lang] ?? k;
  /** {n} 같은 자리표시자를 채운다. */
  const tf = (k: Key, vals: Record<string, string | number>) =>
    Object.entries(vals).reduce((acc, [a, b]) => acc.replace(`{${a}}`, String(b)), t(k) as string);
  /** 매칭 근거 라벨. */
  const tm = (lv: string, ja: string) => (lang === "ko" ? MATCH_LABEL_KO[lv] ?? ja : ja);
  return { t, tv, ta, tf, tm, lang, setLang };
}

/**
 * 테마 전환. 기본은 화이트, 다크는 차콜 계열.
 * 값은 <html data-theme> 에 실어 CSS 변수로 갈린다.
 */
export type Theme = "light" | "dark";
const TSTORE = "prospi.theme";
/**
 * 기본은 **다크**.
 *
 * 이펙트는 가산 합성이라 어두운 바닥 위에서 원본처럼 읽힌다. 흰 배경에서는
 * 같은 픽셀이 옅고 뿌옇게 보인다 — 사용자가 "다크모드일 때는 정상 같다"고
 * 확인해 줬다. 게임 화면도 어둡다.
 */
let theme: Theme = "dark";
const tsubs = new Set<(t: Theme) => void>();

export function setTheme(v: Theme) {
  theme = v;
  document.documentElement.dataset.theme = v;
  try { localStorage.setItem(TSTORE, v); } catch { /* 무시 */ }
  tsubs.forEach(f => f(v));
}

export function ThemeSwitch() {
  const [v, setV] = useState<Theme>(theme);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(TSTORE) as Theme | null;
      const init: Theme = saved ?? "dark";
      theme = init;
      document.documentElement.dataset.theme = init;
      setV(init);
    } catch { /* 무시 */ }
    tsubs.add(setV);
    return () => { tsubs.delete(setV); };
  }, []);
  return <button className="theme-switch" onClick={() => setTheme(v === "light" ? "dark" : "light")}
    aria-label={v === "light" ? "dark mode" : "light mode"}>{v === "light" ? "◐" : "◑"}</button>;
}

/** 헤더에 붙이는 언어 전환. */
export function LangSwitch() {
  const { lang } = useT();
  return <div className="lang-switch">
    {(["ja", "ko"] as Lang[]).map(l =>
      <button key={l} className={lang === l ? "on" : ""} onClick={() => setLang(l)}
        aria-pressed={lang === l}>{l === "ja" ? "日本語" : "한국어"}</button>)}
  </div>;
}
