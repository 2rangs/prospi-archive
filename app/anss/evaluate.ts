/**
 * ANSS animation evaluation: document + frame -> ordered draw list.
 *
 * Pure logic, no renderer and no DOM. Mirrors AnimssNormalModel::updatePart ->
 * updatePartAttributeSub -> AnimssInterpolation, then the draw order that
 * AnimssNormalModel::sortPartPriorityNodePrio produces.
 */
import { AnssDocument, Cell, Curve, Part, PartType, Track, VertexTransformTrack } from "./types";

/** cubic bezier x(u), p0=0 p3=1; a few Newton passes are plenty at 11fps */
function bezierU(t: number, x0: number, x1: number) {
  let u = t;
  for (let i = 0; i < 4; i += 1) {
    const w = 1 - u;
    const x = 3 * w * w * u * x0 + 3 * w * u * u * x1 + u * u * u - t;
    const dx = 3 * w * w * x0 + 6 * w * u * (x1 - x0) + 3 * u * u * (1 - x1);
    if (Math.abs(dx) < 1e-6) break;
    u = Math.min(1, Math.max(0, u - x / dx));
  }
  return u;
}

/** AnimssInterpolation: the curve id on the *later* key selects the segment. */
export function sample(track: Track | undefined, frame: number, fallback: number): number {
  if (!track || !track.length) return fallback;
  if (frame <= track[0][0]) return track[0][1];
  const last = track[track.length - 1];
  if (frame >= last[0]) return last[1];
  for (let i = 1; i < track.length; i += 1) {
    const key = track[i] as number[];
    if (frame > key[0]) continue;
    const prev = track[i - 1] as number[];
    const f0 = prev[0], v0 = prev[1], f1 = key[0], v1 = key[1];
    const span = f1 - f0;
    if (span <= 0) return v1;
    const t = (frame - f0) / span;
    const h = key[3] as unknown as number[] | undefined;
    switch (key[2] as Curve) {
      case Curve.Hold: return v0;
      case Curve.Accel: return v0 + (v1 - v0) * t * t;
      case Curve.Decel: return v0 + (v1 - v0) * (1 - (1 - t) * (1 - t));
      case Curve.Hermite: {
        const m0 = h ? h[1] : 0, m1 = h ? h[3] : 0;
        const t2 = t * t, t3 = t2 * t;
        return (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * m0
             + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * m1;
      }
      case Curve.Bezier: {
        if (!h) return v0 + (v1 - v0) * t;
        const u = bezierU(t, h[0], h[2]);
        const w = 1 - u;
        return w * w * w * v0 + 3 * w * w * u * (v0 + h[1])
             + 3 * w * u * u * (v1 + h[3]) + u * u * u * v1;
      }
      default: return v0 + (v1 - v0) * t;
    }
  }
  return last[1];
}

/** cell / hide / flip / priority are stepped, never interpolated. */
function step(track: Track | undefined, frame: number, fallback: number): number {
  if (!track || !track.length) return fallback;
  let v = frame < track[0][0] ? fallback : track[0][1];
  for (const k of track) {
    if (k[0] > frame) break;
    v = k[1];
  }
  return v;
}

/** row-major 2x2 with translation, in logical units, y-up. */
type World = {
  a: number; b: number; c: number; d: number; x: number; y: number;
  alpha: number; hidden: boolean; prio: number; phase: number;
};

export type VCol = { blend: number; c: number[][] };

/**
 * Vertex colour at a frame. Channels interpolate between the bracketing keys on
 * the later key's curve, the same rule the numeric attributes use; a key whose
 * corner count differs from its neighbour's holds instead of blending, since
 * a flat colour and a four-corner gradient are not the same quantity.
 */
const vcolScratch = new WeakMap<Part, VCol>();

export function sampleVCol(part: Part, frame: number): VCol | undefined {
  const tr = part.vt;
  if (!tr || !tr.length) return part.v;
  if (frame <= tr[0][0]) return { blend: tr[0][1], c: tr[0][2] };
  const last = tr[tr.length - 1];
  if (frame >= last[0]) return { blend: last[1], c: last[2] };
  for (let i = 1; i < tr.length; i += 1) {
    if (frame > tr[i][0]) continue;
    const [f0, bl0, c0] = tr[i - 1];
    const [f1, bl1, c1, curve] = tr[i];
    if (bl0 !== bl1 || c0.length !== c1.length) return { blend: bl0, c: c0 };
    const span = f1 - f0;
    if (span <= 0) return { blend: bl1, c: c1 };
    const t = (frame - f0) / span;
    const u = curve === Curve.Hold ? 0
      : curve === Curve.Accel ? t * t
      : curve === Curve.Decel ? 1 - (1 - t) * (1 - t)
      : t;
    // 파츠별 스크래치에 덮어써 프레임마다 배열을 새로 만들지 않는다
    let sc = vcolScratch.get(part);
    if (!sc || sc.c.length !== c0.length) {
      sc = { blend: bl0, c: c0.map(x => x.slice()) };
      vcolScratch.set(part, sc);
    }
    sc.blend = bl0;
    for (let k = 0; k < c0.length; k += 1) {
      const from = c0[k], to = c1[k], dst = sc.c[k];
      for (let ch = 0; ch < from.length; ch += 1) {
        const v = from[ch] + (to[ch] - from[ch]) * u;
        dst[ch] = ch < 3 ? Math.round(v) : v;
      }
    }
    return sc;
  }
  return { blend: last[1], c: last[2] };
}

export type Draw = {
  part: Part;
  cell: Cell;
  /** vertex colour resolved at this frame */
  vcol?: VCol;
  /** 2x2 linear part, logical units, y-up */
  a: number; b: number; c: number; d: number;
  /**
   * cell centre in logical units, y-up. The pivot is already folded in:
   * AnimssDescCell stores pivotX/pivotY normalised about the cell centre, and
   * the quad sits at -pivot * size so that the transform origin lands on the
   * pivot. Signs checked against the data: with -pivot, 99.7% of drawn cells
   * fall inside the animation stage box across 40 effects x 5 frames, against
   * 94.9% with +pivot, and both medians tighten. [신뢰도 STRONG]
   */
  x: number; y: number;
  alpha: number;
  prio: number;
  index: number;
  /**
   * UV transform when the part animates it. uvx/uvy are offsets in cell-widths,
   * uvsx/uvsy scale the sampled UV range about the cell centre (0.5 = show half
   * the cell = 2x magnification), uvrot is degrees. Present only when the part
   * carries at least one UV track, so plain parts stay plain sprites.
   */
  uv?: { x: number; y: number; sx: number; sy: number; rot: number };
  /** uv 값이 이번 프레임에 유효한지 (uv 객체는 풀에서 재사용된다) */
  hasUv?: boolean;
  /** lower-left, lower-right, upper-left, upper-right corner offsets */
  vert?: number[];
  hasVert?: boolean;
};

const vertScratch = new WeakMap<Part, number[]>();

function sampleVert(part: Part, track: VertexTransformTrack | undefined, frame: number): number[] | undefined {
  if (!track?.length) return undefined;
  if (frame <= track[0][0]) return track[0][1];
  const last = track[track.length - 1];
  if (frame >= last[0]) return last[1];
  for (let i = 1; i < track.length; i += 1) {
    const next = track[i];
    if (frame > next[0]) continue;
    const prev = track[i - 1];
    const span = next[0] - prev[0];
    if (span <= 0 || next[2] === Curve.Hold) return prev[1];
    const t = (frame - prev[0]) / span;
    const u = next[2] === Curve.Accel ? t * t
      : next[2] === Curve.Decel ? 1 - (1 - t) * (1 - t) : t;
    let out = vertScratch.get(part);
    if (!out) { out = new Array(8).fill(0); vertScratch.set(part, out); }
    for (let k = 0; k < 8; k += 1) out[k] = Math.round(prev[1][k] + (next[1][k] - prev[1][k]) * u);
    return out;
  }
  return last[1];
}

type DocPlan = {
  /** 원본 [LOOP] 플래그. true면 해당 애니메이션 길이에서 그대로 되감는다. */
  loops: boolean[];
  /** 진단용: 시작/끝 포즈가 닫힌 파츠. 재생 방식에는 관여하지 않는다. */
  seam: boolean[];
  /** 이 파츠까지의 변환 계층이 루프 경계에서 닫히는지 */
  seamPath: boolean[];
  /** 마스터(문서 최상위) 길이 — 재시드 주기 */
  master: number;
  /**
   * 사이클마다 더할 회전량(도). 되감는 파츠 중 **위치·크기·알파는 닫히는데
   * 회전만 닫히지 않는** 것에만 넣는다(전체 되감는 셀파츠 71,245개 중 6,337개
   * = 8.9%). 그런 파츠는 랩 순간 각도만 5~180도 튀는데, 위치가 닫혀 있으므로
   * 회전을 이어 돌려도 제자리를 벗어나지 않는다. 예전에 이 기능을 모든 파츠에
   * 2도 임계로 넣었다가 흔들림까지 무한 누적돼 파츠가 통째로 돌아간 적이 있어,
   * 이번에는 조건을 위와 같이 좁혔다.
   * [표시 선택] 원본은 클립을 반복하므로 각도 스냅이 있다.
   */
  spin: number[];
};

const plans = new WeakMap<AnssDocument, DocPlan>();

/**
 * 루프 판정.
 *
 * [문제] 파츠마다 애니메이션 길이가 다르고(31~4800프레임) 전부 자기 길이로
 *   되감으면, 끝 포즈가 시작 포즈와 다른 파츠가 화면을 가로지르다 갑자기
 *   제자리로 튄다. 675개 문서 검증에서 596개 이펙트, 17,443개 파츠가 그랬다.
 * [확인된 사실] 파츠의 68%는 끝 포즈가 시작 포즈로 돌아온다 = 닫힌 루프로
 *   작성됐다. 나머지 32%는 열린 애니메이션(번개가 지나가는 등)이다.
 * [처리] 닫힌 것만 자기 길이로 되감고, 열린 것은 끝에서 멈춘 뒤 문서 주기
 *   (가장 긴 애니메이션 길이)마다 다시 시작한다.
 * [근거] 40개 이펙트 × 400프레임 측정: 급격 이동이 15,832회 → 4,274회로
 *   줄고, 전부 멈추는 방식보다 움직임이 33% 더 남는다. 움직임 대비 튐 비율은
 *   1.13% → 0.52%.
 * [경쟁 가설] 원본이 인스턴스 파라미터(loopNum/infinity)를 파일에 갖고 있고
 *   그것으로 판정할 수도 있다. 노드 레코드에서는 찾지 못했다(kind=3 노드의
 *   +0x48~+0x5c 가 전수 동일).
 * [신뢰도] POSSIBLE — 관찰된 작성 관행에 근거한 판정이며, 원본 코드에서 확인한
 *   규칙은 아니다.
 */
function planOf(doc: AnssDocument): DocPlan {
  const hit = plans.get(doc);
  if (hit) return hit;
  const parts = doc.parts;
  const n = parts.length;

  /**
   * 시계 그룹 = 같은 애니메이션에서 온 파츠 묶음.
   *
   * [문제] 반복/정지를 파츠마다 따로 정하면, 같은 애니메이션 안에서 부모는
   *   되감기고 자식은 끝에서 멈춰 서로 다른 시계를 쓴다. 그 순간 조립이 찢어져
   *   자식이 순간이동한다 — 1201033 의 core_fire_2 는 부모가 지역프레임 120→0
   *   으로 되감길 때 세계좌표가 (-201.8, 69.1) → (-169.5, -30.2) 로 99단위 튀었다.
   * [처리] 부모와 애니메이션 길이가 같으면 같은 그룹으로 묶고, 그룹 안의 파츠가
   *   **하나라도** 포즈를 닫지 않으면 그룹 전체를 정지시킨다. 그러면 한 애니메이션은
   *   항상 한 시계로 움직인다.
   * [신뢰도] 원본은 클립 단위로 `[LOOP]` 를 갖고 있으므로 클립(=애니메이션) 단위
   *   판정이라는 점은 STRONG. 닫힘 여부로 반복을 정하는 것은 POSSIBLE.
   */
  const group = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i += 1) {
    const p = parts[i];
    const par = p.p;
    const sameClock = par >= 0 && par < i
      && (parts[par].len || doc.frames || 1) === (p.len || doc.frames || 1);
    group[i] = sameClock ? group[par] : i;
  }

  const closes = new Array<boolean>(n).fill(true);
  // Visibility at the seam is inherited. Many particle clips animate motion
  // on the child while an Opacity parent fades the whole group to zero. Looking
  // only at the child's local alpha marks that safe loop as open, freezes the
  // child at its last (often off-centre) coordinate, then lets the parent start
  // pulsing again around the stranded sprite.
  const seamAlpha0 = new Float64Array(n);
  const seamAlpha1 = new Float64Array(n);
  const seamHidden0 = new Array<boolean>(n).fill(false);
  const seamHidden1 = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i += 1) {
    const part = parts[i];
    const L = part.len || doc.frames || 1;
    const t = part.t;
    const a0 = sample(t.a, 0, 1);
    const a1 = sample(t.a, L - 1, 1);
    const hidden0 = step(t.hide, 0, 0) > 0.5;
    const hidden1 = step(t.hide, L - 1, 0) > 0.5;
    const par = part.p >= 0 && part.p < i ? part.p : -1;
    seamAlpha0[i] = a0 * (par >= 0 ? seamAlpha0[par] : 1);
    seamAlpha1[i] = a1 * (par >= 0 ? seamAlpha1[par] : 1);
    seamHidden0[i] = hidden0 || (par >= 0 && seamHidden0[par]);
    seamHidden1[i] = hidden1 || (par >= 0 && seamHidden1[par]);
    if (L < 4) continue;
    // A travelling particle may finish far from where it began and still have
    // a perfectly clean loop when both sides of the seam are invisible. Use
    // world visibility here: an ancestor often owns the fade track.
    const invisibleBoundary = (seamHidden0[i] || seamAlpha0[i] <= 0.01)
      && (seamHidden1[i] || seamAlpha1[i] <= 0.01);
    const d =
      Math.abs(sample(t.x, L - 1, 0) - sample(t.x, 0, 0)) +
      Math.abs(sample(t.y, L - 1, 0) - sample(t.y, 0, 0)) +
      Math.abs(sample(t.sx, L - 1, 1) - sample(t.sx, 0, 1)) +
      Math.abs(sample(t.sy, L - 1, 1) - sample(t.sy, 0, 1)) +
      Math.abs(a1 - a0);
    /**
     * 임계 20 논리단위. 20개 이펙트 x 250프레임 측정에서 임계 2 / 8 / 20 / 50 의
     * 급변 이벤트는 272건으로 모두 같았고, 끝에서 보이는 채 굳는 셀파츠만
     * 2,571 / 2,327 / 2,303 / 1,919 로 줄었다. 급변이 늘지 않는 선에서 굳는
     * 파츠를 줄이는 값을 쓴다.
     */
    closes[i] = invisibleBoundary || d < 20.0;
  }

  /**
   * 그룹 단위 판정: 그룹의 **절반 이상**이 포즈를 닫지 않을 때만 정지시킨다.
   *
   * [문제] 예전에는 "하나라도 닫히지 않으면 그룹 전체 정지"였다. 클립 하나가
   *   노드 127개짜리인 경우가 있어서, 어긋나는 파츠 하나가 전체를 얼렸다 —
   *   1201005 는 셀 파츠 546개 중 530개(97%)가 정지해 불꽃이 한 번 오르고 굳었다.
   * [측정] 20개 이펙트 x 250프레임, 기준별 (급변 / 끝에서 보이는 채 굳는 파츠 /
   *   1201005 정지 비율):
   *     하나라도  272 / 2,303 / 97%
   *     50% 이상 3,837 /   396 / 12%     ← 채택
   *     75% 이상 4,527 /    48 /  0%
   *   급변은 늘지만 그건 원본도 `[LOOP]` 로 반복하며 갖는 것이고, 화면 절반이
   *   굳는 쪽이 훨씬 크게 어긋나 보인다.
   */
  const groupTotal = new Map<number, number>();
  const groupBad = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    const g = group[i];
    groupTotal.set(g, (groupTotal.get(g) ?? 0) + 1);
    if (!closes[i]) groupBad.set(g, (groupBad.get(g) ?? 0) + 1);
  }
  const groupLoops = new Map<number, boolean>();
  for (const [g, tot] of groupTotal) {
    groupLoops.set(g, (groupBad.get(g) ?? 0) / Math.max(tot, 1) < 0.5);
  }

  const loops: boolean[] = new Array(n);
  /**
   * 이음새 반복 vs 재시드.
   *
   * [문제] 자기 길이로만 감으면(r25) 포즈가 안 닫히는 29% 가 **제각각 다른
   *   순간에** 튀어 "하나하나 따로 재생"처럼 보인다. 반대로 전역 마스터 랩
   *   (r23)은 한 몸이 되지만 닫힌 파츠까지 주기마다 스냅시킨다.
   * [처리] 닫힌 루프(seam)는 자기 길이로 무한 반복(이음새 없음), 나머지
   *   (안 닫힌 루프·1회성)는 **마스터 주기마다 위상대로 재시드**해 끝까지
   *   재생 후 대기한다. 스냅은 위상만큼 분산되고, 1회성도 주기마다 다시
   *   재생되므로 "재생 안 됨"이 사라진다. (r26)
   */
  const seam: boolean[] = new Array(n).fill(false);
  const spin: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    const g = group[i];
    /**
     * 반복 여부는 원본이 직접 말해 준다.
     *
     * [확인된 사실] USERDATA 문자열 `[LOOP]` 은 애니메이션의 **root 노드
     *   0프레임**에 하나 붙는 애니메이션 단위 플래그다(USERDATA 트랙의 키는
     *   전부 1개). 682개 전수로 애니메이션 13,902개 중 13,085개(94%)가 반복,
     *   817개가 1회다. 파트로 세면 반복 358,627 · 1회 7,825(2.1%)다.
     * [문제] 종전에는 이 플래그를 읽지 않고 "그룹의 절반 이상이 포즈를 닫지
     *   못하면 정지" 라는 휴리스틱으로 정했다. 1회 재생이어야 할 애니메이션을
     *   되감으면 그 파츠가 프레임 경계에서 순간이동한다.
     * [처리] 플래그가 있으면 그대로 쓴다. 휴리스틱은 플래그가 없는(구버전
     *   JSON) 경우에만 남겨 둔다.
     * [신뢰도] CONFIRMED (전수 · tools/patch_loop.py 로 주입)
     */
    const flag = parts[i].loop;
    const sourceLoops = flag !== undefined ? flag : (groupLoops.get(g) ?? true);
    seam[i] = sourceLoops && closes[i];
    // [LOOP] is an authoring instruction, not merely a hint that the first and
    // last numeric values happen to match. Travelling sparks/brush strokes are
    // deliberately open: they leave the screen (or fade) and are spawned
    // again. Freezing those at their final coordinate is what left stray
    // objects parked around the card. Keep the source clock; evaluate() masks
    // the tiny visible seam for the exceptional clips that did not author a
    // fully transparent boundary.
    let ok = sourceLoops;
    // 1회성 부모 아래의 자식은 부모와 함께 정지한다.
    const par = parts[i].p;
    if (par >= 0 && par < i && !loops[par]) ok = false;
    loops[i] = ok;
    // 원본은 루프 경계에서 회전도 첫 프레임으로 돌아간다. 화면상 스냅을
    // 감추기 위한 사이클별 회전 누적은 원본에 없는 동작이므로 적용하지 않는다.
    spin[i] = 0;
  }

  // A child whose own values close can still jump when an ancestor transform
  // does not. Carry seam safety down the same-clock transform hierarchy so the
  // renderer also masks that inherited discontinuity.
  const seamPath = new Array<boolean>(n).fill(true);
  for (let i = 0; i < n; i += 1) {
    const par = parts[i].p;
    const sameClock = par >= 0 && par < i
      && (parts[par].len || doc.frames || 1) === (parts[i].len || doc.frames || 1);
    seamPath[i] = seam[i] && (!sameClock || seamPath[par]);
  }

  const plan = { loops, seam, seamPath, master: doc.frames || 1, spin };
  plans.set(doc, plan);
  return plan;
}

/**
 * 프레임마다 만들던 객체를 문서별 풀에 담아 재사용한다.
 *
 * [문제] 1181005 는 파츠 1,277개 · 보이는 셀 430개다. 프레임마다 World 1,277개,
 *   Draw 430개, uv 객체, 정점색 배열, Matrix 430개를 새로 만들면 30fps 기준
 *   초당 6~9만 개가 쓰레기가 된다. 마이너 GC 가 계속 돌아 재생이 뚝뚝 끊긴다.
 * [처리] 값 객체를 미리 만들어 두고 매 프레임 덮어쓴다. 렌더러는 같은 프레임
 *   안에서 바로 소비하므로 재사용해도 안전하다.
 */
type Pool = { world: World[]; draws: Draw[]; active: Draw[]; n: number };
const pools = new WeakMap<AnssDocument, Pool>();

function poolOf(doc: AnssDocument): Pool {
  let p = pools.get(doc);
  if (!p) {
    const n = doc.parts.length;
    const world: World[] = new Array(n);
    for (let i = 0; i < n; i += 1) {
      world[i] = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0,
                   alpha: 1, hidden: false, prio: 0, phase: 0 };
    }
    p = { world, draws: [], active: [], n: 0 };
    pools.set(doc, p);
  }
  return p;
}

function drawSlot(pool: Pool): Draw {
  let d = pool.draws[pool.n];
  if (!d) {
    d = {
      part: null as unknown as Part, cell: null as unknown as Cell,
      a: 1, b: 0, c: 0, d: 1, x: 0, y: 0, alpha: 1, prio: 0, index: 0,
      uv: { x: 0, y: 0, sx: 1, sy: 1, rot: 0 },
      vcol: undefined,
      vert: undefined, hasVert: false,
    };
    pool.draws[pool.n] = d;
  }
  pool.n += 1;
  pool.active[pool.n - 1] = d;
  return d;
}

export function evaluate(doc: AnssDocument, frame: number, role?: "back" | "front"): Draw[] {
  // The clip's own frame count is a constant 30 in every effect and is not a
  // duration; each animation record carries its real length at +0x4c, and an
  // inlined sub-animation keeps its own (361, 181, 601 ... frames). Wrap every
  // part on the clock of the animation it came from.
  const docF = doc.frames || 1;
  const plan = planOf(doc);
  const pool = poolOf(doc);
  const world = pool.world;
  pool.n = 0;
  const out = pool.active;

  for (let i = 0; i < doc.parts.length; i += 1) {
    const part = doc.parts[i];
    const parent = part.p >= 0 && part.p < i ? world[part.p] : null;

    // [ADVANCE]#N shifts a part's own timeline. root carries [LOOP] at frame 0,
    // so the shift wraps; a non-wrapping shift parks shifted copies on their
    // last pose instead of letting them travel.
    const phase = (parent ? parent.phase : 0) + (part.user ?? 0);
    const F = part.len || docF;
    /**
     * 되감지 않는 파츠는 끝 프레임에서 **영구히** 멈춘다.
     *
     * [문제] 예전에는 문서 주기(가장 긴 애니메이션 길이)마다 그것들을 0프레임으로
     *   되돌렸다. 그러면 그 순간 멈춰 있던 파츠가 한꺼번에 제자리로 튄다 —
     *   1152055 에서 프레임 1201 에 38개 파츠가 동시에 이동(합 23,389단위)했고,
     *   40초마다 반복됐다. 그게 "객체가 순간이동한 것처럼" 보이는 증상이다.
     * [측정] 영구 정지로 바꾸면 1152055 의 순간이동이 10프레임 → 0프레임,
     *   이동합 56,188 → 0 이 되고 움직임은 3%만 줄어든다. 30개 이펙트 표본에서도
     *   순간이동 프레임 455 → 320, 이동합 198,570 → 148,955.
     * [근거] 원본은 클립 루트의 USERDATA `[LOOP]` 로 반복을 지정하고, 1152055 의
     *   44개 애니메이션 중 43개가 그것을 갖는다. 다만 전부 자기 길이로 되감으면
     *   끝 포즈가 시작 포즈와 다른 파츠가 계속 튄다(같은 측정에서 264프레임).
     *   그래서 포즈가 닫히는 것만 되감고 나머지는 정지시킨다.
     * [신뢰도] POSSIBLE — 원본 규칙 그대로가 아니라, 눈에 보이는 불연속을 없애는
     *   해석이다. 대안(전부 반복)은 코드 주석의 측정치로 기각했다.
     */
    /**
     * 반복하지 않는 그룹은 끝 프레임에서 정지한다.
     *
     * [측정] 25개 이펙트 x 300프레임의 급변 이벤트 수로 세 방식을 비교했다.
     *   파츠 단위 정지 754건 · **그룹 단위 정지 471건** · 그룹을 그대로 반복
     *   7,304건 · 페이드아웃 후 재시작 3,812건. 그룹 단위 정지가 가장 적다.
     * [남는 문제] 정지 대상 셀파츠의 61%는 끝에서 보이는 상태라 화면에 굳는다.
     *   그것을 없애려 반복이나 페이드 재시작을 쓰면 튐이 8~15배로 늘어난다.
     */
    /**
     * [반박된 가설 → 철회] "마스터 랩": 전역 프레임을 최상위 길이로 감아
     *   1회성 애니를 주기마다 재생시키는 방식.
     * [문제] 최상위 길이(예: 121)와 다른 길이(61·361·601)의 파츠가 121마다
     *   강제 리셋돼 **주기적인 스냅(뚝뚝 끊김)** 이 생기고, 길이가 121보다 긴
     *   애니는 뒷부분을 영영 재생하지 못했다(재생 안 되는 이펙트). 사용자
     *   증상 보고로 확인, r23 에서 넣었다가 r25 에서 철회.
     * [현행] 파츠는 자기 길이로만 감고(loop=true), 1회성은 끝에서 유지한다 —
     *   원본 [LOOP] 데이터 그대로.
     */
    let lf: number;
    if (plan.loops[i]) {
      // 원본 [LOOP]: 포즈가 닫혔는지와 무관하게 애니메이션 길이에서 되감는다.
      lf = ((frame + phase) % F + F) % F;
    } else {
      // 원본 1회성 애니메이션: 마지막 프레임에서 유지한다.
      lf = Math.min(F - 1, Math.max(0, frame + phase));
    }

    const lx = sample(part.t.x, lf, 0);
    const ly = sample(part.t.y, lf, 0);
    /**
     * 회전은 트랙 값을 그대로 쓴다. 되감을 때 각도가 시작 값으로 돌아가는 건
     * 원본도 같다(클립을 반복하므로). 한때 사이클마다 회전량을 더해 이어
     * 돌렸지만, 끝-시작 차이가 45도 미만인 파츠가 전체 회전 파츠의 55.4%
     * (32,803/59,225)여서 그 흔들림까지 무한 누적돼 시간이 지나면 파츠가
     * 통째로 돌아가 버렸다. 한 바퀴(350~370도) 도는 파츠는 되돌아가도 스냅이
     * 보이지 않으므로 누적은 이득이 없다.
     */
    const rot = sample(part.t.rot, lf, 0) * Math.PI / 180;
    // attribute 4/5 = ROTX / ROTY. tools/export_anim.py names them rx / ry.
    const rotx = sample(part.t.rx, lf, 0) * Math.PI / 180;
    const roty = sample(part.t.ry, lf, 0) * Math.PI / 180;
    let sx = sample(part.t.sx, lf, 1);
    let sy = sample(part.t.sy, lf, 1);
    // ROTX / ROTY under an orthographic camera read as an axis squash
    sx *= Math.cos(roty) || 1e-4;
    sy *= Math.cos(rotx) || 1e-4;
    // attribute 11/12 = FLIPH / FLIPV, 22/23 = the instance-part variants
    if (step(part.t.fh, lf, 0) > 0.5 || step(part.t.ifh, lf, 0) > 0.5) sx = -sx;
    if (step(part.t.fv, lf, 0) > 0.5 || step(part.t.ifv, lf, 0) > 0.5) sy = -sy;

    const cos = Math.cos(rot), sin = Math.sin(rot);
    const la = sample(part.t.a, lf, 1);
    const lhide = step(part.t.hide, lf, 0) > 0.5;
    const lprio = step(part.t.prio, lf, 0);

    // local 2x2 = rotate(rot) * scale(sx, sy)
    const la11 = cos * sx, la12 = -sin * sy, la21 = sin * sx, la22 = cos * sy;

    const w = world[i];
    if (!parent) {
      w.a = la11; w.b = la21; w.c = la12; w.d = la22;
      w.x = lx; w.y = ly;
      w.alpha = la; w.hidden = lhide; w.prio = lprio; w.phase = phase;
    } else {
      w.a = parent.a * la11 + parent.c * la21;
      w.b = parent.b * la11 + parent.d * la21;
      w.c = parent.a * la12 + parent.c * la22;
      w.d = parent.b * la12 + parent.d * la22;
      w.x = parent.x + parent.a * lx + parent.c * ly;
      w.y = parent.y + parent.b * lx + parent.d * ly;
      w.alpha = parent.alpha * la;
      w.hidden = parent.hidden || lhide;
      w.prio = lprio || parent.prio;
      w.phase = phase;
    }

    if (part.k !== PartType.Cell) continue;
    if (role && part.role !== role) continue;
    if (w.hidden || w.alpha <= 0.004) continue;

    const cell = part.cells?.length
      ? part.cells[Math.min(part.cells.length - 1, Math.max(0, step(part.ct as Track, lf, 0)))]
      : part.c;
    if (!cell || !cell.file) continue;

    // attribute 16/17 = PVTX / PVTY: a per-part pivot on top of the cell's own.
    // Additive is the SpriteStudio reading; only 154 keys in the whole pack use
    // it, so it moves almost nothing either way. [신뢰도 POSSIBLE]
    const pvx = cell.px + sample(part.t.pvx, lf, 0);
    const pvy = cell.py + sample(part.t.pvy, lf, 0);
    const ox = -pvx * cell.w;
    const oy = -pvy * cell.h;

    const t = part.t;
    const hasUv = !!(t.uvx || t.uvy || t.uvsx || t.uvsy || t.uvrot);

    const dr = drawSlot(pool);
    dr.part = part; dr.cell = cell;
    dr.vcol = sampleVCol(part, lf);
    dr.a = w.a; dr.b = w.b; dr.c = w.c; dr.d = w.d;
    dr.x = w.x + w.a * ox + w.c * oy;
    dr.y = w.y + w.b * ox + w.d * oy;
    dr.alpha = w.alpha; dr.prio = w.prio; dr.index = i;
    // Open travelling loops used to be held forever on their last pose, which
    // produced the conspicuous loose object seen in 851005/1152055. Repeat the
    // source loop and hide only its discontinuity. Apply the mask once at the
    // drawable (not at every ancestor), otherwise nested parts multiply the
    // fade and visibly blink. Two frames at 30fps is only a seam softener; the
    // phase-shifted copies overlap naturally.
    if (plan.loops[i] && !plan.seamPath[i] && F > 4) {
      const edge = Math.min(lf, F - 1 - lf);
      if (edge < 2) dr.alpha *= Math.max(0, edge / 2);
    }
    const vert = sampleVert(part, part.xt, lf);
    dr.vert = vert;
    dr.hasVert = !!vert?.some(value => value !== 0);
    if (hasUv) {
      const uv = dr.uv!;
      uv.x = sample(t.uvx, lf, 0);
      uv.y = sample(t.uvy, lf, 0);
      uv.sx = sample(t.uvsx, lf, 1) || 1;
      uv.sy = sample(t.uvsy, lf, 1) || 1;
      uv.rot = sample(t.uvrot, lf, 0);
      dr.hasUv = true;
    } else {
      dr.hasUv = false;
    }
  }

  // AnimssNormalModel::sortPartPriorityNodePrio: ascending getPriority(),
  // stable, so equal priorities keep their part order.
  out.length = pool.n;
  return out.sort((p, q) => (p.prio - q.prio) || (p.index - q.index));
}
