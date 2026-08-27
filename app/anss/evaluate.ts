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

/**
 * 구간의 보간 곡선은 **시작 키**에 저장돼 있다.
 *
 * [문제] 종전에는 늦은 쪽 키에서 곡선과 핸들을 읽었다. 그러면 이징이 한 구간씩
 *   밀려서, 베지어로 감속해야 할 구간이 등속으로 가고 등속이어야 할 구간이
 *   베지어가 된다. Hold(0) 구간도 함께 밀리므로 멈춰 있어야 할 파츠가 움직이고
 *   움직여야 할 파츠가 멈춘다.
 * [측정] 원본 CHK 150개에서 핸들이 실린 트랙 9,896개 중
 *   **첫 키에 핸들 7,164개(72%) · 끝 키에 핸들 549개(5.5%)**.
 *   실제 트랙도 `(f0, curve 3, [4,0,-4,0]) (f50, curve 1, [0,0,0,0])` 처럼
 *   곡선과 핸들이 구간 시작에 붙어 있고 끝 키는 기본값이다.
 * [해석] 마지막 키는 뒤따르는 구간이 없으므로 곡선을 가질 이유가 없다.
 *   72% 대 5.5% 는 소유자가 시작 키라는 뜻이다.
 * [신뢰도] CONFIRMED (원본 전수 통계 + 트랙 실물)
 */
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
    const h = prev[3] as unknown as number[] | undefined;
    switch (prev[2] as Curve) {
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
        /**
         * 시간 핸들은 **프레임 단위 오프셋**이다 — 구간 길이로 나눠야 한다.
         *
         * [확인된 사실] 핸들이 실린 74,238개 구간에서 h[0] 중앙 4.0 ·
         *   h[2] 중앙 -6.0 · 구간 길이 중앙 20 이고, **97.2%가 h[0]>1 또는
         *   h[2]<-1** 이라 0..1 정규 좌표로는 성립하지 않는다.
         *   h[0]/span 과 h[2]/span 은 (0.2,-0.2) (0.1,-0.1) (0.3,-0.3) 처럼
         *   대칭 이징 값에 몰린다.
         * [해석] 키 저장 형식은 [바깥핸들Δ프레임, 바깥핸들Δ값,
         *   다음키 안쪽핸들Δ프레임(음수), 그 Δ값] 이다. 값 쪽은 이미 오프셋으로
         *   쓰고 있어 맞다(|h[1]|/|Δ값| 중앙 0.023 · >1 은 1.1%).
         * [증상] 정규화 없이 넣으면 x(u) 가 단조가 아니게 되어 뉴턴 해가 튀고,
         *   이징이 사실상 사라져 **등속으로 미끄러지는** 움직임이 된다.
         * [신뢰도] CONFIRMED (코퍼스 전수 통계)
         */
        const x0 = Math.min(1, Math.max(0, h[0] / span));
        const x1 = Math.min(1, Math.max(0, 1 + h[2] / span));
        const u = bezierU(t, x0, x1);
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
 * the **starting** key's curve, the same rule the numeric attributes use; a key whose
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
    const [f0, bl0, c0, curve] = tr[i - 1];
    const [f1, bl1, c1] = tr[i];
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
  /** 조상 그룹 블렌드까지 반영한 실효 블렌드 (plan.blend) */
  blend?: number;
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
    if (span <= 0 || prev[2] === Curve.Hold) return prev[1];
    const t = (frame - prev[0]) / span;
    const u = prev[2] === Curve.Accel ? t * t
      : prev[2] === Curve.Decel ? 1 - (1 - t) * (1 - t) : t;
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
  /** 이음매를 가릴 페이드 길이(프레임). 점프 크기 / 이음매 속도에서 유도한다. */
  seamFade: Float64Array;
  /** 마스터(문서 최상위) 길이 — 재시드 주기 */
  master: number;
  /** 1회성 파츠가 다 같이 처음으로 돌아가는 공용 주기(프레임) */
  cycle: number;
  /** 조상 그룹의 블렌드까지 반영한 파츠별 실효 블렌드 */
  blend: number[];
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

  const seamFade = new Float64Array(n);
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
    /**
     * 이음매 페이드 길이를 **점프 크기에서 유도**한다.
     *
     * [문제] 사용자 보고 "쓸데없이 사방팔방에서 파츠 날라오는 게 문제".
     *   [LOOP] 이 붙었지만 끝 포즈가 시작 포즈로 돌아오지 않는 파츠는 주기마다
     *   시작점으로 순간이동한다. 종전 마스크는 **고정 2프레임**(30fps에서 67ms)
     *   이라 멀리 이동하는 파츠의 되돌아감을 전혀 가리지 못했다.
     * [규모] 2프레임 이동거리보다 훨씬 큰 점프를 가진 셀파츠가 **36,350개**.
     *   (품질 라벨과는 무관 — minor 0.186 vs clean 0.237 로 편중이 없다.
     *    즉 특정 이펙트의 결함이 아니라 전체에 걸친 표시 결함이다.)
     * [처리] 그 거리를 **원래 속도로 이동하는 데 걸리는 시간** 만큼 페이드한다.
     *   fade = jump / speed(이음매 근처 1프레임 이동량). 임의 상수가 아니라
     *   파츠 자신의 운동에서 나온 값이다. 상한은 주기의 1/4 로 둔다 — 그 이상
     *   가리면 파츠가 사라지는 시간이 재생보다 길어진다.
     * [신뢰도] 유도식 CONFIRMED / 상한 1/4 은 표시 선택.
     */
    const jx = sample(t.x, L - 1, 0) - sample(t.x, 0, 0);
    const jy = sample(t.y, L - 1, 0) - sample(t.y, 0, 0);
    const jump = Math.hypot(jx, jy);
    const sx1 = sample(t.x, 1, 0) - sample(t.x, 0, 0);
    const sy1 = sample(t.y, 1, 0) - sample(t.y, 0, 0);
    const spd = Math.hypot(sx1, sy1);
    seamFade[i] = spd > 1e-3
      ? Math.min(Math.floor(L / 4), Math.ceil(jump / spd))
      : (jump > 20 ? Math.floor(L / 4) : 0);
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

  /**
   * 1회성 파츠의 **공용 재시작 주기**.
   *
   * [문제] 1회성 파츠는 자기 길이 끝에서 영원히 고정된다. 그런데 마스터 클럭은
   *   감기지 않으므로, 움직이는 파츠가 대부분 1회성인 이펙트는 그 길이를 지나는
   *   순간 **배경 전체가 정지 화면이 된다**.
   * [측정] 전수 681개에서 움직이는 파츠의 50% 이상이 1회성인 이펙트가 20개(3%),
   *   15~50%가 35개(5%)다. 216004 는 f239 이후 픽셀이 완전히 동일해지고
   *   (f241·f300·f600·f1200 전부 8442/33.1), 141004·111073 계열은 f73·f60,
   *   즉 **2초 만에** 멈춘다.
   * [해석] 게임에서 카드 배경은 계속 재생된다. 1회성은 "한 번 재생하고 끝"이
   *   아니라 "한 번 재생하고 게임이 다시 트리거"다. 우리 뷰어에는 그 트리거가
   *   없으니 직접 만들어 준다.
   * [처리] 1회성 파츠 전체가 **같은 순간에** 처음으로 돌아가도록 공용 주기를
   *   쓴다. 주기 = **1회성 파츠 길이의 최댓값** — 1회성 내용이 다 끝나는 순간이
   *   곧 게임이 다시 트리거하는 순간이다. 문서 길이까지 늘려 잡으면 141004
   *   (1회성 길이 73, 문서 200)처럼 6.7초 중 4초가 정지로 남는다. 파츠마다 자기
   *   길이로 감으면 제각각 다른 순간에 튀어 "따로따로 재생"으로 보이는데
   *   (r23/r25 에서 겪음), 한 순간에 모아 두면 원본이 다시 트리거된 것처럼 읽힌다.
   * [반박된 대안] 1회성을 그냥 loop 로 바꾸기 — 열린 애니메이션이 매 길이마다
   *   튀고, 원본 [LOOP] 플래그를 무시하게 된다.
   * [신뢰도] 정지 현상 CONFIRMED(픽셀 실측) · 재시작 주기 선택 STRONG
   */
  let cycle = 0;
  for (let i = 0; i < n; i += 1) {
    if (loops[i]) continue;
    const L = parts[i].len || doc.frames || 1;
    if (L > cycle) cycle = L;
  }
  // 1회성이 없으면 이 값은 안 쓰인다. 0 나눗셈만 막아 둔다.
  if (cycle < 1) cycle = doc.frames || 1;

  /**
   * 그룹 노드의 블렌드는 **하위 트리 전체**의 합성 방식이다.
   *
   * [확인된 사실] 원본 노드 레코드(+0x48)에서 `kind 0`(Group) 1,442개와
   *   `kind 3`(RefAnime) 14개가 Add 를 갖는다. SpriteStudio 에서 그룹 블렌드는
   *   그 아래 파츠를 묶어 합성하는 방식이지, 그룹 자체가 뭘 그리는 게 아니다.
   * [문제] 렌더러는 그리는 셀 파츠 자신의 `bl` 만 봤다. 그래서 Add 그룹 아래의
   *   Mix 셀이 불투명하게 얹혀 광채에 녹지 않고 판처럼 떠 보인다.
   * [측정] 셀 파츠 159,997개 중 **1,038개(0.6%)** 가 조상 블렌드와 다르게
   *   그려지고 있었다(Add→Mix 1,036 · Multiply→Add 2). 영향 이펙트 **35 / 682**.
   *   1171004 계열이 각각 56개로 가장 많다.
   * [처리] 부모에서 내려온 블렌드를 물려주되, 그룹/인스턴스가 자기 블렌드를
   *   가지면 그 지점부터 하위에 그것을 적용한다. 셀 자신이 Add 를 명시하면
   *   그대로 둔다(원본도 셀 단위 지정이 우선이다).
   * [신뢰도] 구조 STRONG (원본 노드 블렌드 전수) · 우선순위 규칙 POSSIBLE
   */
  /**
   * [철회] "UV 스케일 0 은 키 단위로 1 로 읽는다" 를 되돌린다.
   *
   * [문제] 사용자 보고 — 1285005 의 `fan02_02_1`/`fan02_01_2` 파편이 원본에선
   *   "전혀 퍼지지 않는데" 우리 렌더에선 밖으로 날아간다.
   * [원인] 그 조각들의 트랙은 `sy 1.0 -> 0.0` 과 `uvsy 1.0 -> 0.0` 이다. 즉
   *   날아가면서 **세로로 0 까지 수축해 사라지는** 연출이다. 그런데 이 재작성이
   *   `uvsy` 의 0 키를 1 로 바꿔 **수축을 지워** 조각이 끝까지 온전히 보였다.
   * [측정] uvs=0 키 23,813개 중 숨김/투명 6,812개를 빼면
   *     기하 스케일도 0 인 것(동시 수축)  11,993개 = **70.5%**
   *     기하는 살아 있는 것(단색 사각 위험) 5,008개 = 29.5%
   *   다수가 동시 수축이므로 0 을 1 로 바꾸는 것은 잘못이다.
   * [대체 처리] 아래 evaluate 에서 UV 창이 0 에 가까우면 **그리지 않는다**.
   *   창 면적이 0 이면 표시할 텍스처가 없으므로, 창을 억지로 키우는 것보다
   *   그리지 않는 것이 맞다. 이것으로 종전의 "단색 사각형" 증상도 함께 없어진다.
   * [신뢰도] 동시 수축 70.5% = CONFIRMED · 0 창을 안 그리는 것 = 기하적으로 자명
   */
  /**
   * (참고 — 종전 주석) UV 스케일 0 은 **키 단위로** 1 로 읽는다.
   *
   * [문제] 렌더러는 `sample(t.uvsx, lf, 1) || 1` 로 **보간 결과**가 정확히 0 일
   *   때만 1 로 바꿨다. 그래서 1.0 -> 0.0 으로 가는 트랙은 0.5, 0.2, 0.05 …
   *   를 거치며 UV 창이 한 점으로 오그라들고, 쿼드 전체가 **텍셀 하나를 늘린
   *   단색 사각형**이 된다. 그러다 정확히 0 에서만 갑자기 원래 크기로 돌아온다.
   *   화면에서 "네모난 게 떠다니는" 증상이 이것이다.
   * [측정] `uvsx` 가 0 인 키 중 그 프레임에 **알파가 살아 있는 것이 4,033개**
   *   (숨겨진 것은 610개). 즉 대부분 화면에 보이는 상태에서 0 을 지난다.
   *   전체 uvs 키 82,808개 중 값이 0 인 것이 24,021개(29%)다.
   * [아직 모르는 것] 이 속성이 절대 배율인지 1 기준 증분인지는 데이터만으로
   *   못 가린다 — 트랙 첫 키가 0.0 인 것 38% · 1.0 인 것 38% 로 갈린다.
   *   다만 `uvsx = -1` 정적 트랙 346개는 절대(좌우 반전)로 읽어야 말이 되고,
   *   0 은 어느 쪽으로 읽어도 "그대로"여야 한다.
   * [처리] 그래서 값 자체는 절대로 두고, **0 인 키만 1 로 바꾼 뒤 보간**한다.
   *   0 이 아닌 값의 의미는 하나도 바뀌지 않고, 붕괴 구간만 사라진다.
   * [신뢰도] 붕괴가 사각형을 만든다 = CONFIRMED(기하) · 0 의 의미 = POSSIBLE
   */

  const blend: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    const p = parts[i];
    const par = p.p;
    const up = par >= 0 && par < i ? blend[par] : 0;
    const own = p.bl ?? 0;
    blend[i] = own || up;
  }

  const plan = { loops, seam, seamPath, seamFade, master: doc.frames || 1, spin, cycle, blend };
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

/**
 * [LOOP] 을 **왕복(ping-pong)** 으로 되감는다.
 *
 * [문제] 톱니(0..F-1 반복)로 감으면 끝 키와 시작 키 값이 다른 트랙이 주기마다
 *   그 차이만큼 **순간이동**한다. 1285005 의 `fan01_set` 은 x 가 -89 -> -47.9,
 *   `fan01_01_anime02_3` 은 -47 -> -163.4 로 끝나므로 31프레임마다 튄다.
 *   사용자 표현: "동시에 고리로 재생되는 애니메이션인데 왜 바람처럼 날라가노".
 * [측정] 1285005 의 한 프레임 최대 도약 **578.3 -> 39.0**.
 *   682개 전체: 프레임당 40단위 초과 도약 **25,733 -> 20,490 (-20%)**,
 *   최대 도약 중앙 33 -> 28, 이동량 합은 -3% 로 거의 그대로.
 *   **30% 이상 개선 87개 · 30% 이상 악화 0개.**
 * [경쟁 가설] `[LOOP]` 이 그냥 톱니 반복이고 왕복은 원본에 없을 수 있다.
 *   인스턴스 파라미터(속성 31)는 코퍼스에 키가 2개뿐이라 파일에서 왕복 여부를
 *   고를 방법이 없다. 즉 전역 기본값으로 두는 선택이다.
 * [신뢰도] POSSIBLE — 근거는 "악화가 0" 과 사용자 증상 일치다. 원본 규칙
 *   그대로라는 증거는 없다. `window.__anssPingPong = false` 로 되돌릴 수 있다.
 */
let pivotYSign = -1;
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__anssPivotY", {
    get: () => pivotYSign,
    set: (v: number) => { pivotYSign = v < 0 ? -1 : 1; },
    configurable: true,
  });
}

let pingPong = false;
export function setPingPong(v: boolean) { pingPong = v; }
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__anssPingPong", {
    get: () => pingPong,
    set: (v: boolean) => { pingPong = !!v; },
    configurable: true,
  });
}

/**
 * 인스턴스 시간차(`user`)의 부호.
 *
 * [배경] 사무라이 재팬(series 51/52)의 로고 광택 `logo_eff01` 은 같은 클립을
 *   **4번 인스턴스**하며 `user` = 0 / 15 / 30 / 45 의 시간차를 갖는다(둘은 좌우
 *   반전). 알파는 0 -> 1(f28) -> 0(f60) 의 1회성 섬광이다.
 * [문제] 현행은 `frame + user` 로 읽어 **앞당긴다**. 전역 프레임 0에서 사본들이
 *   이미 local 0/15/30/45 에 있어 세 겹이 동시에 켜져 로고를 덮는다
 *   (사용자 보고 "samurai japan 글자에 덮히는 블렌드가 심해").
 * [대안] `frame - user` = **늦춘다**. 사본이 순서대로 하나씩 스쳐 지나간다.
 * [주의] 파티클 경로는 익스포터가 이미 음수 `user` 를 넣어 지연을 표현하므로,
 *   부호를 뒤집으면 파티클은 반대로 앞당겨진다. 그래서 기본값은 현행 유지이고
 *   `window.__anssPhaseSign = -1` 로 A/B 비교만 할 수 있게 둔다.
 * [신뢰도] 문제 재현 CONFIRMED / 올바른 부호는 육안 대조 대기.
 */
/**
 * `[ADVANCE]#N` 적용 계수. **기본 0 = 적용하지 않음.**
 *
 * [문제] 사용자 보고 "1285005 자꾸 퍼짐 / 회오리처럼 빠져나가는 게 아니라
 *   원형으로 유지되어야 함".
 * [측정] `eff_t`/`eff_u` 는 트랜스폼 트랙이 없는 정지 판이고, 움직임은 조상
 *   `eff_set`(y 276 -> -288, 60프레임)이 만든다. 그 사본 8개 중 **4개만 누적
 *   phase 15** 를 받아, 같은 순간에 4개는 한 반경 · 4개는 다른 반경에 놓인다.
 *   그래서 고리가 조각나고 나선처럼 퍼진다.
 * [실험] ADVANCE 를 0 으로 두고 f20 을 렌더하면 **동심 닫힌 고리**가 된다
 *   (캡처 대조). 사용자가 말한 모습과 일치한다.
 * [기각] 부호 반전(frame - N)은 루프에서 위상 집합이 같아 **화면상 차이 없음**
 *   (A/B 캡처 동일). 원인이 부호가 아니라 오프셋 자체임을 확인.
 * [보존] 파티클 시차는 유지한다. 전수 확인 결과 **음수 user 2,476개는 전부
 *   particle_ 노드**, 양수 27,531개는 ADVANCE 라 부호로 정확히 갈린다.
 * [철회 — r88] r86 의 전면 해제와 r87 의 파츠별 판정 모두 **철회**했다.
 *   전면 해제는 로고 반짝임 캐스케이드를 껐고(사용자 보고), 파츠별 판정도
 *   1152055 의 로고 사본 4개가 동일 알파(0.74)로 나와 의도대로 동작하지
 *   않았다. ADVANCE 는 파일이 명시한 값이므로 **그대로 적용**한다.
 *   1285005 의 "퍼짐"은 다른 원인을 더 찾아야 한다 — ADVANCE 를 끄면
 *   고리가 동심원이 되는 것은 관찰했지만(캡처), 그게 올바른 해석이라는
 *   근거는 아직 없다.
 * [되돌리기] `window.__anssAdvance = 0` 으로 전면 해제할 수 있다.
 * [신뢰도] 시각 대조 CONFIRMED / 전 이펙트 영향은 사용자 검토 대기.
 */
let advanceScale = 1;
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__anssAdvance", {
    get: () => advanceScale,
    set: (v: number) => { advanceScale = Number(v) ? 1 : 0; },
    configurable: true,
  });
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
    // 파티클 시차(음수)는 그대로, ADVANCE(양수)는 advanceScale 로 제어
    /**
     * ADVANCE 는 **원본이 명시한 위상 시차**다. 그대로 적용한다.
     *
     * [확인된 사실] 한 부모 아래 같은 클립을 참조하는 인스턴스 묶음의 ADVANCE
     *   값은 그 클립 길이를 인스턴스 수로 **균등 분할**한다.
     * [근거] 파일 250개 전수. 서로 다른 ADVANCE 를 2개 이상 가진 인스턴스 묶음
     *   3,150개 중 2,246개(71.3%)에서 값 간격이 정확히 `(len-1)/N` 이다.
     *   1285005 실측: round_03 len 61 · 12사본 -> 5,10,…,55 (12×5=60)
     *                 outsideflame len 41 · 4사본 -> 10,20,30 (4×10=40)
     *                 tubu01 len 91 · 3사본 -> 30,60 (3×30=90)
     *                 tububase len 361 · 2사본 -> 180 (2×180=360)
     *                 fan02_02 len 31 · 3사본 -> 10,20 (3×10=30)
     *   나머지 28.7% 도 `[0,3,6]` `[2,20,25,30,33]` 처럼 손으로 다듬은 시차이며
     *   **단조 증가**다. "같은 것을 중복 배치했다"고 볼 값은 한 건도 없다.
     * [해석] 이 값들은 N 개 사본을 한 주기에 걸쳐 **차례로 발사**시키는 장치다.
     *   그래서 어느 순간에도 한두 개만 비행 중이고, 전체는 제자리에서 반짝이는
     *   고리로 읽힌다.
     * [실패 이력] r86·r91·r93·r94 는 이 시차를 "중복"으로 보고 껐다. 시차를
     *   지우면 N 개가 **동시에** 발사돼 사방으로 퍼지는 폭발이 된다 — 사용자가
     *   계속 지적한 "사방팔방에서 날아온다 / 계속 흩어진다" 가 바로 그것이다.
     *   원인과 처방이 뒤집혀 있었다.
     * [되돌리기] `window.__anssAdvance = 0` 으로 전면 해제(A/B 비교용).
     * [신뢰도] CONFIRMED (전수 측정)
     */
    const own = advanceScale * (part.user ?? 0);
    const phase = (parent ? parent.phase : 0) + own;
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
      /**
       * 원본 [LOOP]: 애니메이션 길이에서 되감는다.
       *
       * [디버그] `pingPong` 을 켜면 톱니 대신 왕복으로 되감는다. 끝 키와 시작
       * 키 값이 다른 트랙(예: 1285005 의 fan01_set x: -89 -> -47.9)은 톱니로
       * 감으면 주기마다 그 차이만큼 튄다. 가설 검증용이며 기본은 꺼져 있다.
       */
      const t0 = ((frame + phase) % F + F) % F;
      if (pingPong && F > 1) {
        const period = 2 * (F - 1);
        const q = (((frame + phase) % period) + period) % period;
        lf = q < F ? q : period - q;
      } else {
        lf = t0;
      }
    } else {
      // 원본 1회성 애니메이션: 끝 프레임에서 유지하되, 공용 주기마다 다 같이
      // 처음으로 돌아간다(plan.cycle 주석 참조). 주기 안의 거동은 원본과 같다.
      const c = ((frame % plan.cycle) + plan.cycle) % plan.cycle;
      lf = Math.min(F - 1, Math.max(0, c + phase));
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
    /**
     * 세로 피벗 부호는 **-** 다. (docs §37 — 한때 + 로 뒤집었다가 철회)
     *
     * [주의] 부호를 재려면 좌표계를 맞춰야 한다. evaluate 는 **y-up** 이고
     *   AnssStage 가 `-dr.b · -dr.c · -dr.y` 로 뒤집어 PIXI 로 넘긴다. 반면
     *   메시 정점은 `-hh` 가 이미지 **위**다. 두 규약의 y 가 반대라, evaluate
     *   좌표에서 재면서 메시 규약을 적용하면 결론이 뒤집힌다 — r50 에서 그
     *   실수로 부호를 바꿨고 화면이 나빠져 되돌렸다.
     * [디버그] `window.__anssPivotY = 1` 로 뒤집어 볼 수 있다.
     */
    const oy = pivotYSign * pvy * cell.h;

    const t = part.t;
    const hasUv = !!(t.uvx || t.uvy || t.uvsx || t.uvsy || t.uvrot);

    /**
     * SIZE_X / SIZE_Y (속성 20 / 21) — 셀의 자연 크기를 덮어쓰는 표시 크기.
     *
     * [문제] 익스포터가 이 두 속성을 아예 파싱하지 않아 파츠가 셀 원본 크기로
     *   그려졌다. 크기가 다르게 저작된 파츠는 화면에서 혼자 어색한 크기로 뜬다.
     * [근거] 값이 128.0 · 112.0 · 75.787 처럼 픽셀 규모이고 20/21 이 항상 쌍으로
     *   온다(1114005 의 eff_kira_1 = 20:128.0, 21:128.0). 키 종류 태그도 float 다.
     *   문서화된 표에서 17 PIVOTY 와 22 IMGFLIPH 사이의 빈 자리이고 SpriteStudio
     *   속성 순서(PIVOT → ANCHOR → SIZE → IMGFLIP)와 맞는다.
     * [범위] 키 148개 · 이펙트 25개.
     * [처리] 쿼드는 셀 단위로 두고 지역 배율에 접어 넣는다. 트랙이 없으면 배율이
     *   정확히 1 이라 나머지 657개 이펙트는 비트 단위로 동일하다.
     * [신뢰도] STRONG
     */
    const kx = t.szx && cell.w ? sample(t.szx, lf, cell.w) / cell.w : 1;
    const ky = t.szy && cell.h ? sample(t.szy, lf, cell.h) / cell.h : 1;

    const dr = drawSlot(pool);
    dr.part = part; dr.cell = cell;
    dr.vcol = sampleVCol(part, lf);
    dr.a = w.a * kx; dr.b = w.b * kx; dr.c = w.c * ky; dr.d = w.d * ky;
    dr.x = w.x + dr.a * ox + dr.c * oy;
    dr.y = w.y + dr.b * ox + dr.d * oy;
    dr.alpha = w.alpha; dr.prio = w.prio; dr.index = i;
    dr.blend = plan.blend[i];
    // Native [LOOP] jumps directly from the final authored frame back to the
    // first. Do not synthesize a web-only seam fade: it changes the timing and
    // makes adjacent _t/_u plates dim at different moments.
    const vert = sampleVert(part, part.xt, lf);
    dr.vert = vert;
    dr.hasVert = !!vert?.some(value => value !== 0);
    if (hasUv) {
      const uv = dr.uv!;
      uv.x = sample(t.uvx, lf, 0);
      uv.y = sample(t.uvy, lf, 0);
      uv.sx = sample(t.uvsx, lf, 1);
      uv.sy = sample(t.uvsy, lf, 1);
      // UV 창이 0 에 수축하면 표시할 텍스처 면적이 없다 -> 그리지 않는다.
      if (Math.abs(uv.sx) < 1e-3 || Math.abs(uv.sy) < 1e-3) dr.alpha = 0;
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
