/**
 * 선수 검색.
 *
 * [문제] 기존 검색은 `name+roman+id+playerId` 한 줄에 substring 을 걸고
 *   끝이었다. 그래서 "ohtani" 가 50건을 뱉는데, 그 안에 **다른 선수 2명**이
 *   섞여 있고(大谷 翔平 3945 / 大谷 智久 3529) 같은 선수 카드가 26장씩
 *   나열됐다. 사람이 훑을 수 있는 결과가 아니다.
 * [처리] 카드가 아니라 **선수(=playerId + 유형)** 를 검색 단위로 만든다.
 *   50건 -> 4묶음: 翔平 타자 26 · 翔平 투수 14 · 智久 투수 7 · 智久 타자 3.
 */

export type Ability = { meetR: number; meetL: number; power: number; run: number };
export type Defense = { catching: number; throwing: number; shoulder: number; version: number };
export type Pitch = { direction: number; arrow: string; kind: number; name: string; power: number; level: number; speed: number };
export type Pitching = { maxSpeed: number; stamina: number; pitches: Pitch[] };
export type PlayerType = "batter" | "pitcher";
export type AptitudePos = "pitcher" | "catcher" | "first" | "second" | "third" | "short" | "left" | "center" | "right";
/** 표시 순서와 이름. GetDefense 의 POS 열거 순서와 같다. */
export const APTITUDE_LABEL: [AptitudePos, string][] = [
  ["pitcher", "투수"], ["catcher", "포수"], ["first", "1루"], ["second", "2루"],
  ["third", "3루"], ["short", "유격"], ["left", "좌익"], ["center", "중견"], ["right", "우익"],
];
export type Card = {
  id: string; playerId: string; name: string; iconName?: string; roman: string; year: number; group: number;
  variant: string; file: string; largeFile: string; md5: string; size: number; verified: boolean;
  playerType: PlayerType; base: Ability | null; defense: Defense | null; pitching: Pitching | null;
  /** "card" = 카드 마스터 값, "player" = 선수 능력 워드로 채운 값 */
  defenseSource?: "card" | "player" | null;
  /** 守備適性. PlayerAbility::GetDefense 의 포지션별 7비트 필드에서 뽑는다. */
  aptitude?: Partial<Record<AptitudePos, number>> | null;
  /** 弾道 (카드 마스터 +0xdc, 앵커 12개로 확정). 2014-16 구형식·투수는 null. */
  trajectory?: string | null;
};

/** 한 선수의 한 유형(타자/투수) 카드 묶음. 목록의 한 줄이 이것 하나다. */
export type PlayerGroup = {
  key: string;
  playerId: string;
  name: string;
  roman: string;
  playerType: PlayerType;
  /** 연도 내림차순. */
  cards: Card[];
  /** 목록 줄에 값을 보여 줄 대표 카드. 능력치가 있는 것 중 가장 최신. */
  rep: Card;
  minYear: number;
  maxYear: number;
  variants: number;
};

/**
 * 검색 정규화.
 *
 * [문제] 같은 선수인데 이름 표기에 공백이 있는 카드와 없는 카드가 섞여 있다.
 *   현대 카드는 원장에서 "성 이름" 으로 조립돼 `李 大浩` 이고, 2015 구형 카드는
 *   OCR 이라 `李大浩` 다(小笠原 道大 / 小笠原道大 도 같다). 그래서 `李大浩` 로
 *   치면 공백 있는 쪽이 안 걸리고 `李` 로 쳐야 둘 다 나왔다.
 * [처리] 질의와 대상 양쪽에서 공백·중점·마침표를 지우고 비교한다.
 *   (generate_site_cards.py 의 norm_name 과 같은 규칙)
 */
const lower = (s: string) => s.toLowerCase().replace(/[\s\u3000・·.．]/g, "");

/**
 * 목록 줄에 쓸 카드로서 얼마나 쓸 만한가. 클수록 좋다.
 *
 * [문제] "값이 하나라도 있으면 OK" 로 고르니 大谷 智久의 var0500 카드가 뽑혀
 *   `150 km/h · 0G · 0구종` 처럼 반쯤 빈 줄이 나왔다. 구속만 있고 구종이 없다.
 * [처리] 구종까지 있는 카드를 우선하고, 없으면 구속/스태미나만 있는 것,
 *   그것도 없으면 아무거나로 내려간다.
 */
function statScore(c: Card): number {
  if (c.playerType === "pitcher") {
    if (c.pitching?.pitches.length) return 2;
    if (c.pitching?.maxSpeed || c.pitching?.stamina) return 1;
    return 0;
  }
  if (c.base && c.defense) return 2;
  if (c.base || c.defense) return 1;
  return 0;
}

/**
 * 같은 이름이 다른 선수인 경우가 310건 있다(オスナ = 5764 / 5981). 그래서
 * 이름이 아니라 playerId 로 묶는다. playerId 가 빈 카드가 1,331장 있어서
 * 그때만 이름으로 떨어뜨린다.
 */
const groupKey = (c: Card) =>
  `${c.playerId ? `p${c.playerId}` : `n${c.name}`}|${c.playerType}`;

/** 선수가 아닌 운영 아이템 카드 — 목록에서 제외한다 (240장, playerId 6000~6014). */
const NON_PLAYER_NAMES = new Set(["調子くん"]);

export function groupByPlayer(cards: Card[]): PlayerGroup[] {
  const map = new Map<string, PlayerGroup>();
  for (const c of cards) {
    if (NON_PLAYER_NAMES.has(c.name)) continue;
    const key = groupKey(c);
    let g = map.get(key);
    if (!g) {
      g = { key, playerId: c.playerId, name: c.name, roman: c.roman,
            playerType: c.playerType, cards: [], rep: c,
            minYear: c.year, maxYear: c.year, variants: 0 };
      map.set(key, g);
    }
    g.cards.push(c);
    if (c.year < g.minYear) g.minYear = c.year;
    if (c.year > g.maxYear) g.maxYear = c.year;
    // roman 은 2,970장에서 비어 있다. 있는 값을 살린다.
    if (!g.roman && c.roman) g.roman = c.roman;
  }
  for (const g of map.values()) {
    g.cards.sort((a, b) => b.year - a.year || a.variant.localeCompare(b.variant));
    g.variants = new Set(g.cards.map(c => c.variant)).size;
    /**
     * 대표 카드는 "가장 최신"이 아니라 "능력치가 있는 것 중 가장 최신"이다.
     *
     * [문제] 大谷 智久의 2024 var0500 카드는 구종 목록이 없어 목록 줄이 통째로
     *   비어 보였다. 최신순 첫 장을 그대로 대표로 쓴 탓이다.
     * [처리] 유형에 맞는 값이 있는 첫 장을 앞으로 당긴다. 전부 비어 있으면
     *   최신 카드를 그대로 쓴다.
     */
    // cards 는 이미 연도 내림차순이라, 같은 점수면 앞쪽(최신)이 남는다
    g.rep = g.cards.reduce((best, c) => statScore(c) > statScore(best) ? c : best, g.cards[0]);
  }
  return [...map.values()];
}

/**
 * 관련도. 낮을수록 위. 이름/로마자에 **정확히** 맞은 선수를 부분일치보다
 * 먼저 올려서, "ohtani" 를 쳤을 때 大谷 가 ID 에 우연히 걸린 카드보다 앞에 온다.
 */

/**
 * 검색 별칭 — roman 필드가 비어 있는 선수를 로마자로도 찾게 한다.
 *
 * [문제] 905개 이름(카드 1,901장)이 roman 없이 들어와 "lee" 같은 검색에
 *   안 걸린다 (사용자 보고: 李承燁).
 * [방침] 표기(display)는 건드리지 않는다 — 검색 색인에만 더한다.
 *   1) 가타카나 이름(147개)은 결정적 로마자 변환으로 전부 커버.
 *   2) 한자 이름(한국·대만 선수 등)은 아래 표에 확실한 것만 손으로 추가.
 */
const SEARCH_ALIAS: Record<string, string> = {
  "李承燁": "lee seungyeop lee s.y. 이승엽",
  "李 大浩": "lee daeho 이대호",
  "李大浩": "lee daeho 이대호",
  "李 杜軒": "lee tuhsuan",
  "李 振昌": "lee chenchang",
};

/** 가타카나 -> 로마자 (헵번 근사). 검색용이라 장음은 그대로 늘린다. */
const KATA: Record<string, string> = {
  ア:"a",イ:"i",ウ:"u",エ:"e",オ:"o",カ:"ka",キ:"ki",ク:"ku",ケ:"ke",コ:"ko",
  サ:"sa",シ:"shi",ス:"su",セ:"se",ソ:"so",タ:"ta",チ:"chi",ツ:"tsu",テ:"te",ト:"to",
  ナ:"na",ニ:"ni",ヌ:"nu",ネ:"ne",ノ:"no",ハ:"ha",ヒ:"hi",フ:"fu",ヘ:"he",ホ:"ho",
  マ:"ma",ミ:"mi",ム:"mu",メ:"me",モ:"mo",ヤ:"ya",ユ:"yu",ヨ:"yo",
  ラ:"ra",リ:"ri",ル:"ru",レ:"re",ロ:"ro",ワ:"wa",ヲ:"o",ン:"n",
  ガ:"ga",ギ:"gi",グ:"gu",ゲ:"ge",ゴ:"go",ザ:"za",ジ:"ji",ズ:"zu",ゼ:"ze",ゾ:"zo",
  ダ:"da",ヂ:"ji",ヅ:"zu",デ:"de",ド:"do",バ:"ba",ビ:"bi",ブ:"bu",ベ:"be",ボ:"bo",
  パ:"pa",ピ:"pi",プ:"pu",ペ:"pe",ポ:"po",ヴ:"vu",
  ァ:"a",ィ:"i",ゥ:"u",ェ:"e",ォ:"o",ッ:"",ヶ:"ke",
};
const KATA_SMALL: Record<string, string> = { ャ:"ya", ュ:"yu", ョ:"yo" };

export function kataToRoman(name: string): string {
  if (!/^[ァ-ヶー・\s]+$/.test(name)) return "";
  let out = "";
  const chars = [...name];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i], nx = chars[i + 1];
    if (ch === "ー") { out += out.slice(-1); continue; }        // 장음 = 직전 모음 반복
    if (ch === "・" || ch === " ") { out += " "; continue; }
    if (nx && KATA_SMALL[nx]) {                                  // 拗音: シャ -> sha
      const base = KATA[ch] ?? "";
      out += base.slice(0, -1).replace(/i$/, "") + KATA_SMALL[nx].slice(-2);
      out += ""; i += 1;
      continue;
    }
    if (ch === "ッ") { const b = KATA[nx ?? ""] ?? ""; out += b.slice(0, 1); continue; }
    out += KATA[ch] ?? "";
  }
  return out;
}

/** 검색 색인용 별칭. 없으면 빈 문자열. */
export function searchAlias(name: string): string {
  return SEARCH_ALIAS[name] ?? kataToRoman(name);
}

export function relevance(g: PlayerGroup, needle: string): number {
  if (!needle) return 5;
  const name = lower(g.name), roman = lower(g.roman);
  const alias = lower(searchAlias(g.name));
  if (roman === needle || name === needle) return 0;
  if (roman.startsWith(needle) || name.startsWith(needle) || alias.startsWith(needle)) return 1;
  if (roman.includes(needle) || name.includes(needle) || alias.includes(needle)) return 2;
  if (g.playerId === needle) return 0;
  if (g.cards.some(c => c.id === needle)) return 0;
  return 4;
}

/**
 * 시리즈 코드 검색 별칭 — "ws" "ob" "b9" 처럼 카드 종류로 찾는다 (사용자 요청).
 * rakda3 시리즈 문자열(2025S2SP(WS5) · 2015SP(B9) …)의 괄호 코드와 대조한다.
 */
const SERIES_QUERY_ALIAS: Record<string, string> = {
  "베스트나인": "b9", "bt": "b9", "bp": "b9",
  "셀렉션": "sl", "selection": "sl",
  "드라": "ドラ", "draft": "ドラ",
  "사무라이": "侍", "samurai": "侍",
};

/** 카드 한 장이 질의에 걸리는가. 선수 단위 검색이 놓치는 ID 검색을 여기서 받는다. */
export function cardMatches(c: Card, needle: string, ref?: RefMap): boolean {
  if (!needle) return true;
  if (lower(c.name).includes(needle) || lower(c.roman).includes(needle)
      || lower(searchAlias(c.name)).includes(needle)
      || c.id.includes(needle) || c.playerId.includes(needle)) return true;
  // 시리즈 코드: 2~8자 질의만 (한 글자는 오탐이 많다)
  if (needle.length >= 2 && needle.length <= 8) {
    const q = SERIES_QUERY_ALIAS[needle] ?? needle;
    const ser = lower(ref?.[c.id]?.series ?? "");
    if (ser.includes(lower(q))) return true;
  }
  return false;
}

/**
 * 능력치 검색에 쓰는 키. 값은 ref-stats.json 의 위치를 그대로 따른다.
 *   max.*      미트/파워/주력 · 구위/제구/스태미나
 *   defense.*  포구/송구/어깨
 */
export type StatKey = "meet" | "power" | "speed"
  | "velocity" | "control" | "stamina" | "catch" | "throw" | "arm";

/** 라벨은 i18n 키로 둔다 — 화면에서 t() 로 편다. */
export const BATTER_STATS: [StatKey, string][] =
  [["meet", "colMeet"], ["power", "colPower"], ["speed", "colSpeed"]];
export const PITCHER_STATS: [StatKey, string][] =
  [["velocity", "colVelocity"], ["control", "colControl"], ["stamina", "colStamina"]];
export const DEFENSE_STATS: [StatKey, string][] =
  [["catch", "colCatch"], ["throw", "colThrow"], ["arm", "colArm"]];

const DEF_KEYS = new Set<StatKey>(["catch", "throw", "arm"]);

/**
 * 팀 약칭 -> 읽을 수 있는 이름.
 * 레퍼런스는 한 글자 약칭(日 · ソ · De …)으로 적는데 그대로 칩에 쓰면
 * "닛폰햄"을 찾을 수 없다. 12구단 전부 여기서 편다.
 */
export const TEAM_NAME: Record<string, string> = {
  "日": "日本ハム", "ソ": "ソフトバンク", "ロ": "ロッテ", "西": "西武",
  "楽": "楽天", "オ": "オリックス",
  "巨": "巨人", "神": "阪神", "中": "中日", "De": "DeNA",
  "広": "広島", "ヤ": "ヤクルト",
};
export const teamLabel = (t: string) => TEAM_NAME[t] ?? t;

/** 카드 하나의 능력치를 뽑는다. ref 가 없으면 undefined. */
export function statOf(r: RefLike | undefined, k: StatKey): number | undefined {
  if (!r) return undefined;
  const v = DEF_KEYS.has(k) ? r.defense?.[k] : r.max?.[k];
  return typeof v === "number" ? v : undefined;
}

/** 필터가 쓰는 ref 최소 형태. refStats.ts 의 RefStats 와 구조 호환. */
export type RefLike = {
  team?: string; series?: string; spirits?: number; trajectory?: string | null;
  max?: Record<string, number>; defense?: Record<string, number>;
};
export type RefMap = Record<string, RefLike> | null | undefined;

/** "2022S2SP(SM1)" -> { year: 2022, half: "S2", special: true } */
export function parseSeries(s?: string) {
  const m = /^(\d{4})S([12])(.*)$/.exec(s ?? "");
  if (!m) return null;
  return { year: Number(m[1]), half: `S${m[2]}`, special: m[3].length > 0 };
}

export type Filters = {
  query: string;
  playerType: PlayerType | "all";
  year: string;
  variant: string;
  /** 빈 배열 = 조건 없음. 여러 개면 OR. */
  team: string[];
  half: string;          // "전체" | "S1" | "S2"
  special: string;       // "전체" | "sp" | "normal"
  spiritsMin: number;    // 0 이면 무시
  trajectory: string[];
  stats: Partial<Record<StatKey, number>>;
  /** 주 능력 3종 중 같은 값이 2개 이상인 카드만. */
  equalStats: boolean;
};

export const EMPTY_FILTERS: Filters = {
  query: "", playerType: "all", year: "전체", variant: "전체",
  team: [], half: "전체", special: "전체", spiritsMin: 0,
  trajectory: [], stats: {}, equalStats: false,
};

/** ref 표기값이 있어야만 판정할 수 있는 필터가 하나라도 켜져 있는가. */
export function usesRef(f: Filters) {
  return f.team.length > 0 || f.half !== "전체" || f.special !== "전체"
    || f.spiritsMin > 0 || Object.keys(f.stats).length > 0 || f.equalStats;
}

export function filterCards(cards: Card[], f: Filters, ref?: RefMap): Card[] {
  const needle = lower(f.query.trim());
  const needRef = usesRef(f);
  const entries = Object.entries(f.stats) as [StatKey, number][];
  return cards.filter(c => {
    if (f.playerType !== "all" && c.playerType !== f.playerType) return false;
    if (f.year !== "전체" && String(c.year) !== f.year) return false;
    if (f.variant !== "전체" && c.variant !== f.variant) return false;
    if (!cardMatches(c, needle, ref)) return false;
    /**
     * 탄도는 ref 와 원장 둘 다에서 나온다. 그래서 usesRef 에 넣지 않고 여기서
     * 따로 본다 — 넣으면 표기값 없는 카드가 통째로 빠진다.
     * 우선순위는 표기값 > 원장 (원장은 카드↔마스터 짝이 추정이라 덜 믿는다).
     */
    if (f.trajectory.length) {
      const t = ref?.[c.id]?.trajectory || c.trajectory;
      if (!t || !f.trajectory.includes(t)) return false;
    }
    if (!needRef) return true;
    const r = ref?.[c.id];
    if (!r) return false;                      // 표기값이 없으면 판정 불가 -> 제외
    if (f.team.length && !(r.team && f.team.includes(r.team))) return false;
    if (f.spiritsMin > 0 && !(typeof r.spirits === "number" && r.spirits >= f.spiritsMin)) return false;
    if (f.half !== "전체" || f.special !== "전체") {
      const p = parseSeries(r.series);
      if (!p) return false;
      if (f.half !== "전체" && p.half !== f.half) return false;
      if (f.special === "sp" && !p.special) return false;
      if (f.special === "normal" && p.special) return false;
    }
    if (f.equalStats) {
      const keys: StatKey[] = c.playerType === "pitcher"
        ? ["velocity", "control", "stamina"] : ["meet", "power", "speed"];
      const values = keys.map(k => statOf(r, k));
      if (values.some(v => v === undefined)
          || !values.some((v, i) => values.indexOf(v) !== i)) return false;
    }
    for (const [k, min] of entries) {
      const v = statOf(r, k);
      if (v === undefined || v < min) return false;
    }
    return true;
  });
}

/** 필터를 적용한 뒤 선수로 묶고 관련도순으로 세운다. */
/** 그룹의 최고 스피리츠 — 정렬 기준. 표기값이 하나도 없으면 -1. */
function maxSpirits(g: PlayerGroup, ref?: RefMap): number {
  if (!ref) return -1;
  let best = -1;
  for (const c of g.cards) {
    const s = ref[c.id]?.spirits;
    if (s != null && s > best) best = s;
  }
  return best;
}

export function searchPlayers(cards: Card[], f: Filters, ref?: RefMap): PlayerGroup[] {
  const needle = lower(f.query.trim());
  const groups = groupByPlayer(filterCards(cards, f, ref));
  // 기본 순서 = 최고 스피리츠 내림차순 (사용자 요청 — 인게임 가치 순).
  // 검색어가 있으면 관련도가 먼저다.
  return groups.sort((a, b) =>
    relevance(a, needle) - relevance(b, needle)
    || maxSpirits(b, ref) - maxSpirits(a, ref)
    || b.maxYear - a.maxYear
    || b.cards.length - a.cards.length
    || a.name.localeCompare(b.name));
}

/** 유형 탭에 붙일 개수. 유형만 빼고 나머지 필터를 적용해서 센다. */
export function typeCounts(cards: Card[], f: Filters, ref?: RefMap) {
  const rest = filterCards(cards, { ...f, playerType: "all" }, ref);
  let batter = 0, pitcher = 0;
  for (const c of rest) { if (c.playerType === "batter") batter++; else pitcher++; }
  return { all: rest.length, batter, pitcher };
}
