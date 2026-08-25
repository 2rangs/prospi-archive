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
  id: string; playerId: string; name: string; roman: string; year: number; group: number;
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

export function groupByPlayer(cards: Card[]): PlayerGroup[] {
  const map = new Map<string, PlayerGroup>();
  for (const c of cards) {
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
export function relevance(g: PlayerGroup, needle: string): number {
  if (!needle) return 5;
  const name = lower(g.name), roman = lower(g.roman);
  if (roman === needle || name === needle) return 0;
  if (roman.startsWith(needle) || name.startsWith(needle)) return 1;
  if (roman.includes(needle) || name.includes(needle)) return 2;
  if (g.playerId === needle) return 0;
  if (g.cards.some(c => c.id === needle)) return 0;
  return 4;
}

/** 카드 한 장이 질의에 걸리는가. 선수 단위 검색이 놓치는 ID 검색을 여기서 받는다. */
export function cardMatches(c: Card, needle: string): boolean {
  if (!needle) return true;
  return lower(c.name).includes(needle) || lower(c.roman).includes(needle)
      || c.id.includes(needle) || c.playerId.includes(needle);
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
};

export const EMPTY_FILTERS: Filters = {
  query: "", playerType: "all", year: "전체", variant: "전체",
  team: [], half: "전체", special: "전체", spiritsMin: 0,
  trajectory: [], stats: {},
};

/** ref 표기값이 있어야만 판정할 수 있는 필터가 하나라도 켜져 있는가. */
export function usesRef(f: Filters) {
  return f.team.length > 0 || f.half !== "전체" || f.special !== "전체"
    || f.spiritsMin > 0 || Object.keys(f.stats).length > 0;
}

export function filterCards(cards: Card[], f: Filters, ref?: RefMap): Card[] {
  const needle = lower(f.query.trim());
  const needRef = usesRef(f);
  const entries = Object.entries(f.stats) as [StatKey, number][];
  return cards.filter(c => {
    if (f.playerType !== "all" && c.playerType !== f.playerType) return false;
    if (f.year !== "전체" && String(c.year) !== f.year) return false;
    if (f.variant !== "전체" && c.variant !== f.variant) return false;
    if (!cardMatches(c, needle)) return false;
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
    for (const [k, min] of entries) {
      const v = statOf(r, k);
      if (v === undefined || v < min) return false;
    }
    return true;
  });
}

/** 필터를 적용한 뒤 선수로 묶고 관련도순으로 세운다. */
export function searchPlayers(cards: Card[], f: Filters, ref?: RefMap): PlayerGroup[] {
  const needle = lower(f.query.trim());
  const groups = groupByPlayer(filterCards(cards, f, ref));
  return groups.sort((a, b) =>
    relevance(a, needle) - relevance(b, needle)
    || b.maxYear - a.maxYear
    || b.cards.length - a.cards.length
    || a.name.localeCompare(b.name));
}

/** 유형 탭에 붙일 개수. 유형만 빼고 나머지 필터를 적용해서 센다. */
export function typeCounts(cards: Card[], f: Filters, ref?: RefMap) {
  const rest = filterCards(cards, { ...f, playerType: "all" }, ref);
  let batter = 0, pitcher = 0;
  for (const c of rest) (c.playerType === "batter" ? batter++ : pitcher++);
  return { all: rest.length, batter, pitcher };
}
