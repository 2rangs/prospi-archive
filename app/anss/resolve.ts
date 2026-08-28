/**
 * 카드 → 배경 이펙트 결정.
 *
 * [확인된 사실] 파일명은 `ANSS_EF_%06d_L.CHK` / `_S.CHK` 포맷으로 **정수 하나**에서
 *   만들어진다(libAll.so 문자열). 그 정수는 서버가 주는 carddef::PlayerCardMinInfo
 *   값이므로 로컬 파일만으로는 카드→이펙트를 확정할 수 없다.
 * [근거] `strings libAll.so | grep ANSS_EF_%06d`, 그리고 11,936개 매니페스트 파일
 *   어디에도 카드별 effect_id 표가 없음.
 *
 * [확인된 사실] 그 정수는 자리별 구조를 가진다: group + series(2) + sub(2) + rank(1).
 *   - group: 카드의 연도 그룹과 같은 값(1~12 = 2015~2026). 1~9는 6자리, 10~12는 7자리.
 *   - rank: 마지막 자리. 682개 이펙트에서 rank 3 → 스프라이트 평균 8.0장,
 *     rank 4 → 14.8장, rank 5 → 16.6장으로 단조 증가 = 카드 등급.
 * [근거] 682개 파일명 분해 + effect-index.json 집계.
 *
 * [해석] 카드 `variant`(4자리)는 series(2) + **구단코드**(2)다. series 01~06은
 *   sub에 11~95(12구단)가 모두 나오고, series 07 이상은 sub가 00뿐이다.
 *   이펙트의 sub는 00~07·10·13·14·20 범위의 연출 변형이라 구단코드가 아니다.
 *   따라서 카드와 이펙트가 공유하는 축은 **group + series**이고, 두 series 집합은
 *   18개만 겹친다(카드 전용 40종 8,356장, 이펙트 전용 6종).
 * [경쟁 가설] 카드 series → 이펙트 series 사이에 재매핑 표가 서버에 있을 수 있다.
 * [아직 모르는 것] 겹치지 않는 series가 인게임에서 어떤 이펙트를 쓰는지.
 * [신뢰도] 구조 분해 CONFIRMED / 카드-이펙트 대응 POSSIBLE.
 *
 * 그래서 추측으로 하나를 고르지 않고 단계별로 내려가며 그 단계를 UI에 표시한다.
 */

export type MatchLevel =
  | "known"     // 실측 매핑
  | "known-kind"// 같은 (group, variant, 종류) 의 실측을 전파 — 종류로 갈린 버킷
  | "family"    // 같은 (group, variant 접두) 의 실측을 전파 — 21건 실측에서 충돌 0
  | "league"    // series 는 실측/규칙, sub 는 소속 리그로 결정 (BEST NINE·TITLE HOLDER)
  | "none"      // 실측 결과 전용 이펙트가 없음
  | "rule"      // variant -> series 규칙 예측 (실측 2건 일치)
  | "guess"     // 같은 group 안에서 고른 추정값 (검증 안 됨)
  | "other"
  | "manual";

export type EffectRef = { effectId: string; level: MatchLevel; rank: number };

export type EffectKey = { effectId: string; group: number; series: string; sub: string; rank: number };

/** `1181005` → group 11 / series 81 / sub 00 / rank 5 */
export function decodeEffectId(id: string): EffectKey | null {
  if (!/^\d{6,7}$/.test(id)) return null;
  return { effectId: id, group: Number(id.slice(0, id.length - 5)),
           series: id.slice(-5, -3), sub: id.slice(-3, -1), rank: Number(id.slice(-1)) };
}

/**
 * [기각된 가설] `카드 variant 앞 2자리 == 이펙트 series`.
 *   실측 3건 전부에서 틀렸다:
 *     1251410700 (group 12, variant 0700) → 1214005 = 12|14|00|5  (series 14, 07 아님)
 *     1282670900 (group 12, variant 0900) → 1281005 = 12|81|00|5  (series 81, 09 아님)
 *     1251410100 (group 12, variant 0100) → 1251410100 (ANSS 파일 없음)
 *   따라서 카드 variant 는 이펙트 series 가 아니다. 카드 종류(TS/EX/사무라이 등)
 *   → 이펙트 series 표가 따로 있고, 그 표는 로컬에 없다.
 * [신뢰도] REJECTED
 */

/**
 * variant → 이펙트 series 규칙.
 *
 * [확인된 사실] 실측 4건 중 검증 가능한 2건이 정확히 맞는다.
 *     variant 05 → series 13   (1225180500 → 1213005)
 *     variant 07 → series 14   (1251410700 → 1214005)
 *   즉 홀수 variant v 에 대해  series = 10 + (v + 1) / 2.
 * [실제 데이터] series 11~17 은 group 2~11 에 연속 블록으로 존재한다
 *   (211005·212005·…·216005 / 1111005·…·1116005). group 12 는 11,13,14 만 있고
 *   12,15,16,17 이 없다.
 * [대체 규칙] 1차 series 가 그 연도에 없으면 홀수 8x 블록의 k-5 번째를 쓴다.
 *     group 12 홀수 8x = [81, 83, 85]
 *     variant 09 (k=5) → 1차 15 없음 → 8x[0] = 81   실측 1281005 ✅
 *     variant 11 (k=6) → 1차 16 없음 → 8x[1] = 83   실측 1283105 ✅
 *   즉 실측 4건(05·07·09·11) 전부 이 규칙으로 재현된다.
 * [예외] variant 01 은 통상 카드로 실측상 전용 이펙트가 없다(group 12 에
 *   1211005 가 있는데도 쓰지 않는다).
 * [신뢰도] STRONG — 검증 가능한 실측 4/4 일치, 표본은 전부 group 12.
 * [다음 검증] group 11(2025) variant 0900 카드가 1115005 를 쓰는지. group 11 은
 *   series 15 가 있으므로 1차 규칙이 그대로 적용돼야 한다. 다른 연도에서 한 건만
 *   확인되면 group 독립성이 확정된다.
 */
/**
 * 실측 매핑에서 variant → series 를 배운다.
 *
 * 카드 id 는 group + playerId + variant(4) 구조이므로 id 만으로 variant 를 뽑을 수
 * 있고, 이펙트 id 에서 series 를 뽑을 수 있다. 그래서 known-map.json 에 실측을
 * 추가하면 코드를 고치지 않고도 표가 늘어난다.
 *
 * [실측] variant 32 → series 51 (1139453200 → 1151005, group 11). 짝수 variant 는
 *   산술 규칙(홀수 전용)이 다루지 못하므로 이 표가 필요하다.
 * [실측] variant 45 → series 82 **sub 20** (1114764500 → 1182205, group 11).
 *   group 11 의 series 82 에는 sub 00/10/20 이 모두 있는데 실측이 20 을 골랐다.
 *   즉 sub 도 매핑의 일부이므로 표는 (series, sub) 쌍을 담는다.
 * [주의] group 12 의 09→81, 11→83 은 1차 series 가 없어서 생긴 **대체값**이다.
 *   그래서 산술 규칙을 먼저 적용하고, 그것이 그 연도에 없을 때만 이 표를 본다.
 * [신뢰도] POSSIBLE — 항목마다 실측 1건.
 *
 * [경쟁 가설 — REJECTED] "키는 variant 가 아니라 카드 종류(ref-stats 의 series
 *   문자열, 예: 2026S1SP(SL2)) 다." 실측 15건 중 ref series 를 아는 8건으로
 *   (group, series) 표를 만들면 677장을 덮어 매력적이었으나, **万波 中正의 두
 *   카드가 같은 (12, 2026S1SP(SL2)) 버킷인데 서로 다른 이펙트를 쓴다**:
 *   VAR 0700 -> 1214005, VAR 0100 -> 1201005. 같은 선수·같은 시리즈에서 갈리므로
 *   series 문자열은 키가 될 수 없다. variant 표는 실측 14건 전부 충돌 0.
 */
export type LearnedKey = { series: string; sub: string; effectId?: string };

export type League = "central" | "pacific";

/**
 * 매칭 문맥 — 카드 id·group·variant 만으로는 안 갈리는 축.
 *
 * [확인된 사실] group 12 · variant 0700 한 버킷에 이펙트가 둘 있다.
 *   1214105 (SL3 12장) · 1214005 (SL1·SL2 2장). 실측 14건이 종류 코드로 완전히
 *   갈린다. 즉 variant 는 SL 계열을 세분하지 않는다.
 * [확인된 사실] series 31/32 는 sub 가 13·14 뿐이고 개수가 정확히 짝을 이룬다
 *   (31: 11/11 · 32: 10/10). 682개 이펙트에서 sub 13/14 를 쓰는 series 는 이
 *   둘뿐이다. 텍스처 문구가 sub 13 = "Central League" · sub 14 = "Pacific
 *   League" 이고(2015·2017·2023·2024 네 쌍 전부 확인), 실측 2건도 일치한다
 *   (佐藤 輝明 阪神→1131135 · レイエス 日本ハム→1131145).
 * [해석] series 31 = BEST NINE · 32 = TITLE HOLDER · sub = 소속 리그.
 * [신뢰도] CONFIRMED
 */
export type ResolveOpts = {
  /** 이 카드의 종류 코드 (SL3 · TS1 · 覚 · "(기본)"). ref-stats 시리즈 문자열에서 뽑는다. */
  kind?: string | null;
  /** 이 카드 선수의 소속 리그. */
  league?: League | null;
  /** 실측 카드들의 종류·리그 — known-map.json 의 meta 블록. */
  meta?: Record<string, { kind?: string; league?: string }> | null;
};

/** "2026S1SP(SL3)" -> "SL3" · "2025S2覚(若手)" -> "覚" · 통상 -> "(기본)" */
export function cardKind(series?: string | null): string | null {
  if (!series) return null;
  const m = /(SP|覚)\(([^)]+)\)/.exec(series);
  if (!m) return "(기본)";
  return m[1] === "覚" ? "覚" : m[2];
}

/**
 * variant 앞 2자리는 **홀·짝이 한 쌍**이고, 쌍은 같은 이펙트를 쓴다.
 *
 * [확인된 사실] 실측 15건에서 pre 27 과 28 이 둘 다 1142005(42/00),
 *   pre 31 과 32 가 둘 다 1151005(51/00) 다. 같은 선수(大谷)의 서로 다른 아트
 *   변형이며 이펙트는 같다.
 * [검증] 쌍 번호 (pre+1)/2 로 묶으면 실측 15건 **충돌 0**.
 * [해석] 홀수 = 아트 A, 짝수 = 아트 B 인 한 장의 카드다. 그래서 표를 쌍 단위로
 *   배우면 실측 한 건이 prefix 두 개를 덮는다.
 * [신뢰도] STRONG (쌍 2개에서 직접 확인, 나머지 11건과 충돌 없음)
 */
/**
 * 실측에서 (group, variant 접두) -> 이펙트를 배운다.
 *
 * [확인된 사실] 이펙트는 선수가 아니라 **카드 시리즈(variant)에 딸려 있다.**
 *   실측 21건에서 (group, variant) -> effect 충돌이 **0건**이고,
 *   그룹10 variant 2700 의 서로 다른 선수 3명(大谷·ダルビッシュ·上沢)이
 *   같은 1041005 를 쓴다. 홀짝 짝꿍(2700/2800, 3100/3200, 4700/4800)도
 *   항상 같은 이펙트다(각성 변형).
 * [주의] 예전 구현은 group 을 무시하고 variant 접두만 배워서, 그룹10의
 *   "27"->1041005 와 그룹11의 "27"->1142005 가 충돌해 먼저 온 쪽이 이겼다.
 *   cardId 는 group + playerId(4) + variant(4) 이므로 group 은 앞자리에서
 *   바로 나온다.
 */
export function learnSeries(
  known: Record<string, string>,
  meta?: ResolveOpts["meta"],
): Record<string, LearnedKey> {
  const out: Record<string, LearnedKey> = {};
  for (const [cardId, effectId] of Object.entries(known)) {
    if (!/^\d{9,10}$/.test(cardId)) continue;
    if (!/^\d{6,7}$/.test(effectId)) continue;     // 10자리면 '전용 이펙트 없음'
    const group = cardId.slice(0, -8);
    const variant = cardId.slice(-4, -2);
    const key = { series: effectId.slice(-5, -3), sub: effectId.slice(-3, -1),
                  effectId };
    const put = (pre: string) => {
      const k = `${group}:${pre}`;
      const prev = out[k];
      if (!prev) { out[k] = { ...key }; return; }
      /**
       * 같은 (group, variant 접두) 에 실측이 여럿인데 이펙트가 다르면
       * **series 만 믿고 sub·정확한 id 는 전파하지 않는다.**
       * [근거] 그룹10 variant 47: 大谷 -> 1082105(sub 10, 사인판) ·
       *   田中賢介 -> 1082005(sub 00, 무사인판). 시리즈는 같아도 사인 유무로
       *   sub 가 선수마다 갈린다 — 카드별 실측 없이는 알 수 없다.
       */
      if (prev.effectId && prev.effectId !== effectId) {
        prev.effectId = undefined;
        if (prev.sub !== key.sub) prev.sub = "00";
      }
    };
    put(variant);
    // 홀짝 짝꿍 prefix 도 같이 배운다 (실측 3쌍 모두 동일 이펙트)
    const p = Number(variant);
    if (Number.isFinite(p) && p > 0) {
      put(String(p % 2 === 1 ? p + 1 : p - 1).padStart(2, "0"));
    }
    /**
     * 종류 코드까지 넣은 더 좁은 키. (group, variant) 가 갈라지는 버킷을
     * 이것이 가른다 — 실측 56건에서 (12,07) 충돌 14장이 SL1/SL2 vs SL3 로
     * 완전히 분리된다. 좁은 키는 넓은 키를 덮어쓰지 않고 따로 쌓는다.
     */
    const kd = meta?.[cardId]?.kind;
    if (kd) {
      const kk = `${group}:${variant}:${kd}`;
      const prev = out[kk];
      if (!prev) out[kk] = { ...key };
      else if (prev.effectId && prev.effectId !== effectId) {
        prev.effectId = undefined;
        if (prev.sub !== key.sub) prev.sub = "00";
      }
    }
  }
  /**
   * 교차그룹 합의: 같은 variant 접두가 **여러 그룹에서 같은 series** 로
   * 측정되면, 실측이 없는 그룹에도 그 series 를 예측으로 쓴다.
   *
   * [근거] 35 -> 17 이 그룹 3·6 에서 동일. 반대로 27 은 그룹10=41 ·
   *   그룹11=42 로 갈리므로(연도별 증가 계열) 합의가 없으면 전파하지 않는다.
   * [주의] 종전의 하드코딩 표(25=16 · 27=42 · 31=51 · 35=61)는 실측 채점에서
   *   **11건 중 6건이 틀렸다** — 35=61, g10 27=42 가 모두 오답. 표를 지우고
   *   이 데이터 유도 합의로 대체한다.
   */
  const byPre = new Map<string, Set<string>>();
  for (const [k, v] of Object.entries(out)) {
    const pre = k.split(":")[1];
    if (!byPre.has(pre)) byPre.set(pre, new Set());
    byPre.get(pre)!.add(v.series);
  }
  for (const [pre, sers] of byPre) {
    if (sers.size === 1 && !out[`*:${pre}`]) {
      out[`*:${pre}`] = { series: [...sers][0], sub: "00" };
    }
  }
  return out;
}

export function predictSeries(
  variant: string, pool: EffectKey[], group: number,
  learned?: Record<string, LearnedKey>,
): LearnedKey | null {
  const pre = variant.slice(0, 2);
  const v = Number(pre);
  const familyV = v > 0 && v % 2 === 0 ? v - 1 : v;
  const inGroup = pool.filter(e => e.group === group);
  const has = (ser: string) => inGroup.some(e => e.series === ser);

  if (!Number.isFinite(v)) return null;

  // 실측에서 배운 표가 가장 강한 근거다 — (group, variant 접두) 로 조회
  const ls = learned?.[`${group}:${pre}`];
  if (ls && has(ls.series)) return ls;
  // 이 그룹엔 실측이 없어도, 다른 그룹들이 같은 series 로 합의하면 그것을 쓴다
  const cross = learned?.[`*:${pre}`];
  if (cross && has(cross.series)) return { series: cross.series, sub: "00" };

  /**
   * VAR 01 = 그 시즌 기본 이펙트 (series 01).
   *
   * [반박된 가설] "통상 카드는 전용 이펙트가 없다." known-map 에 1251410100 을
   *   '전용 없음'으로 적어 두었으나, 사용자 실측으로 **1201005 를 쓴다**는 것이
   *   확인됐다. group 12 · VAR 0100 -> series 01. 즉 통상 카드도 이펙트가 있고
   *   그것이 {group}01005 다.
   * [신뢰도] CONFIRMED (실측 1건, 규칙이 단순하고 파일도 전 그룹에 존재)
   */
  if (familyV === 1 && has("01")) return { series: "01", sub: "00" };

  /**
   * 시즌2 기본 카드와 각성 카드.
   *
   * 카드 전수에서 01xx(5,431장)와 21xx(3,604장)가 두 시즌의 압도적인 기본
   * 패밀리이고, 모든 해당 연도 이펙트 팩에 series 01/02가 한 쌍으로 존재한다.
   * 03xx/23xx 역시 각각 시즌1/2 각성 카드이며 동일한 series 12 연출을 쓴다.
   * 종전에는 21/23을 모르면 series 01로 폴백해 시즌2 카드 4천여 장에 시즌1
   * 배경이 붙었다. [신뢰도: 구조 STRONG, 23→12 POSSIBLE]
   */
  if (familyV === 21 && has("02")) return { series: "02", sub: "00" };
  if (familyV === 23 && has("12")) return { series: "12", sub: "00" };

  /**
   * [철회] 하드코딩 특수 패밀리 표(25=16 · 27=42 · 31=51 · 35=61)는 실측 26건
   * 채점에서 **11건 중 6건 오답**이라 삭제했다(35 는 실제 17, g10 의 27 은 41).
   * 그 역할은 위의 learned 교차그룹 합의(`*:{pre}`)가 데이터로 대신한다.
   */

  if (familyV % 2 === 1 && familyV >= 3 && familyV <= 15) {
    const k = (familyV + 1) / 2;
    const primary = String(10 + k).padStart(2, "0");
    if (has(primary)) return { series: primary, sub: "00" };
    const odd8p = [...new Set(inGroup.map(e => e.series)
      .filter(x => x[0] === "8" && Number(x[1]) % 2 === 1))].sort();
    const ip = k - 5;
    if (ip >= 0 && ip < odd8p.length) return { series: odd8p[ip], sub: "00" };
  }
  return null;
}


/**
 * series 31/32 처럼 sub 가 리그로 갈리는 묶음에서 알맞은 sub 를 고른다.
 * 규칙을 특정 series 에 박지 않고 **구조로 판정한다** — 그 group·series 의
 * sub 집합이 정확히 {13,14} 일 때만 리그로 고른다.
 */
const LEAGUE_SUB: Record<League, string> = { central: "13", pacific: "14" };

function leagueSub(cand: EffectKey[], league?: League | null): string | null {
  if (!league) return null;
  const subs = new Set(cand.map(e => e.sub));
  if (subs.size !== 2 || !subs.has("13") || !subs.has("14")) return null;
  return LEAGUE_SUB[league];
}

/** 랭크 높은 것 우선, 다음 series·sub 오름차순 — 재현 가능한 순서. */
function pick(cand: EffectKey[]): EffectKey | null {
  if (!cand.length) return null;
  return [...cand].sort((a, b) => (b.rank - a.rank) ||
    a.series.localeCompare(b.series) || a.sub.localeCompare(b.sub))[0];
}

/**
 * 카드(group, variant)에 대한 이펙트 후보를 위에서부터 고른다.
 *   exact   group + series + sub 전부 일치
 *   series  group + series 일치 (sub는 연출 변형이라 무시)
 *   group   같은 group의 기본 series 01
 *   nearest 가장 가까운 group의 기본 series 01
 */
/**
 * 카드 → 이펙트.
 *
 * 실측 매핑이 있으면 그것을 쓴다. 없으면 같은 연도 그룹 안에서 하나를 고르는데,
 * 그건 **검증되지 않은 추정**이므로 level "guess" 로 표시한다. 카드별 실제
 * effect_id 는 서버 carddef 값이라 로컬 파일에는 없다.
 */
export function resolveEffect(
  group: number, variant: string, pool: EffectKey[],
  known?: Record<string, string>, cardId?: string, opts?: ResolveOpts,
): EffectRef | null {
  const learned = known ? learnSeries(known, opts?.meta) : undefined;
  const fromKnown = cardId && known ? known[cardId] : undefined;
  if (fromKnown) {
    const k = pool.find(e => e.effectId === fromKnown);
    if (k) return { effectId: k.effectId, level: "known", rank: k.rank };
    // 실측값이지만 ANSS 파일이 없다 = 전용 이펙트가 없다는 뜻
    return { effectId: fromKnown, level: "none", rank: 0 };
  }
  const mine = pool.filter(e => e.group === group);

  /**
   * 같은 버킷의 실측을 전파한다. **좁은 키(종류 포함)를 먼저** 본다 —
   * (12,07) 처럼 variant 만으로는 SL3(1214105)와 SL1/SL2(1214005)가 섞이는
   * 버킷을 종류 코드가 가른다.
   */
  const pre = variant.slice(0, 2);
  const famKind = opts?.kind ? learned?.[`${group}:${pre}:${opts.kind}`] : undefined;
  const fam = famKind ?? learned?.[`${group}:${pre}`];
  if (fam?.effectId) {
    const k = pool.find(e => e.effectId === fam.effectId);
    if (k) return { effectId: k.effectId, level: famKind ? "known-kind" : "family", rank: k.rank };
  }
  /**
   * 정확한 id 는 못 배웠어도 series 는 배웠다면, 그 series 안에서 리그로 sub 를
   * 고른다 (BEST NINE / TITLE HOLDER).
   */
  if (fam?.series) {
    const same = mine.filter(e => e.series === fam.series);
    const ls = leagueSub(same, opts?.league);
    if (ls) {
      const byLeague = pick(same.filter(e => e.sub === ls));
      if (byLeague) return { effectId: byLeague.effectId, level: "league", rank: byLeague.rank };
    }
  }

  // 규칙 예측이 그 연도에 실제로 있으면 그것을 쓴다
  const key = predictSeries(variant, pool, group, learned);
  if (key) {
    const same = mine.filter(e => e.series === key.series);
    const ls = leagueSub(same, opts?.league);
    const ruled = (ls ? pick(same.filter(e => e.sub === ls)) : null)
      ?? pick(mine.filter(e => e.series === key.series && e.sub === key.sub))
      ?? pick(mine.filter(e => e.series === key.series && e.sub === "00"))
      ?? pick(same);
    if (ruled) return { effectId: ruled.effectId, level: "rule", rank: ruled.rank };
  }

  const hit = pick(mine.filter(e => e.series === "01")) ?? pick(mine);
  if (hit) return { effectId: hit.effectId, level: "guess", rank: hit.rank };
  const any = pick(pool);
  return any ? { effectId: any.effectId, level: "guess", rank: any.rank } : null;
}

/** 같은 카드에 대해 바꿔볼 수 있는 후보들 — 정확도 높은 순. */
/** 같은 연도 그룹을 먼저, 그다음 나머지 — 전부 미검증 후보다. */
export function effectCandidates(
  group: number, variant: string, pool: EffectKey[],
  known?: Record<string, string>, opts?: ResolveOpts,
): EffectRef[] {
  const learnedFor = known ? learnSeries(known, opts?.meta) : undefined;
  const seen = new Set<string>(); const out: EffectRef[] = [];
  const push = (e: EffectKey, level: MatchLevel) => {
    if (seen.has(e.effectId)) return;
    seen.add(e.effectId); out.push({ effectId: e.effectId, level, rank: e.rank });
  };
  const order = (a: EffectKey, b: EffectKey) => (b.rank - a.rank) ||
    a.series.localeCompare(b.series) || a.sub.localeCompare(b.sub);
  const key = predictSeries(variant, pool, group, learnedFor);
  if (key) {
    pool.filter(e => e.group === group && e.series === key.series && e.sub === key.sub)
      .sort(order).forEach(e => push(e, "rule"));
    pool.filter(e => e.group === group && e.series === key.series)
      .sort(order).forEach(e => push(e, "rule"));
  }
  pool.filter(e => e.group === group).sort(order).forEach(e => push(e, "guess"));
  pool.slice().sort(order).forEach(e => push(e, "other"));
  return out;
}

/** 기본 표기는 일본어. 한국어는 app/i18n.tsx 의 MATCH_LABEL_KO 가 덮는다. */
export const MATCH_LABEL: Record<MatchLevel, string> = {
  known:  "実測マッピング",
  "known-kind": "実測の伝播（同グループ・同variant・同種類）",
  league: "リーグで sub 決定（BEST NINE / TITLE HOLDER）",
  family: "実測の伝播（同グループ・同variant）",
  none:   "専用エフェクトなし（実測）",
  rule:   "規則予測（variant→series）",
  guess:  "未検証推定（同年度）",
  other:  "未検証推定（他年度）",
  manual: "手動指定",
};
