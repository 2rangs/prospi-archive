"use client";

import { useEffect, useRef } from "react";
import { Application, Assets, Container, Matrix, Mesh, MeshGeometry, Rectangle, Sprite, Texture } from "pixi.js";
import { AnssDocument, CARD_ART_H, CARD_ART_REF_H, CARD_ART_W, BlendType, Cell, Part, PartType } from "./types";
import { Draw, VCol, evaluate } from "./evaluate";

/**
 * Renders an evaluated ANSS frame.
 *
 * Logical space is the base screen (640 x 1136, GetBaseScreenWidth/Height) with
 * y up, which is how part positions are authored. AnimssCanvas::stretchBG
 * scales the canvas uniformly by screenHeight / GetBaseScreenHeight(), so that
 * is the default here too. Nothing is clipped and no output size is baked in.
 *
 * The renderer owns exactly one Application for its lifetime; swapping the
 * document only swaps sprites. Rebuilding it per effect burns through the
 * browser's WebGL context budget and takes the page down after a few switches.
 */

/** Material::AffectStatus states, reached from the part's BlendType. */
export function pixiBlend(bl?: number) {
  switch (bl) {
    case BlendType.Add: return "add" as const;           // FUNC_ADD, (SRC_ALPHA, ONE)
    case BlendType.Multiply: return "multiply" as const;
    case BlendType.Subtract: return "subtract" as const;  // FUNC_REVERSE_SUBTRACT
    default: return "normal" as const;                    // (SRC_ALPHA, ONE_MINUS_SRC_ALPHA)
  }
}

/**
 * AnimssPart::setVertexColor: blend 0 is a flat colour, 1 is one per corner.
 * [근거] 전수 집계에서 blend 0 은 언제나 색 1개, blend 1 은 언제나 4개.
 */
/**
 * 정점 색상을 PIXI tint 값으로 접는다.
 *
 * [확인된 사실] 정점색 키 274,241개는 두 종류뿐이다(전수 집계).
 *   blend 1 Multiply — 177,120키 / 540개 이펙트. 코너 4개, 58%가 그라데이션.
 *     cellTexture 가 4코너를 텍스처에 곱해 구우므로 여기서는 흰색을 돌려준다
 *     (안 그러면 이중 곱이 된다).
 *   blend 0 Mix      —  97,121키 / 487개 이펙트. 코너 1개.
 *
 * [반박된 가설] "Mix 는 lerp(텍스처RGB, 색, 비율) 이고 비율이 99.97% 1.0 이니
 *   RGB 를 그 색으로 **대체**해야 한다. 지금은 곱해서 어두워진 것이다."
 *   -> **REJECTED**. 흰 텍스처 x tint 로 대체를 구현해 봤더니 화면이 하얗게
 *   타 버렸다(사용자 확인: "눈갱"). 원인은 Mix 색의 23%(22,125/97,121)가
 *   순백색 (255,255,255) 이라, 대체로 해석하면 그 파츠 전체가 흰 판이 되기
 *   때문이다. 가산 블렌드와 겹치면 더 심해진다.
 * [경쟁 가설] 익스포터가 rate 를 잘못 읽고 있다. read_vcol 은
 *   `round(rate if 0 <= rate <= 1 else 1.0, 3)` 로 **범위 밖 값을 1.0 으로
 *   강제**한다. 그 오프셋의 float 이 rate 가 아니라면 쓰레기값이 전부 1.0 으로
 *   접혀 "99.97% 가 1.0" 이라는 관측이 그대로 설명된다. 실제로 범위 안에 든
 *   값은 37개(0.25 26개 · 0.99 10개 · 0.0 1개)뿐이다.
 * [다음 검증] read_vcol 의 클램프를 걷어 내고 원시 float 분포를 본다.
 *   대부분이 [0,1] 밖이면 그 필드는 rate 가 아니다.
 * [처리] 확정될 때까지 종전 동작(Mix 를 곱셈 tint 로) 유지.
 * [신뢰도] 분포 CONFIRMED · Mix=대체 REJECTED · rate 필드 자체 UNKNOWN
 */
function flatTint(v?: VCol) {
  if (!v || v.blend !== 0) return 0xffffff;
  const [r, g, b] = v.c[0];
  return (r << 16) | (g << 8) | b;
}

const cornerCache = new Map<string, Texture>();
const intensityCache = new Map<string, Texture | null>();

/**
 * 알파 채널이 없는 시트는 "강도 맵"이다 — 투명도가 아니라 밝기로 모양을 담는다.
 *
 * [확인된 사실] 790장 중 462장이 알파 채널 없는 팔레트 PNG이고, 그것을 쓰는
 *   파츠의 97%(7,448/7,699)가 Add 블렌드다. 회색조 시트의 평균값은 1.6~39.6으로
 *   대부분이 거의 검다.
 * [해석] 그러므로 검은 픽셀은 "불투명한 검정"이 아니라 강도 0이다. 다만 팔레트
 *   양자화로 바닥이 정확히 0이 아니라 9/255 정도 떠 있고, 한 화면에 Add 파츠가
 *   300~500개 겹치면 그 바닥이 눈에 보이는 사각형으로 누적된다.
 * [처리] 휘도를 알파로 만들어 검은 바닥을 실제로 투명하게 한다. 밝은 코어는
 *   알파 1에 가까워 가산 결과가 거의 그대로 남고, 바닥은 9/255 × 9/255 ≈ 0 이
 *   되어 사라진다.
 * [경쟁 가설] 원본은 셰이더에서 RGB를 그대로 더하고(GL_ONE, GL_ONE) 바닥값은
 *   원본 오소링 단계에서 0이었을 수 있다. 그 경우에도 결과는 이쪽과 같다.
 * [신뢰도] 시트가 강도 맵이라는 것 STRONG / 휘도=알파 변환 자체는 표시 선택.
 */
/**
 * 시트 텍스처. 가산 파츠의 시트도 검은 픽셀이 기여 0 이므로 휘도를 알파로
 * 바꿔야 한다(셀 크롭과 같은 규칙). 시트 해시로 캐시한다.
 */
const sheetCache = new Map<string, Texture | null>();

/** 렌더 루프용: 준비 단계에서 만들어 둔 것만 쓴다. */
function sheetTexture(sheet: string, additive: boolean): Texture | null {
  const url = `/effects/sheets-webp/${sheet}.webp`;
  if (!additive) return Texture.from(url);
  if (sheetCache.has(sheet)) return sheetCache.get(sheet) ?? Texture.from(url);
  return Texture.from(url);
}

function computeSheet(sheet: string, additive: boolean): Texture | null {
  const url = `/effects/sheets-webp/${sheet}.webp`;
  const plain = Texture.from(url);
  if (!plain) return null;
  if (!additive) return plain;
  const key = sheet;
  if (sheetCache.has(key)) return sheetCache.get(key) ?? plain;
  const src = plain.source?.resource as CanvasImageSource | undefined;
  const w = plain.width, h = plain.height;
  if (!src || !w || !h) return plain;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) return plain;
  ctx.drawImage(src, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  let translucent = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) translucent += 1;
  if (translucent / (px.length / 4) > 0.02) { sheetCache.set(key, null); return plain; }
  // 셀과 같은 규칙: 검은 바닥만 뺀다 (알파는 건드리지 않는다)
  const ring: number[] = [];
  const at2 = (x: number, y: number) => (y * w + x) * 4;
  for (let x = 0; x < w; x += 1) {
    for (const y of [0, h - 1]) {
      const j = at2(x, y);
      ring.push(Math.max(px[j], px[j + 1], px[j + 2]));
    }
  }
  ring.sort((a, b) => a - b);
  const floor = ring.length ? ring[Math.floor(ring.length / 2)] : 0;
  if (floor > 2) {
    for (let i = 0; i < px.length; i += 4) {
      px[i] = px[i] > floor ? px[i] - floor : 0;
      px[i + 1] = px[i + 1] > floor ? px[i + 1] - floor : 0;
      px[i + 2] = px[i + 2] > floor ? px[i + 2] - floor : 0;
    }
  }
  // 셀과 같은 규칙: 알파=휘도 + 프리멀티 상쇄 (검은 시트 배경 제거)
  for (let i = 0; i < px.length; i += 4) {
    const m = px[i] > px[i + 1] ? (px[i] > px[i + 2] ? px[i] : px[i + 2])
                                : (px[i + 1] > px[i + 2] ? px[i + 1] : px[i + 2]);
    if (m < 1) { px[i + 3] = 0; continue; }
    const k = 255 / m;
    px[i] *= k; px[i + 1] *= k; px[i + 2] *= k;
    px[i + 3] = m;
  }
  // 시트 전체 텍스처는 페더하지 않는다 — UV 파츠가 시트 안쪽을 샘플링하므로
  // 가장자리를 깎으면 UV 가 시트 경계에 닿을 때 내용이 사라진다.
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(cv);
  sheetCache.set(key, tex);
  return tex;
}

/** 렌더 루프용: 준비 단계에서 만들어 둔 것만 쓴다. */
function intensityTexture(cell: Cell, additive = true): Texture | null {
  const url = spriteUrl(cell.file);
  const ikey = `${cell.file}|${additive ? "a" : "m"}`;
  if (intensityCache.has(ikey)) return intensityCache.get(ikey) ?? Texture.from(url);
  return Texture.from(url);
}

/**
 * 알파 없는 가산 시트를 "빛 텍스처"로 바꾼다.
 *
 * [문제] 가산 블렌드는 색만이 아니라 **알파도 누적**한다. 알파 채널이 없는
 *   시트는 어디나 알파 1 이라, 텍스처의 검은 부분이 `rgb≈0 · alpha≈1` =
 *   **불투명한 검정**이 되어 투명 캔버스를 시커멓게 칠한다. 게임은 배경 위에
 *   바로 그리니 문제가 없지만, 우리는 카드와 페이지 위에 합성하므로 그대로
 *   검은 판이 덮인다. UV 파츠 218장을 되살린 뒤 화면의 13% 가 이 상태였다.
 * [처리] 알파 = 휘도로 두어 검정이 알파를 안 올리게 하고, 텍스처를
 *   **비프리멀티플라이**로 만들어 PIXI 가 rgb 에 알파를 곱하지 않게 한다.
 *   그러면 dst.rgb += src.rgb (밝기 손실 없음) · dst.a += 휘도 (검정은 0) 가 되어
 *   원본의 `dst += rgb` 와 같아지면서 검은 판도 생기지 않는다.
 * [반박된 대안] 알파만 휘도로 두고 프리멀티플라이를 그대로 두면 결과가
 *   rgb x 휘도 가 되어 밝기가 제곱으로 줄고 스프라이트가 낱개로 떠 보인다
 *   (예전에 겪은 증상).
 * [신뢰도] CONFIRMED (불투명검정 13.0% 측정)
 */
/**
 * Mix(일반 블렌드) 전용: 알파 없는 셀의 검은 배경판을 없앤다.
 *
 * [확인된 사실] 알파 없는 셀을 Mix 로 그리면 검은 픽셀이 불투명하게 카드 위에
 *   깔린다(1,002파츠/63이펙트의 검은 사각판). 알파 = 휘도로 두고 업로드 시
 *   프리멀티하면 어두운 곳은 투명해지고 가장자리는 부드럽게 사라진다.
 * [반박된 가설 → 철회] 같은 변환을 **가산**에도 적용(비프리멀티로): 화면
 *   전반이 검게 비치고 재생이 이상해졌다(사용자 보고). 가산의 검은 픽셀은
 *   원래 기여가 0이라 변환이 필요 없다 — 가산은 예전의 "바닥만 빼는" 경로로
 *   되돌린다. r24 도입 → r25 철회.
 */
/**
 * 테두리 1px 을 투명으로 깎는다.
 *
 * [확인된 사실] 강도맵 셀 400개 표본에서 **35~38개(9%)** 가 크롭 경계에
 *   내용이 닿아 있다(테두리 평균 알파 8 초과, 최대 75). 그런 셀은 움직일 때
 *   사각 테두리가 그대로 보인다 — "이미지 경계가 재생될 때 거슬림".
 * [해석] 셀 크롭은 시트의 셀 사각형을 그대로 자른 것이라 내용이 경계에 닿을
 *   수 있다. GL 은 CLAMP_TO_EDGE 라 가장자리 색이 늘어나며 하드 엣지가 된다.
 * [처리] 바깥 1px 알파 0, 그 안쪽 1px 은 절반. 셀이 126~508px 이라 손실은
 *   0.4~1.6% 이고 사각 경계는 사라진다.
 * [신뢰도] 원인 CONFIRMED(측정) · 처리는 표준적인 페더
 */
function feather(px: Uint8ClampedArray, w: number, h: number): boolean {
  if (w < 4 || h < 4) return false;
  const a = (x: number, y: number) => (y * w + x) * 4 + 3;
  let live = 0, ring = 0;
  for (let x = 0; x < w; x += 1) {
    live += px[a(x, 0)] > 8 ? 1 : 0; ring += 1;
    live += px[a(x, h - 1)] > 8 ? 1 : 0; ring += 1;
  }
  for (let y = 1; y < h - 1; y += 1) {
    live += px[a(0, y)] > 8 ? 1 : 0; ring += 1;
    live += px[a(w - 1, y)] > 8 ? 1 : 0; ring += 1;
  }
  const occupancy = live / Math.max(1, ring);
  // No content reaches the crop, or this is an intentionally solid rectangle
  // (card plate/logo/background) rather than a particle clipped by its atlas.
  if (occupancy < 0.01 || occupancy > 0.75) return false;

  // A fixed one-pixel cut becomes a visible dark seam when a 128px sprite is
  // enlarged over the card. Use a size-aware smooth ramp instead. Tiny streaks
  // keep one pixel; large glows get at most four, so their silhouette survives.
  const width = Math.max(1, Math.min(4, Math.floor(Math.min(w, h) / 24)));
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const d = Math.min(x, y, w - 1 - x, h - 1 - y);
    if (d >= width) continue;
    const t = d / width;
    const smooth = t * t * (3 - 2 * t);
    px[a(x, y)] = Math.round(px[a(x, y)] * smooth);
  }
  return true;
}

function lightTexture(cv: HTMLCanvasElement, px: Uint8ClampedArray,
                      ctx: CanvasRenderingContext2D, img: ImageData): Texture {
  for (let i = 0; i < px.length; i += 4) {
    const lum = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114);
    px[i + 3] = lum > 255 ? 255 : lum;
  }
  feather(px, cv.width, cv.height);
  ctx.putImageData(img, 0, 0);
  return Texture.from(cv);
}

function computeIntensity(cell: Cell, additive = true): Texture | null {
  const url = `/effects/sprites-webp/${cell.file}.webp`;
  const key = `${cell.file}|${additive ? "a" : "m"}`;
  const plain = Texture.from(url);
  if (!plain) return null;
  if (intensityCache.has(key)) return intensityCache.get(key) ?? plain;
  const src = plain.source?.resource as CanvasImageSource | undefined;
  if (!src) return plain;
  const cv = document.createElement("canvas");
  cv.width = cell.w; cv.height = cell.h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) return plain;
  ctx.drawImage(src, 0, 0, cell.w, cell.h);
  const img = ctx.getImageData(0, 0, cell.w, cell.h);
  const px = img.data;

  /**
   * 알파를 휘도로 바꾸지 않고 **검은 바닥만 뺀다**.
   *
   * [문제] 예전에는 불투명한 가산 시트의 알파를 휘도로 바꿨다. 그러면 PIXI 가
   *   프리멀티플라이해 가산 결과가 rgb x 휘도 가 되어 번짐이 제곱으로 줄고,
   *   스프라이트가 서로 녹지 않고 낱개로 떠 보인다. 실제로 1201005 의 Add 셀
   *   평균 기여도가 14.6 → 7.4, 32.6 → 16.8, 6.3 → 2.3 으로 절반 이하가 됐다.
   * [확인된 사실] 원본 가산은 dst += rgb x srcAlpha 이고(FillAlphaMode 모드 1),
   *   이 시트들은 알파가 1 이므로 dst += rgb 다. 그리고 1201005 의 Add 셀은
   *   테두리 바닥이 이미 0 이라 뺄 것도 없다.
   * [처리] 테두리 바닥값을 재서 0 에 가까우면 텍스처를 그대로 쓰고(원본과 동일),
   *   바닥이 떠 있으면 그만큼 RGB 에서 빼 준다. 그러면 번짐 모양은 그대로 두고
   *   누적 사각형만 사라진다.
   * [신뢰도] STRONG
   */
  let translucent = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) translucent += 1;
  const total = px.length / 4;
  if (translucent / total > 0.02) {
    // 원래 알파가 있어도 atlas crop 경계에 빛/입자가 닿으면 확대·이동 시
    // 사각 이미지 조각처럼 보인다. 실제로 잘린 셀만 부드럽게 하고, 완전한
    // 사각 플레이트는 feather()의 occupancy 가드가 그대로 보존한다.
    if (!feather(px, cell.w, cell.h)) {
      intensityCache.set(key, null);
      return plain;
    }
    ctx.putImageData(img, 0, 0);
    const softened = Texture.from(cv);
    intensityCache.set(key, softened);
    return softened;
  }
  // 여기부터는 알파가 전부 1 인 셀이다 -> 반드시 휘도 알파로 바꿔야 한다
  const w = cell.w, h = cell.h;
  const at = (x: number, y: number) => (y * w + x) * 4;
  const ring: number[] = [];
  for (let x = 0; x < w; x += 1) {
    for (const y of [0, h - 1]) {
      const j = at(x, y);
      ring.push(Math.max(px[j], px[j + 1], px[j + 2]));
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (const x of [0, w - 1]) {
      const j = at(x, y);
      ring.push(Math.max(px[j], px[j + 1], px[j + 2]));
    }
  }
  ring.sort((a, b) => a - b);
  const floor = ring.length ? ring[Math.floor(ring.length / 2)] : 0;
  if (floor > 2) {                           // 팔레트 양자화로 뜬 바닥은 뺀다
    for (let i = 0; i < px.length; i += 4) {
      px[i] = px[i] > floor ? px[i] - floor : 0;
      px[i + 1] = px[i + 1] > floor ? px[i + 1] - floor : 0;
      px[i + 2] = px[i + 2] > floor ? px[i + 2] - floor : 0;
    }
  }
  if (additive) {
    /**
     * 가산 셀: 알파 = 휘도, RGB 는 프리멀티를 미리 상쇄해 둔다.
     *
     * [문제] 알파 없는 셀은 알파가 어디나 255 다. 가산 블렌드는 **알파도
     *   누적**하므로 텍스처의 검은 배경이 `rgb 0 · alpha 1` = 불투명한 검정이
     *   되어 카드 위에 사각 판으로 깔린다(1201005 에서 그런 텍스처 21종 검출,
     *   화면의 13%). 사용자 증상 "배경이 왜 보이는데요" 가 이것이다.
     * [반박된 가설] 알파만 휘도로 바꾸기. 업로드 시 프리멀티되어 저장값이
     *   rgb x 휘도 가 되고, 가산 결과가 제곱으로 어두워져 불이 죽는다(r24 실패).
     * [반박된 가설] 알파 = **휘도**, RGB 를 255/휘도 배. 항등식
     *   rgb x (휘도/255) x (255/휘도) = rgb 는 `rgb x 255/휘도 <= 255` 일 때만
     *   성립한다. 휘도는 가중 평균이라 채도가 있으면 max 채널 > 휘도 이므로
     *   **거의 모든 유채색 픽셀에서 클램프가 걸린다**. (254,102,6) 은 휘도 136.5,
     *   R 을 474 로 키우려다 255 에서 잘려 복원값이 R=136 -> **빨강 46% 손실**.
     *   1201005 상세가 흰색으로 날아가고(순백 12%) 붉은 기가 사라진 원인.
     * [처리] 알파 = **max 채널**. 그러면 rgb x 255/max <= 255 라 클램프가 절대
     *   걸리지 않고, 프리멀티 결과가 rgb x (max/255) x (255/max) = **원본 rgb**
     *   로 모든 픽셀에서 정확히 복원된다. 검은 곳은 max 0 -> 알파 0.
     * [신뢰도] CONFIRMED (수식 항등이 전 정의역에서 성립 + 픽셀 측정)
     */
    for (let i = 0; i < px.length; i += 4) {
      const m = px[i] > px[i + 1] ? (px[i] > px[i + 2] ? px[i] : px[i + 2])
                                  : (px[i + 1] > px[i + 2] ? px[i + 1] : px[i + 2]);
      if (m < 1) { px[i + 3] = 0; continue; }
      const k = 255 / m;
      px[i] *= k; px[i + 1] *= k; px[i + 2] *= k;
      px[i + 3] = m;
    }
    feather(px, w, h);
    ctx.putImageData(img, 0, 0);
    const tex0 = Texture.from(cv);
    intensityCache.set(key, tex0);
    return tex0;
  }
  const tex = lightTexture(cv, px, ctx, img);
  intensityCache.set(key, tex);
  return tex;
}

/**
 * A per-corner vertex colour is a gradient across the quad, so it is multiplied
 * onto a copy of the cell. Averaging the corners is what collapses a card's
 * red/blue split into one muddy tone.
 */
const urlCache = new Map<string, string>();
function spriteUrl(file: string): string {
  let u = urlCache.get(file);
  if (!u) { u = `/effects/sprites-webp/${file}.webp`; urlCache.set(file, u); }
  return u;
}

export function cellTexture(cell: Cell, v?: VCol, additive = false): Texture | null {
  const url = spriteUrl(cell.file);
  // prepare()가 강도맵 변환뿐 아니라 atlas crop 경계도 판정한다. 알파가 있는
  // 일반 블렌드 셀도 가장자리 보정 대상일 수 있으므로 같은 캐시를 통과시킨다.
  const base = intensityTexture(cell, additive);
  const plain = base ?? Texture.from(url);
  if (!plain) return null;
  if (!v || v.blend === 0) return plain;

  // 정점색이 애니메이션되므로 캐시 키를 5비트로 양자화한다(색 32단계).
  const key = `${cell.file}|${v.c.map(c => c.slice(0, 3).map(n => n >> 3).join(",")).join("|")}`;
  const hit = cornerCache.get(key);
  if (hit) return hit;
  const src = plain.source?.resource as CanvasImageSource | undefined;
  if (!src) return plain;

  const cv = document.createElement("canvas");
  cv.width = cell.w; cv.height = cell.h;
  const ctx = cv.getContext("2d");
  if (!ctx) return plain;
  ctx.drawImage(src, 0, 0, cell.w, cell.h);

  const g = document.createElement("canvas");
  g.width = 2; g.height = 2;
  const gc = g.getContext("2d");
  if (!gc) return plain;
  const put = (x: number, y: number, i: number) => {
    const c = v.c[Math.min(i, v.c.length - 1)];
    gc.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    gc.fillRect(x, y, 1, 1);
  };
  /**
   * Row major, and the file's first pair is the lower row.
   *
   * [근거] Animss6CellPart::updateQuad copies four (x,y) pairs out of the value
   * block at +0x24, +0x2c, +0x34, +0x3c into vertex slots 2, 3, 0, 1 (stride
   * 0x10), guarded by vertex-count checks 2, 3, 0, 1. The pairs therefore go in
   * two groups of two, so the four entries are two rows of two, not two columns.
   * [해석] slots 0,1 are the first row of the quad, and they receive the file's
   * third and fourth entries, so entries 0,1 are the other row.
   * [아직 모르는 것] whether renderer vertex 0 is the top or the bottom row --
   * getting it wrong flips the gradient vertically, nothing else.
   * [신뢰도] row-major STRONG, row order POSSIBLE.
   */
  put(0, 1, 0); put(1, 1, 1); put(0, 0, 2); put(1, 0, 3);

  // canvas "multiply" is a separable blend over source-over compositing, so an
  // opaque gradient also overwrites the destination alpha. Multiply the colour,
  // then clip back to the cell's own alpha with destination-in.
  ctx.globalCompositeOperation = "multiply";
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(g, 0, 0, 2, 2, 0, 0, cell.w, cell.h);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(src, 0, 0, cell.w, cell.h);
  ctx.globalCompositeOperation = "source-over";

  const tex = Texture.from(cv);
  cornerCache.set(key, tex);
  return tex;
}

export function cellUrls(doc: AnssDocument) {
  const set = new Set<string>();
  for (const p of doc.parts) {
    const list = p.cells ?? (p.c ? [p.c] : []);
    const uv = !!(p.t.uvx || p.t.uvy || p.t.uvsx || p.t.uvsy || p.t.uvrot);
    for (const c of list) {
      if (!c) continue;
      /**
       * 스프라이트는 **항상** 싣는다.
       *
       * [문제] 종전에는 UV 파츠면 시트만 싣고 스프라이트를 건너뛰었다. 그런데
       *   렌더 루프는 메시를 만들기 전에 cellTexture(=스프라이트)를 먼저 부르고
       *   없으면 그 자리에서 return 한다. PIXI v8 의 Texture.from 은 캐시에 없는
       *   URL 에 undefined 를 주므로, UV 파츠가 한 장도 안 그려졌다.
       * [측정] 1201005 프레임 40 에서 evaluate 가 넘긴 361장 중 **218장(60%)**이
       *   이 경로로 버려졌다(실패 파일 19종, 파일은 200 으로 정상 서빙됨).
       *   UV 경로를 껐다 켜도 결과가 같았던 것도 이 때문이다 — 둘 다 이미
       *   버려진 뒤였다.
       * [신뢰도] CONFIRMED (드롭 카운터 계측)
       */
      if (c.file) set.add(`/effects/sprites-webp/${c.file}.webp`);
      if (uv && c.sheet) set.add(`/effects/sheets-webp/${c.sheet}.webp`);
    }
  }
  return Array.from(set);
}

/**
 * 픽셀 분석을 재생 전에 끝낸다.
 *
 * [문제] 휘도→알파 변환과 시트 변환은 캔버스 getImageData 를 쓰는
 *   동기 작업이다. 이것을 렌더 루프 안에서 처음 만나는 프레임에 하면 그 프레임이
 *   수십~수백 ms 멈추고, 그동안 시계(performance.now)는 계속 흐르므로 재개할 때
 *   애니메이션이 앞으로 튄다("갑자기 빨리 감기"). 셀이 많으면 이 멈춤이 반복돼
 *   껌뻑이는 것처럼 보인다.
 * [처리] 문서를 바꿀 때 필요한 셀·시트를 모두 훑어 미리 계산하고, 8개마다 한 번씩
 *   프레임을 양보해 한 번에 오래 멈추지 않게 한다. 렌더 루프는 캐시만 조회한다.
 */
export async function prepare(doc: AnssDocument): Promise<void> {
  const cells = new Map<string, { cell: Cell; additive: boolean; uv: boolean }>();
  const sheets = new Map<string, boolean>();
  for (const p of doc.parts) {
    if (p.k !== PartType.Cell) continue;
    const additive = p.bl === BlendType.Add;
    const uv = !!(p.t.uvx || p.t.uvy || p.t.uvsx || p.t.uvsy || p.t.uvrot);
    for (const c of p.cells ?? (p.c ? [p.c] : [])) {
      if (!c || !c.file) continue;
      const prev = cells.get(c.file);
      cells.set(c.file, { cell: c, additive: additive || !!prev?.additive, uv: uv || !!prev?.uv });
      if (uv && c.sheet) sheets.set(c.sheet, additive || !!sheets.get(c.sheet));
    }
  }
  let n = 0;
  // 탭·패널이 숨겨져 있어도 진행돼야 하므로 rAF 가 아니라 타이머로 양보한다
  const yieldSoon = async () => {
    n += 1;
    if (n % 8 === 0) await new Promise(r => setTimeout(r, 0));
  };
  for (const [sheet, additive] of sheets) {
    computeSheet(sheet, additive);
    await yieldSoon();
  }
  for (const { cell, additive, uv } of cells.values()) {
    // UV 파츠는 시트 텍스처를 쓰므로 셀 크롭 변환은 필요 없다
    if (!uv) computeIntensity(cell, additive);
    await yieldSoon();
  }
}

/**
 * 재생 프레임레이트.
 *
 * [파일 값] 클립 +0x40 과 애니 +0x48 이 682개 전부 30 이다.
 * [런타임] AnimssCanvas::advance(float) 는 받은 값을 그대로 넘기고 한 경로에서
 *   정확히 1.0 을 넘긴다 = 앱 프레임마다 애니메이션 1프레임. 그 앱 fps 는
 *   AnimssSettings::setAppFps(float) 로 주입된다. 즉 실제 재생 속도는 파일이
 *   아니라 앱 프레임레이트가 정한다.
 * [주의] 이것은 **애니메이션 진행 속도**이지 화면 주사율이 아니다. 렌더링은
 *   requestAnimationFrame 이 주는 주사율(보통 60Hz)로 돌고, 그 사이의 소수
 *   프레임은 sample() 이 키프레임 사이를 보간해 부드럽게 만든다. 30 을 60 으로
 *   올리면 애니메이션이 2배 빨라질 뿐 부드러워지지 않는다.
 * [신뢰도] STRONG (682개 파일 전수 30)
 */
const APP_FPS = 30;

export default function AnssStage({
  doc, width, height, role, originY = 0.5, scale, backdrop = true,
  offsetX = 0, offsetY = 0, speed = 1, intensity = 1, mute, renderScale = 1,
  cardArt, cardArtScale = 1,
}: {
  doc: AnssDocument | null;
  width: number;
  height: number;
  role?: "back" | "front";
  /** where logical y=0 sits, as a fraction of the output height */
  originY?: number;
  /**
   * 논리단위 → 출력픽셀 배율. 기본값은 출력 높이 / 660 이다 — 이펙트는 카드
   * 아트(512x660)와 같은 픽셀 공간에 작성돼 있고, 표시 틀의 종횡비가 카드
   * 아트와 같으므로 배율이 한 값으로 모인다. 예전 기본값(높이/1136)은
   * 기준 화면 높이를 카드 높이에 맞추는 것이어서 1.72배 작게 그려졌다.
   */
  scale?: number;
  /** nudges the whole stage, in output pixels */
  offsetX?: number;
  offsetY?: number;
  /**
   * 재생 속도 배율. 원본 fps 는 30 이다 — 클립 +0x40 과 애니 +0x48 이 682개
   * 파일에서 전부 30 이고, 애니 +0x4c(프레임 수)의 약수 관계도 맞는다. 이 값은
   * 그 30 을 바꾸지 않고 표시용으로만 배속한다.
   */
  speed?: number;
  /**
   * 전체 밝기 배율. 가산 파츠가 한 화면에 300~500개 겹치면 합이 포화해 흰색으로
   * 뭉개진다(전수 검증에서 69개 이펙트가 알파합 100 이상). 원본이 무엇으로
   * 억제하는지 아직 모르므로 표시용 배율로 둔다.
   */
  intensity?: number;
  /**
   * 끄고 볼 파츠 이름 집합. 어떤 레이어가 원본과 다른지 이름으로 짚기 위한
   * 검사 도구다. 재생 규칙에는 영향을 주지 않는다.
   */
  mute?: Set<string>;
  /**
   * 내부 렌더 해상도 배율. 1 이면 표시 크기 그대로, 0.6 이면 60% 크기로 그린 뒤
   * 확대한다. 클립 캔버스 320 가설을 시험하기 위한 값이다.
   */
  renderScale?: number;
  /**
   * 카드 이미지 URL. 주면 `_b` 파츠 뒤, `_f` 파츠 앞에 **같은 캔버스 안에서**
   * 그린다.
   *
   * [문제] 예전에는 back/front 를 캔버스 두 장으로 나누고 그 사이에 HTML <img>
   *   를 끼웠다. 그러면 앞 캔버스가 뒤 캔버스 위에 일반 알파로 합성되므로,
   *   앞쪽 가산 파츠가 뒤쪽 색과 더해지지 않는다. 한 캔버스에 모으면 원본과
   *   같은 누적이 된다.
   */
  cardArt?: string;
  /** 카드 이미지를 논리단위로 얼마나 크게 그릴지 (1 = 아트 픽셀 1 = 논리 1) */
  cardArtScale?: number;
  /**
   * Draw the Mix-blend parts. 카드 이펙트의 셀 파츠는 Add(78.5%)와 Mix(21.5%)
   * 두 종류뿐이고 Mix 는 원본이 그리는 레이어다. 알파 없는 시트를 휘도 알파로
   * 바꾼 뒤에는 Mix 도 사각형을 만들지 않으므로 기본값을 켜 둔다. 끄면 발광
   * 레이어만 남는다.
   */
  backdrop?: boolean;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<Container | null>(null);
  const appRef = useRef<Application | null>(null);
  /**
   * init 이 비동기라, 그 사이에 크기가 바뀌면 아래 리사이즈 이펙트는 아직
   * stageRef 가 비어 있어 그냥 돌아간다. init 이 끝난 뒤 최신 값을 다시
   * 적용해야 640x1136 로 시작한 캔버스가 720x1136 이펙트에서 어긋나지 않는다.
   */
  const boxRef = useRef({ width, height, originY, scale, offsetX, offsetY });
  boxRef.current = { width, height, originY, scale, offsetX, offsetY };
  const docRef = useRef<AnssDocument | null>(doc);
  const readyRef = useRef<number | null>(null);
  const spritesRef = useRef(new Map<number, Sprite | Mesh>());
  const roleRef = useRef(role);
  roleRef.current = role;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const intensityRef = useRef(intensity);
  intensityRef.current = intensity;
  const muteRef = useRef(mute);
  muteRef.current = mute;
  const renderScaleRef = useRef(renderScale);
  renderScaleRef.current = renderScale;
  const cardArtRef = useRef(cardArt);
  cardArtRef.current = cardArt;
  const cardArtScaleRef = useRef(cardArtScale);
  cardArtScaleRef.current = cardArtScale;
  const cardSpriteRef = useRef<Sprite | null>(null);
  const cardArtReadyRef = useRef<string | null>(null);
  const cardTexRef = useRef<Texture | null>(null);
  const backdropRef = useRef(backdrop);
  backdropRef.current = backdrop;

  // one Application for the component's lifetime
  useEffect(() => {
    if (!host.current) return;
    let app: Application | null = null;
    let raf = 0;
    let dead = false;
    /**
     * [문제] app.init() 은 비동기인데 app 은 그 전에 이미 변수에 들어가 있다.
     *   init 이 끝나기 전에 cleanup 이 돌면 아직 만들어지지 않은 내부 상태를
     *   destroy 가 건드려 "this._cancelResize is not a function" 으로 죽는다.
     *   이펙트를 읽어 캔버스 크기가 640x1136 -> 720x1136 으로 바뀌는 순간마다
     *   재현됐다.
     * [처리] init 이 끝난 뒤에만 destroy 한다. 끝나기 전이면 dead 플래그를 보고
     *   async 본문이 스스로 정리한다.
     */
    let inited = false;

    (async () => {
      app = new Application();
      /**
       * 내부 렌더 해상도를 클립 캔버스(320)에 맞춘다.
       *
       * [단서] 모든 클립이 canvasW/H = 320x320 을 들고 있는데 그 용도를 그동안
       *   찾지 못했다. 원본이 이펙트를 그 크기의 렌더 타깃에 그린 뒤 확대해
       *   합성한다면, 스프라이트들이 서로 뭉개져 하나의 불꽃처럼 이어진다.
       * [실험] 내부 버퍼를 320 폭으로 낮추고 CSS 로 확대한다. resolution 을
       *   낮추면 PIXI 가 그 배율로 렌더링하고 캔버스는 표시 크기를 유지한다.
       * [신뢰도] 실험 — 확정된 규칙이 아니다. renderScale 로 껐다 켤 수 있다.
       */
      /**
       * 전체 해상도로 그린다.
       *
       * [반박된 가설 → 철회] "전 클립의 canvas 320x320 상수는 원본이 저해상
       *   렌더타깃에 그린 뒤 확대한다는 뜻" → 그 상수는 682개가 **모두 같아**
       *   이펙트를 구분하지 못하는 SpriteStudio 프로젝트 기본값이고,
       *   AnimssCanvas 에는 렌더타깃 관련 메서드가 하나도 없다(심볼 전수 확인).
       *   근거 없이 내부 해상을 340px 로 낮췄더니 선수 이미지까지 뭉개졌다.
       *   r27 도입 → r28 철회.
       * [현행] 스프라이트를 하나로 녹이는 것은 해상도가 아니라 가산 누적이
       *   맡는다(알파=휘도 + 프리멀티 상쇄).
       */
      await app.init({
        width, height, backgroundAlpha: 0, antialias: true,
        resolution: renderScaleRef.current,
        autoDensity: false,
      });
      app.canvas.style.width = `${width}px`;
      app.canvas.style.height = `${height}px`;
      inited = true;
      if (dead) { app.destroy(true); return; }
      host.current!.appendChild(app.canvas);

      const stage = new Container();
      stage.sortableChildren = true;
      {
        const b = boxRef.current;
        /**
         * init 은 비동기라 위에서 쓴 width/height 는 **이펙트 시작 시점의 값**이다.
         * 그 사이 doc 이 로드돼 스테이지가 720(=885px)으로 바뀌어도 style 은
         * 640 기준(787px) 그대로 남아, 백킹 885 / CSS 787 로 캔버스가 가로만
         * 0.889 배 눌렸다. 선수 사진이 홀쭉해 보이던 원인.
         * 리사이즈할 때 CSS 도 같이 맞춘다.
         */
        if (app.renderer.width !== b.width || app.renderer.height !== b.height) {
          app.renderer.resize(b.width, b.height);
        }
        app.canvas.style.width = `${b.width}px`;
        app.canvas.style.height = `${b.height}px`;
        stage.position.set(b.width / 2 + b.offsetX, b.height * b.originY + b.offsetY);
        stage.scale.set(b.scale ?? b.height / CARD_ART_REF_H);
      }
      app.stage.addChild(stage);
      stageRef.current = stage;
      appRef.current = app;
      // 디버그: 최종 픽셀을 재려면 렌더러가 필요하다 (window.__anss.app)
      const dbg = { app, stage, frames: 0, ready: () => readyRef.current,
                    docId: () => docRef.current?.effectId ?? null,
                    draws: 0, noUv: false,
                    dropMix: 0, dropMute: 0, dropTex: 0,
                    dropFiles: new Set<string>() };
      (window as unknown as { __anss?: unknown }).__anss = dbg;

      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const sprites = spritesRef.current;
      const scratch = new Matrix();
      const live = new Set<number>();

      /**
       * 재생 시각은 절대 경과시간이 아니라 **그려진 프레임의 델타 누적**으로 센다.
       *
       * [문제] performance.now() - start 를 쓰면 렌더가 멈춘 동안에도 시각이
       *   흐른다. requestAnimationFrame 은 탭·패널이 숨겨지면 아예 멈추므로
       *   (측정: 숨김 5,171ms 동안 콜백 0회) 다시 보일 때 그 시간만큼 한 번에
       *   감긴다 = "갑자기 빨리 감기". GC 나 텍스처 업로드로 생기는 짧은 멈춤도
       *   같은 크기의 점프를 만들어 껌뻑이는 것처럼 보인다.
       * [처리] 프레임 간 델타를 100ms 로 잘라 누적한다. 멈춘 만큼 건너뛰지 않고
       *   이어서 재생되며, 느린 기기에서도 시간이 앞서 나가지 않는다.
       */
      let clock = 0;
      let prev = performance.now();

      /** 카드 이미지를 back / front 파츠 사이(zIndex 50000)에 끼운다. */
      const drawCard = () => {
        const artUrl = cardArtReadyRef.current === cardArtRef.current
          ? cardArtRef.current : undefined;
        const tex = cardTexRef.current;
        let card = cardSpriteRef.current;
        // 텍스처가 없는 Sprite 에 width 를 넣으면 PIXI 가 터진다.
        // (drawCard 를 ready 가드 앞으로 옮긴 뒤 드러난 경로)
        // HMR 등으로 텍스처 소스가 파괴되면 frame 이 null 이 되어 width 대입이 터진다.
        if (!artUrl || !tex || !tex.frame || !tex.source) {
          if (card) card.visible = false;
          return;
        }
        // React strict-mode/HMR can run the effect cleanup while the component
        // refs survive. PIXI destroy() nulls ObservablePoint fields such as
        // scale, so reusing that Sprite makes drawCard throw every frame and
        // stops the animation loop after a reload.
        if (card && ((card as Sprite & { destroyed?: boolean }).destroyed || !card.scale)) {
          cardSpriteRef.current = null;
          card = null;
        }
        if (!card) {
          card = new Sprite();
          card.anchor.set(0.5);
          cardSpriteRef.current = card;
        }
        // doc 을 바꾸면 removeChildren 이 카드도 떼어 낸다. 부모가 없으면 다시 붙인다.
        if (!card.parent) stage.addChild(card);
        if (card.texture !== tex) card.texture = tex;
        const cs = cardArtScaleRef.current;
        // Texture 교체 직후 width/height setter는 PIXI 내부 orig가 아직 없는 한
        // 프레임에서 예외를 낼 수 있다. 원본 슬롯이 정확히 512x660이므로 픽셀
        // 크기를 다시 계산하지 않고 동일 배율을 직접 적용한다.
        card.scale.set(cs);
        card.position.set(0, 0);
        card.visible = true;
        card.zIndex = 50000;
      };

      /**
       * 브라우저 패널이 숨겨지면 requestAnimationFrame 이 멈춰 한 프레임도
       * 그리지 않는다. 그 상태에서도 특정 프레임을 강제로 그려 픽셀을 검사할
       * 수 있도록 본문을 함수로 분리하고 window.__anss.step(frame) 로 연다.
       */
      let forced: number | null = null;

      const body = () => {
        const d = docRef.current;
        const now = performance.now();
        const dt = Math.min(0.1, Math.max(0, (now - prev) / 1000));
        prev = now;
        dbg.frames++;

        /**
         * 카드 이미지는 **ready 가드보다 먼저** 그린다.
         *
         * [문제] 이펙트를 바꾸면 doc 이펙트가 stage.removeChildren() 으로 카드를
         *   떼어 내는데, 새 이펙트가 준비될 때까지(텍스처 로드 + prepare 의 양보)
         *   아래 가드가 return 해 버려 카드를 다시 붙일 기회가 없었다. 그동안
         *   선수 사진이 통째로 사라진다 — 사용자가 본 증상이 이것이다.
         * [처리] 이펙트 준비 상태와 무관하게 매 프레임 카드를 붙인다.
         */
        drawCard();

        if (!d || readyRef.current !== d.effectId) return;
        if (!reduce) clock += dt * speedRef.current;
        // no global wrap: each part wraps on its own animation length, and the
        // lengths (121, 361, 601, 31 ...) share no small common multiple
        // speed는 clock에 이미 반영됐다. 여기서 다시 곱하면 50%가 25%, 200%가
        // 400%로 재생되는 제곱 배속이 된다.
        // 현재 682개는 모두 30fps지만 JSON에 보존한 원본 값을 기준으로 삼는다.
        // 신규 팩에서 다른 fps가 들어와도 UI 배속과 실제 타임라인이 어긋나지 않는다.
        const frame = forced !== null ? forced : clock * (d.fps || APP_FPS);
        const draws: Draw[] = evaluate(d, frame, roleRef.current);
        dbg.draws = draws.length;
        dbg.dropMix = 0; dbg.dropMute = 0; dbg.dropTex = 0; dbg.dropFiles.clear();

        live.clear();
        draws.forEach((dr, order) => {
          const blend = pixiBlend(dr.part.bl);
          if (!backdropRef.current && blend === "normal") { dbg.dropMix++; return; }
          if (muteRef.current?.has(dr.part.n)) { dbg.dropMute++; return; }
          const tex = cellTexture(dr.cell, dr.vcol, blend === "add");
          if (!tex) { dbg.dropTex++; dbg.dropFiles.add(dr.cell.file ?? "?"); return; }
          live.add(dr.index);
          /**
           * UV 애니메이션은 반복이 아니라 clamp 다.
           *
           * [확인된 사실] libAll.so 전체에서 GL_REPEAT(0x2901) 은 한 번도 쓰이지
           *   않고 GL_CLAMP_TO_EDGE(0x812F) 만 22회 나온다. 텍스처 생성 경로
           *   (DXTexture::CreateTextureFromETC1File / FromBMPFileInMemory) 와
           *   DIRECT3DDEVICE9::SetTexture 가 그 값을 쓴다.
           * [해석] uvx/uvy 가 [0,1] 밖으로 나가면 텍스처가 반복되는 게 아니라
           *   가장자리 픽셀이 늘어난다. TilingSprite(반복)로 그리면 무늬가 두 번
           *   나타나 줄무늬처럼 보인다(1151005 의 ink01_eff_* 가 uvy 를 -0.5 →
           *   1.0 으로 밀어 정확히 그 증상을 만들었다).
           * [처리] 4정점 Mesh 에 UV 를 직접 넣는다. PIXI 의 기본 addressMode 가
           *   clamp-to-edge 이므로 범위를 벗어난 UV 는 원본처럼 늘어난다.
           * [신뢰도] CONFIRMED (바이너리 상수 전수 조사)
           */
          // 디버그 A/B: window.__anss.noUv = true 로 UV 메시 경로를 끈다.
          // 켰을 때와 껐을 때 밝기·구조를 비교해 번짐의 원인을 가린다.
          // Attribute 15 deforms individual corners, so it also requires a mesh.
          const wantMesh = (!!dr.hasUv && !dbg.noUv) || !!dr.hasVert;
          const sheetTex = wantMesh && dr.cell.sheet
            ? sheetTexture(dr.cell.sheet, blend === "add") : null;
          let sp = sprites.get(dr.index);
          if (sp && (sp instanceof Mesh) !== wantMesh) {
            sp.destroy(); sprites.delete(dr.index); sp = undefined;
          }
          if (!sp) {
            if (wantMesh) {
              const geometry = new MeshGeometry({
                positions: new Float32Array(8),
                uvs: new Float32Array(8),
                indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
              });
              sp = new Mesh({ geometry, texture: sheetTex ?? tex });
            } else {
              sp = new Sprite();
              sp.anchor.set(0.5);
            }
            sprites.set(dr.index, sp);
            stage.addChild(sp);
          }
          const use = sp instanceof Mesh ? (sheetTex ?? tex) : tex;
          if (sp.texture !== use) sp.texture = use;
          if (sp instanceof Mesh) {
            const uv = dr.uv!;
            const hw = dr.cell.w / 2, hh = dr.cell.h / 2;
            const pos = sp.geometry.getBuffer("aPosition");
            const uvb = sp.geometry.getBuffer("aUV");
            const pd = pos.data as Float32Array;
            /**
             * UV 창을 계산한다. 셀 기준 정규화 좌표 (0..1) 에서 중심 0.5 를
             * 기준으로 uvs 배 확대하고 uvx/uvy 만큼 옮긴 뒤, 시트를 텍스처로
             * 쓰는 경우 그 값을 시트 좌표로 옮긴다. 그래야 UV 가 셀 밖으로
             * 나갔을 때 시트의 이웃 내용이 보인다(원본은 clamp 라 반복은 없다).
             */
            const u0 = 0.5 - 0.5 * uv.sx + uv.x, u1 = 0.5 + 0.5 * uv.sx + uv.x;
            const v0 = 0.5 - 0.5 * uv.sy + uv.y, v1 = 0.5 + 0.5 * uv.sy + uv.y;
            const c = dr.cell;
            const useSheet = !!(sheetTex && c.sheet && c.sw && c.sh && c.rw && c.rh);
            const rx = useSheet ? (c.rx ?? 0) / c.sw! : 0;
            const ry = useSheet ? (c.ry ?? 0) / c.sh! : 0;
            const rw = useSheet ? c.rw! / c.sw! : 1;
            const rh = useSheet ? c.rh! / c.sh! : 1;
            const r = uv.rot * Math.PI / 180;
            const cr = Math.cos(r), sr = Math.sin(r);
            const ud = uvb.data as Float32Array;

            /** UV 를 셀 좌표에서 시트 좌표로 (회전 포함) */
            const map = (u: number, v: number, i: number) => {
              let cu = u, cv = v;
              if (uv.rot) {
                const du = u - 0.5, dv = v - 0.5;
                cu = 0.5 + du * cr - dv * sr;
                cv = 0.5 + du * sr + dv * cr;
              }
              ud[i] = rx + cu * rw;
              ud[i + 1] = ry + cv * rh;
            };

            const vt = dr.vert;
            pd[0] = -hw + (vt?.[4] ?? 0); pd[1] = -hh - (vt?.[5] ?? 0);
            pd[2] =  hw + (vt?.[6] ?? 0); pd[3] = -hh - (vt?.[7] ?? 0);
            pd[4] =  hw + (vt?.[2] ?? 0); pd[5] =  hh - (vt?.[3] ?? 0);
            pd[6] = -hw + (vt?.[0] ?? 0); pd[7] =  hh - (vt?.[1] ?? 0);
            map(u0, v0, 0); map(u1, v0, 2); map(u1, v1, 4); map(u0, v1, 6);
            pos.update(); uvb.update();
          }
          sp.tint = flatTint(dr.vcol);
          sp.alpha = Math.min(1, dr.alpha) * intensityRef.current;
          sp.blendMode = blend;
          sp.visible = true;
          // back 파츠는 카드보다 아래, front 파츠는 위
          sp.zIndex = dr.part.role === "front" ? 100000 + order : order;
          // evaluate() already folded the pivot into dr.x / dr.y.
          // flip the frame, not the texture: negate the y row and y translation
          // Matrix 를 프레임마다 새로 만들지 않고 하나를 덮어쓴다
          scratch.a = dr.a; scratch.b = -dr.b; scratch.c = -dr.c; scratch.d = dr.d;
          scratch.tx = dr.x; scratch.ty = -dr.y;
          sp.setFromMatrix(scratch);
        });
        for (const [i, sp] of sprites) if (!live.has(i)) sp.visible = false;
      };

      const tick = () => { raf = requestAnimationFrame(tick); body(); };
      (dbg as unknown as { step: (f: number) => void }).step = (f: number) => {
        forced = f; body(); forced = null; app!.render();
      };
      raf = requestAnimationFrame(tick);
    })();

    return () => {
      dead = true;
      if (raf) cancelAnimationFrame(raf);
      spritesRef.current.clear();
      cardSpriteRef.current = null;
      stageRef.current = null;
      appRef.current = null;
      if (app && inited) app.destroy(true, { children: true, texture: false });
    };
  }, [renderScale]);

  /**
   * 크기·위치는 렌더러 리사이즈 + 스테이지 변환으로만 처리한다.
   *
   * [문제] width/height 를 init 의존성에 두면 이펙트를 바꿀 때마다(스테이지가
   *   720x1136 / 720x1484 로 갈리므로) WebGL 컨텍스트를 통째로 다시 만든다.
   *   텍스처를 전부 다시 올리는 동안 화면이 비고, 위의 init 경합도 여기서 났다.
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const app = appRef.current;
    if (app?.renderer) {
      if (app.renderer.width !== width || app.renderer.height !== height) {
        app.renderer.resize(width, height);
      }
      /**
       * CSS 크기는 **조건 없이** 매번 맞춘다.
       *
       * [문제] 리사이즈 조건 안에서만 style 을 쓰면, doc 이 없을 때 만들어진
       *   첫 캔버스(기준 640 스테이지 = 787px)의 style 이 그대로 남는다. 그 뒤
       *   실제 스테이지(720 = 885px)로 백킹만 커지고 style 은 787 이라 캔버스가
       *   가로로 0.889 배 눌린다. 선수 사진이 홀쭉해 보이던 원인.
       * [측정] 백킹 885x1397(0.634) vs 표시 787x1397(0.563).
       */
      app.canvas.style.width = `${width}px`;
      app.canvas.style.height = `${height}px`;
    }
    stage.position.set(width / 2 + offsetX, height * originY + offsetY);
    stage.scale.set(scale ?? height / CARD_ART_REF_H);
  }, [width, height, originY, scale, offsetX, offsetY]);

  // 카드 이미지는 미리 로드해야 첫 프레임부터 그려진다
  useEffect(() => {
    if (!cardArt) { cardTexRef.current = null; cardArtReadyRef.current = null; return; }
    let alive = true;
    // 확장자가 없는 API URL 이라 파서를 지정해야 이미지로 읽는다
    Assets.load({ src: cardArt, parser: "loadTextures" })
      .then((tex: Texture) => {
        if (!alive || !tex?.source) return;
        // 아틀라스 512x1024 중 카드 그림은 위 660 행
        const h = Math.min(CARD_ART_H, tex.source.height || CARD_ART_H);
        cardTexRef.current = new Texture({
          source: tex.source,
          frame: new Rectangle(0, 0, Math.min(CARD_ART_W, tex.source.width || CARD_ART_W), h),
        });
        cardArtReadyRef.current = cardArt;
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [cardArt]);

  // swapping documents only swaps sprites
  useEffect(() => {
    docRef.current = doc;
    readyRef.current = null;
    const stage = stageRef.current;
    if (stage) {
      for (const sp of spritesRef.current.values()) sp.destroy();
      spritesRef.current.clear();
      stage.removeChildren();
      /**
       * [문제] removeChildren 은 카드 스프라이트도 떼어 내는데 cardSpriteRef 는
       *   그 고아 객체를 계속 들고 있었다. tick 은 `if (!card)` 일 때만 addChild
       *   하므로 다시 붙는 일이 없어, 이펙트를 바꾸면 선수 사진이 사라졌다.
       * [처리] 참조도 같이 비운다. tick 이 다음 프레임에 새로 만들어 붙인다.
       */
      cardSpriteRef.current = null;
    }
    if (!doc) return;
    let alive = true;
    const urls = cellUrls(doc);
    (urls.length ? Assets.load(urls).catch(() => undefined) : Promise.resolve())
      .then(() => (alive ? prepare(doc) : undefined))
      .then(() => { if (alive) readyRef.current = doc.effectId; });
    return () => { alive = false; };
  }, [doc]);

  return <div ref={host} className="anss-stage" style={{ width, height }} />;
}
