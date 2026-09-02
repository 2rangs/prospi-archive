"use client";

import { useEffect, useRef } from "react";
import { Application, Assets, Container, Matrix, Mesh, MeshGeometry, Rectangle, Shader, Sprite, Texture,
  compileHighShaderGlProgram, localUniformBitGl, roundPixelsBitGl, textureBitGl, TextureSource } from "pixi.js";
import { AnssDocument, BASE_W, BASE_H, CARD_ART_H, CARD_ART_REF_H, CARD_ART_W, BlendType, Cell, PartType } from "./types";
import { Draw, VCol, evaluate } from "./evaluate";

/** Immutable effect textures live on the archive CDN, outside the Sites bundle. */
const EFFECT_TEXTURE_ROOT =
  "https://cdn.jsdelivr.net/gh/2rangs/prospi-archive@36f90521ee5374248c82cc6fb6bd193bd58439de/public/effects";
/** 원본 구장 배경 (ALBUM1630 / BG001, 1024x1616). */
export const PLAYER_BG_URL = "/img/player-bg/album-stadium-dark.png";
export const effectTextureUrl = (path: string) => `${EFFECT_TEXTURE_ROOT}/${path}`;

/**
 * CDN 에 없는 텍스처를 **같은 저장소의 로컬 사본**으로 대신 받는다.
 *
 * [확인된 사실] 위 CDN 은 아카이브 저장소의 **고정 커밋**을 가리키는데, 거기에
 *   아이콘(_S) 문서가 쓰는 시트가 **1,087개 전부 없다.** 스프라이트는 0개 누락.
 *   무대(_L) 는 시트 10 · 스프라이트 108 개만 빠져 있다.
 * [근거] 아카이브 저장소 트리(991061d, 항목 18,477개)와 anim-gz/anim-s-gz 가
 *   참조하는 해시를 전수 대조. 개별 확인: sheets-webp/099590cf28e70ba1.webp 는
 *   고정 커밋·main·latest 모두 404, sprites-webp 두 건은 200.
 * [증상] 그래서 목록의 이펙트 아이콘에서 UV/메시 파츠가 통째로 안 그려진다
 *   (사용자 보고: 407903500 → 이펙트 417005 아이콘이 비어 있음).
 * [처리] PixiJS 는 `Assets.add({alias, src:[a,b]})` 로 **앞의 소스가 실패하면
 *   다음 소스**를 쓴다. alias 를 CDN URL 로 두면 기존 `Texture.from(cdnUrl)`
 *   호출을 하나도 안 고치고 폴백이 붙는다.
 * [해결] 사용자 승인을 받아 아카이브 저장소에 빠진 파일을 올렸다
 *   (36f9052 — 시트 1,096 · 스프라이트 108, 53.6MB). 위 CDN 경로도 그
 *   커밋으로 올렸고 099590cf28e70ba1.webp 가 200 으로 바뀐 것을 확인했다.
 *   폴백은 다음에 또 빠지는 파일이 생겨도 화면이 비지 않도록 남겨 둔다.
 */
const aliased = new Set<string>();
export function registerTextureFallback(urls: string[]): string[] {
  for (const u of urls) {
    if (aliased.has(u)) continue;
    aliased.add(u);
    const i = u.indexOf("/public/effects/");
    const path = i >= 0 ? u.slice(i + "/public/effects/".length)
                        : u.slice(EFFECT_TEXTURE_ROOT.length + 1);
    if (!path) continue;
    try { Assets.add({ alias: u, src: [u, `/effects/${path}`] }); }
    catch { /* 이미 등록됨 */ }
  }
  return urls;
}

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
/**
 * 메시에 **정점 알파**를 넣기 위한 셰이더.
 *
 * [문제] 정점색이 `blend != 0`(모서리별)일 때 스프라이트는 그라데이션을 텍스처에
 *   구워 넣지만, UV 파츠는 시트를 그대로 샘플하는 Mesh 라 그 경로를 타지 않는다.
 *   그래서 모서리 알파가 통째로 버려지고, 양 끝이 사라져야 할 띠가 각진 불투명
 *   판이 된다 — 1285005 의 `eff_t`(알파 0,0,1,1) · `eff_u`(1,1,0,0) 가 그것이다.
 * [측정] 모서리별 알파가 서로 다른 정점색 키 4,584개 중 **2,989개가 UV/정점변형
 *   파츠**(메시)이고 이펙트 37개에 걸쳐 있다.
 * [처리] PIXI 의 high-shader 템플릿은 최종색을 `outColor * vColor` 로 낸다.
 *   `vColor *= aColor` 한 줄을 하는 bit 를 끼워 정점 속성을 곱한다. 나머지
 *   bit(localUniform·texture·roundPixels)는 기본 메시 셰이더와 같은 구성이다.
 * [신뢰도] 원본 정점색 값 CONFIRMED · 모서리↔정점 대응은 스프라이트 경로와
 *   같은 규약을 따랐다(POSSIBLE — 뒤집히면 그라데이션 방향만 반대가 된다).
 */
const vertexColorBitGl = {
  name: "anss-vertex-color-bit",
  vertex: { header: "in vec4 aColor;", main: "vColor *= aColor;" },
};
let vcolProgram: ReturnType<typeof compileHighShaderGlProgram> | null = null;
export type VcolShader = Shader & { texture: Texture };
export function makeVcolShader(): VcolShader {
  vcolProgram ??= compileHighShaderGlProgram({
    name: "anss-mesh-vcol",
    bits: [localUniformBitGl, textureBitGl, vertexColorBitGl, roundPixelsBitGl],
  });
  const sh = new Shader({
    glProgram: vcolProgram,
    resources: {
      uTexture: Texture.EMPTY.source,
      textureUniforms: { uTextureMatrix: { type: "mat3x3<f32>", value: new Matrix() } },
    },
  }) as VcolShader;
  // Mesh.shader 는 TextureShader 를 요구한다(텍스처 필드를 읽어 크기를 잡는다).
  sh.texture = Texture.EMPTY;
  return sh;
}

/** 네 모서리 알파가 모두 1 이면 그라데이션이 없는 것이다. */
export function cornerAlphas(v?: VCol): number[] | null {
  if (!v || v.blend === 0) return null;
  const a = v.c.map(c => (c[3] ?? 1));
  return a.some(x => x < 1 - 1e-6) ? a : null;
}

/**
 * 코너별 **색까지** 돌려준다 (0..1 정규화, [r,g,b,a]).
 *
 * [문제] 사용자 보고 "711003/4/5 의 흰색이 너무 뿌옇다".
 * [확인된 사실] 메시(UV) 파츠는 정점색 RGB 를 통째로 버리고 있었다.
 *   정점색 버퍼에 `cd[o]=cd[o+1]=cd[o+2]=a` 로 **알파만** 넣었기 때문이다.
 *   스프라이트 경로는 cellTexture 가 코너색을 텍스처에 구워 넣지만, 메시는
 *   시트 원본을 그대로 쓰므로 구운 텍스처를 지나친다 -> 색이 사라져 흰색.
 * [근거] 711005 는 렌더 픽셀의 **87% 가 무채색**(평균 채도 0.041)인데,
 *   원본 데이터의 boke 파츠 정점색은 노랑->초록->시안 무지개다
 *   (클립 이름도 `rainbow`). 정상 이펙트 1281005 는 무채색 18.8% · 채도 0.558.
 * [연결] minor 분석에서 UV 파츠가 15.7배 편중된 것과 같은 뿌리다.
 * [처리] 프리멀티플라이 규약을 지켜 rgb x a 를 넣는다(가산에서 알파가
 *   먹히도록 — 기존 주석의 근거는 그대로 유효하다).
 * [신뢰도] CONFIRMED (원본 정점색 vs 렌더 채도 실측)
 */
/**
 * 정점색 셰이더를 **텍스처 소스별로 공유**한다.
 *
 * [문제] 사용자 보고 "렉 너무 심한디". 계측: 1281005 의 step 이 중앙 37ms
 *   (p95 110ms) = 27fps/9fps. 메시 46개가 **각자 고유 셰이더 인스턴스**를
 *   들고 있어 배칭이 전혀 안 되고 드로우마다 셰이더 바인드 + 유니폼 업로드가
 *   일어났다.
 * [처리] 정점색은 지오메트리 버퍼(aColor)에 들어가므로 같은 텍스처를 쓰는
 *   메시끼리는 셰이더를 공유해도 결과가 같다. 소스 uid 로 캐시한다.
 *   (전역 1개로 합치면 셰이더의 uTexture 가 공유돼 마지막 텍스처로 전부
 *   그려지므로 안 된다 — 반드시 소스별이어야 한다.)
 * [신뢰도] 구조 CONFIRMED / 개선폭은 아래 재계측으로 확인.
 */
const vcolShaders = new Map<number, VcolShader>();
function vcolShaderFor(tex: Texture): VcolShader {
  const source = tex.source;
  const uid = (source as unknown as { uid: number }).uid;
  let sh = vcolShaders.get(uid);
  if (!sh) {
    sh = makeVcolShader();
    if (vcolShaders.size > 256) vcolShaders.clear();
    vcolShaders.set(uid, sh);
  }
  sh.resources.uTexture = source;
  sh.resources.uSampler = source.style;
  sh.resources.textureUniforms.uniforms.uTextureMatrix = tex.textureMatrix.mapCoord;
  sh.texture = tex;
  return sh;
}

export function cornerColors(v?: VCol): number[][] | null {
  if (!v || v.blend === 0 || !v.c.length) return null;
  const out = v.c.map(c => [
    (c[0] ?? 255) / 255, (c[1] ?? 255) / 255, (c[2] ?? 255) / 255, c[3] ?? 1,
  ]);
  const plain = out.every(c => c[0] > 1 - 1e-6 && c[1] > 1 - 1e-6 && c[2] > 1 - 1e-6
    && c[3] > 1 - 1e-6);
  return plain ? null : out;
}

/** 정점색을 굽지 않은 셀 텍스처 — 메시는 셰이더로 색을 입히므로 이중 적용을 막는다. */
export function cellTexturePlain(cell: Cell, additive = false): Texture | null {
  return intensityTexture(cell, additive) ?? Texture.from(spriteUrl(cell.file));
}

/**
 * 스크롤 창(§34)의 UV 세로 이동 단위를 **원본 이미지 높이**로 쓸지.
 *
 * [상태] **기본 ON** (r56). §34 의 fan01(정지값 = 리본의 빈 꼬리)에 더해
 * §40 의 로고 광택(정지값 = 빈 행/시트 밖 -> 광택이 사라짐)이 독립적으로
 * 같은 해석을 지지한다. `window.__anssScrollWindow = false` 로 끈다.
 */
/**
 * 이펙트 전용 크기 보정 (카드 아트 제외). 원본 스크린샷 실측 기준 0.72.
 * `window.__anssFxScale` 로 바꿀 수 있다 (1 = 보정 없음).
 */
/**
 * 카드+이펙트 전체를 프레임 대비 줄이는 계수. 원본 실측 기준 0.86.
 * `window.__anssFitScale` 로 바꿀 수 있다 (1 = 보정 없음).
 */
/** 셀 = 시트 전체인 UV 파츠를 반복 샘플링할지. `window.__anssWrap` 로 토글. */
/** UV 이동을 텍스처 페이지 단위로 읽을지 (docs §41). `window.__anssUvPage` 로 토글. */
let uvPageUnits = true;
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__anssUvPage", {
    get: () => uvPageUnits,
    set: (v: boolean) => { uvPageUnits = !!v; },
    configurable: true,
  });
}

// Native AnimssCellPart uses the texture sampler's CLAMP_TO_EDGE path even when
// a cell occupies the full sheet. Repeat remains available only for A/B checks.
let wrapFullSheet = false;
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__anssWrap", {
    get: () => wrapFullSheet,
    set: (v: boolean) => { wrapFullSheet = !!v; },
    configurable: true,
  });
}

let fitScaleAdjust = 0.86;
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__anssFitScale", {
    get: () => fitScaleAdjust,
    set: (v: number) => { fitScaleAdjust = Number(v) > 0 ? Number(v) : 1; },
    configurable: true,
  });
}

const artHeightCache = new Map<string, number>();
let artCropOn = true;
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__anssArtCrop", {
    get: () => artCropOn,
    set: (v: boolean) => { artCropOn = !!v; artHeightCache.clear(); },
    configurable: true,
  });
}

/**
 * [갱신] 사용자 지시 "이펙트와 선수 원본 사진 너비를 동일하게 — 굳이 좁힐
 * 필요 없음". 스크린샷 역산으로 넣었던 0.72 축소를 걷고 원본 1:1 로 둔다.
 * (논리단위 1 = 카드아트 픽셀 1)
 */
let fxScaleAdjust = 1;
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__anssFxScale", {
    get: () => fxScaleAdjust,
    set: (v: number) => { fxScaleAdjust = Number(v) > 0 ? Number(v) : 1; },
    configurable: true,
  });
}

let scrollWindow = true;
export const scrollWindowOn = () => scrollWindow;
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__anssScrollWindow", {
    get: () => scrollWindow,
    set: (v: boolean) => { scrollWindow = !!v; },
    configurable: true,
  });
}

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
 * 캐시 상한. 셋 다 종전에는 무한이었다.
 *
 * [문제] cornerCache 키는 셀 x 정점색(5비트 양자화)이라 이펙트를 옮겨 다니면
 *   조합이 계속 늘어난다. 항목 하나가 캔버스 텍스처(수십~수백 KB GPU 메모리)라
 *   /effects 에서 수십 개를 훑으면 GPU 메모리가 바닥나 **컨텍스트가 죽고 화면이
 *   통째로 사라진다** — "일정 개수 이상 보면 사라지는 버그".
 * [처리] 삽입 순서 = Map 순회 순서를 이용한 FIFO 상한. 넘치면 앞에서부터
 *   destroy. 현재 문서가 쓰는 항목이 밀려나도 다음 프레임에 다시 만들므로
 *   깜빡임 이상의 비용은 없다.
 */
const CACHE_CAP = 600;
function capCache<V extends Texture | null>(m: Map<string, V>) {
  /**
   * [철회] 처음에는 밀려난 텍스처를 destroy(true) 했는데, 화면 스프라이트가
   * 아직 그 텍스처를 쓰고 있으면 source 가 null 이 되어
   * "Cannot read properties of null (reading 'alphaMode')" 로 죽는다(사용자
   * 보고, r60). 캐시는 **참조만** 내려놓는다 — GPU 해제는 PIXI 의
   * TextureGCSystem(기본: 한동안 안 쓰인 텍스처 자동 unload)에 맡긴다.
   */
  while (m.size > CACHE_CAP) {
    m.delete(m.keys().next().value as string);
  }
}

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
/**
 * **타일 루프 파츠** 판정 — 셀 한 장을 이음매 없이 굴리는 UV 애니메이션.
 *
 * [문제] 사용자 보고 "이펙트 파츠 한두 개만 이상하다 / 이상하리만큼 뿌옇다".
 * [확인된 사실] 시트의 **부분 셀**인데 UV 이동폭이 정확히 1.0 이상인 파츠가
 *   그 증상의 주범이다. 품질 라벨 대조에서 이런 파츠를 50개 이상 가진 효과는
 *   minor 22.1% vs clean 1.4% — **15.7배** 편중(전 특징 중 1위).
 * [결정적 근거 — 실제 시트 픽셀 측정] minor 의 해당 파츠 1,299개 · 7,694
 *   프레임에서 샘플 창의 평균 알파를 재면:
 *     clamp(현행)     빈 창 7.5%
 *     wrap-cell       빈 창 0.1%   ← 75배 개선
 *     wrap-container  빈 창 5.1%
 *   즉 현행은 프레임의 7.5% 에서 **아무것도 없는 자리**를 집어 가장자리 한
 *   줄을 늘려 그린다 = 뿌연 얼룩. 셀 단위로 감으면 그 일이 없어진다.
 * [경쟁 가설 — 기각] "UV 단위가 전부 셀"이라는 해석은 in-bounds 검사에서
 *   기각됐다(page 29.4% vs cell 0.0%). 그래서 **전역 전환이 아니라** 아래
 *   게이트에 걸리는 파츠만 셀 단위 + 반복으로 돌린다.
 * [보존] §41 의 사인 광택(1082105 sign_ef_L/R)은 이동폭 0.72~0.91 로 게이트에
 *   걸리지 않아 페이지 단위 clamp 를 그대로 유지한다. 반대로 사용자가 계속
 *   지적한 1285005 의 logo_eff_t01/u01 쌍은 정확히 1.0 이라 걸린다.
 * [신뢰도] 게이트 판정 CONFIRMED(픽셀 측정) / 시각적 최종 확인은 사용자 몫.
 */
/**
 * UV 창이 **빈 자리**를 집는 파츠 표 (tools/uv_wrap.py 가 시트 픽셀로 실측).
 *
 * [문제] 사용자 보고 "배치가 미스매치 나거나 재생 자체가 이상하다. 약간
 *   어긋난 것들이 대부분".
 * [근거] 남은 minor 92개의 uvsy 파츠 1,109개 / 9,837프레임 측정 —
 *   clamp(현행) 빈 창 7.4% vs wrap-cell 1.7% (4.4배). 표에 담긴 파츠는
 *   "clamp 가 실제로 빈 자리를 집고, 감으면 그림이 있는" 경우만이다.
 * [편중] 표 대상 효과 63개 = minor 32% vs clean 6% (5.47배).
 * [보존] §41 의 사인 광택(1082105)은 빈 자리를 집지 않아 표에 없다 —
 *   페이지 단위 clamp 를 그대로 유지한다.
 */
/**
 * `_t`/`_u` 쌍을 합친 **스트립 텍스처** 표 (tools/uv_strip.py).
 *
 * [문제] r74 는 이 파츠들을 **개별 셀(반쪽)** 텍스처로 repeat 했다. 쌍이 하나의
 *   그림이므로 반복 주기가 2배 빨라져 내용이 겹치고 뭉개진다 — 사용자가 본
 *   "중앙이 노랑/흰색으로 날아감".
 * [근거] 인접 쌍 624/624 에서 알파가 이음매에서 연속(교차 페이드) ·
 *   해당 파츠 보유 효과가 minor 57% vs clean 10% (5.7배).
 * [처리] 쌍을 위아래로 붙인 스트립을 repeat 로 샘플링하고, 파츠는 자기 절반
 *   (0=위, 1=아래)을 창으로 쓴다. 그러면 주기가 쌍 전체가 된다.
 */
let uvStripTable: Record<string, Record<string, [string, number]>> | null = null;
if (typeof window !== "undefined") {
  void fetch("/effects/uv-strip.json")
    .then(r => (r.ok ? r.json() : null))
    .then((j) => { uvStripTable = j ?? {}; })
    .catch(() => { uvStripTable = {}; });
}
/** 검증용 토글: `window.__anssStrip = 0` 으로 쌍 스트립을 끄고 A/B 비교한다. */
// The native renderer never rebuilds _t/_u cells into a repeatable texture.
// Keep the experimental path behind the existing toggle, but do not use it by
// default: 1285005 was one of the effects whose UVs were changed by this hack.
let stripOn = false;
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__anssStrip", {
    get: () => (stripOn ? 1 : 0),
    set: (v: number) => { stripOn = !!Number(v); },
    configurable: true,
  });
}
/** 표 조회 키는 **셀 식별자**다 — 같은 파츠 이름이 서로 다른 셀을 쓸 수 있다. */
function cellKey(c: Cell): string {
  return `${c.sheet}:${c.rx ?? 0},${c.ry ?? 0},${c.rw}x${c.rh}`;
}
function stripOf(effectId: number | undefined, cell: Cell): [string, number] | null {
  if (!stripOn || !uvStripTable || effectId == null || !cell.sheet) return null;
  return uvStripTable[String(effectId)]?.[cellKey(cell)] ?? null;
}
/**
 * 쌍 스트립을 외부(thumb.ts)에서도 쓰게 노출한다.
 * `wantHalf` 를 주면 텍스처 대신 절반 인덱스(0=위, 1=아래)를 돌려준다.
 */
export function stripFor(effectId: number | undefined, cell: Cell,
                         wantHalf = false): Texture | number | null {
  const e = stripOf(effectId, cell);
  if (!e) return null;
  if (wantHalf) return e[1];
  return stripTexture(e[0]);
}

const stripCache = new Map<string, Texture>();
/**
 * [수정] `Texture.from(url)` 은 **아직 로드되지 않은 URL** 에 대해 source 가 없는
 *   객체를 돌려준다 -> "Cannot read properties of undefined (reading 'source')"
 *   로 렌더 루프가 죽었다(사용자 보고). 로드 전에는 null 을 돌려 기존 경로로
 *   내려가게 하고, 프리로드는 문서 전환 시 Assets.load 가 맡는다.
 */
export function stripUrl(hash: string): string {
  return `/effects/strips-webp/${hash}.webp`;
}
function stripTexture(hash: string): Texture | null {
  let t = stripCache.get(hash);
  if (!t) {
    const cached = Assets.cache.has(stripUrl(hash))
      ? (Assets.get(stripUrl(hash)) as Texture | undefined) : undefined;
    if (!cached || !cached.source) return null;
    t = cached;
    if (stripCache.size > 256) stripCache.clear();
    stripCache.set(hash, t);
  }
  if (!t.source) { stripCache.delete(hash); return null; }
  const st = t.source.style;
  if (st.addressMode !== "repeat") { st.addressMode = "repeat"; st.update(); }
  return t;
}

/** 이 문서가 쓰는 쌍 스트립 URL 목록 — 문서 전환 시 미리 싣는다. */
export function stripUrls(doc: AnssDocument): string[] {
  const tbl = uvStripTable?.[String(doc.effectId)];
  if (!tbl) return [];
  const set = new Set<string>();
  for (const v of Object.values(tbl)) set.add(stripUrl(v[0]));
  return [...set];
}

let uvWrapTable: Record<string, string[]> | null = null;
const uvWrapSets = new Map<string, Set<string>>();
let uvCellRepeat = false;
if (typeof window !== "undefined") {
  void fetch("/effects/uv-wrap.json")
    .then(r => (r.ok ? r.json() : null))
    .then((j: Record<string, string[]> | null) => { uvWrapTable = j ?? {}; })
    .catch(() => { uvWrapTable = {}; });
  Object.defineProperty(window, "__anssCellRepeat", {
    get: () => (uvCellRepeat ? 1 : 0),
    set: (v: number) => { uvCellRepeat = !!Number(v); },
    configurable: true,
  });
}
function isUvWrap(effectId: number | undefined, name: string): boolean {
  if (!uvCellRepeat) return false;
  if (!uvWrapTable || effectId == null) return false;
  const key = String(effectId);
  let set = uvWrapSets.get(key);
  if (!set) {
    const list = uvWrapTable[key];
    if (!list) return false;
    set = new Set(list);
    uvWrapSets.set(key, set);
  }
  return set.has(name);
}

const tileWrapCache = new WeakMap<object, boolean>();
export function isTileWrap(part: { t?: Record<string, unknown> }, cell: Cell): boolean {
  if (!uvCellRepeat) return false;
  const hit = tileWrapCache.get(part);
  if (hit !== undefined) return hit;
  let v = false;
  const sub = !!(cell.sheet && cell.sw && cell.sh &&
    !(cell.rx === 0 && cell.ry === 0 && cell.rw === cell.sw && cell.rh === cell.sh));
  if (sub) {
    for (const k of ["uvx", "uvy"] as const) {
      const tr = part.t?.[k] as [number, number, number][] | undefined;
      if (!tr) continue;
      for (const key of tr) if (Math.abs(key[1]) >= 1 - 1e-6) { v = true; break; }
      if (v) break;
    }
  }
  tileWrapCache.set(part, v);
  return v;
}

export function sheetTexture(sheet: string, additive: boolean): Texture | null {
  const url = effectTextureUrl(`sheets-webp/${sheet}.webp`);
  if (!additive) return Texture.from(url);
  if (sheetCache.has(sheet)) return sheetCache.get(sheet) ?? Texture.from(url);
  return Texture.from(url);
}

function computeSheet(sheet: string, additive: boolean): Texture | null {
  const url = effectTextureUrl(`sheets-webp/${sheet}.webp`);
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
  capCache(sheetCache);
  return tex;
}

/** 렌더 루프용: 준비 단계에서 만들어 둔 것만 쓴다. */
function intensityTexture(cell: Cell, additive = true): Texture | null {
  const url = spriteUrl(cell.file);
  const ikey = `${cell.file}|${additive ? "a" : "m"}`;
  if (intensityCache.has(ikey)) return intensityCache.get(ikey) ?? Texture.from(url);
  /**
   * 캐시에 없으면 **그 자리에서 변환한다** — 종전에는 원본을 그대로 돌려줬다.
   *
   * [문제] 사용자 보고 "울트라맨 로고 재생이 살짝 이상함". 아이콘 front 캔버스에
   *   RGB(0,0,0)·알파 0.6~0.95 픽셀 722개 = **불투명 검정 판**. 1184105 의
   *   광택 스트립(60x32)은 전면 불투명(알파=1)·어두운 회색의 가산용 라이트
   *   시트라 prepare() 가 알파=max채널로 바꿔 두는데, 캐시 상한(600)이나
   *   releaseUnused() 로 항목이 밀려난 뒤에는 이 폴백이 **변환 없는 원본**을
   *   돌려줬다. 가산은 알파도 누적하므로 빈 캔버스 위에 알파 1 이 찍혀
   *   검은 판이 된다 (§'가산 셀' 주석과 같은 병리, 재발 경로만 다름).
   * [처리] computeIntensity 를 직접 부른다. 텍스처가 아직 안 실렸으면
   *   computeIntensity 가 캐시 없이 원본을 돌려주므로 다음 프레임에 재시도된다.
   */
  return computeIntensity(cell, additive);
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
  const url = effectTextureUrl(`sprites-webp/${cell.file}.webp`);
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
    capCache(intensityCache);
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
    capCache(intensityCache);
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
  if (!u) { u = effectTextureUrl(`sprites-webp/${file}.webp`); urlCache.set(file, u); }
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
  // 알파도 키에 넣는다 — 종전에는 slice(0,3) 로 알파를 빼서, RGB 가 같고
  // 알파만 다른 그라데이션이 서로 같은 캐시 항목으로 뭉개졌다.
  // additive 를 키에 넣는다 — 같은 셀·같은 코너라도 변환된 밑판(a)과 원본(m)은
  // 다른 텍스처다. 종전에는 한 항목을 공유해 먼저 구운 쪽이 반대쪽을 오염시켰다.
  const key = `${cell.file}|${additive ? "a" : "m"}|${v.c.map(c =>
    `${c[0] >> 3},${c[1] >> 3},${c[2] >> 3},${Math.round((c[3] ?? 1) * 31)}`).join("|")}`;
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
  // Native AnimssCellPart::updateCell uses the fixed destination-vertex table
  // { 0, 3, 1, 2 }: c0=TL, c1=BL, c2=TR, c3=BR.
  put(0, 0, 0); put(0, 1, 1); put(1, 0, 2); put(1, 1, 3);

  // canvas "multiply" is a separable blend over source-over compositing, so an
  // opaque gradient also overwrites the destination alpha. Multiply the colour,
  // then clip back to the cell's own alpha with destination-in.
  ctx.globalCompositeOperation = "multiply";
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(g, 0, 0, 2, 2, 0, 0, cell.w, cell.h);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(src, 0, 0, cell.w, cell.h);

  /**
   * 모서리 **알파**도 곱한다.
   *
   * [문제] 위 그라데이션은 `rgb(...)` 만 칠했다. 정점색의 네 번째 채널(알파)은
   *   버려져서, RGB 가 네 모서리 모두 흰색이고 **알파만 0↔1 로 갈리는** 파츠가
   *   아무 감쇠 없이 그려졌다. 그런 파츠는 부드럽게 사라져야 할 띠가 각진
   *   불투명 판이 된다 — 화면에서 "네모난 게 떠다니는" 증상.
   * [측정] 정점색 키 380,400개 중 모서리별 알파가 서로 다른 것 **4,584개**,
   *   영향 이펙트 **48개**. 그중 **3,970개는 RGB 가 네 모서리 모두 같아**
   *   알파만이 유일한 효과다. 1285005 의 `eff_t`(알파 0,0,1,1)와
   *   `eff_u`(1,1,0,0)가 대표적이다 — 둘이 맞물려 띠의 양 끝을 지운다.
   * [처리] 2x2 알파 램프를 destination-in 으로 한 번 더 곱한다. 셀 자신의
   *   알파를 복원한 뒤에 적용하므로 최종 알파 = 셀알파 x 모서리알파다.
   * [신뢰도] CONFIRMED (원본 정점색 값 + 기하)
   */
  const ca = v.c.map(c => c[3] ?? 1);
  if (Math.min(...ca) < 1 - 1e-6) {
    const ga = document.createElement("canvas");
    ga.width = 2; ga.height = 2;
    const gac = ga.getContext("2d");
    if (gac) {
      const puta = (x: number, y: number, i: number) => {
        gac.fillStyle = `rgba(0,0,0,${ca[Math.min(i, ca.length - 1)]})`;
        gac.fillRect(x, y, 1, 1);
      };
      puta(0, 0, 0); puta(0, 1, 1); puta(1, 0, 2); puta(1, 1, 3);
      ctx.globalCompositeOperation = "destination-in";
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(ga, 0, 0, 2, 2, 0, 0, cell.w, cell.h);
    }
  }
  ctx.globalCompositeOperation = "source-over";

  const tex = Texture.from(cv);
  cornerCache.set(key, tex);
  capCache(cornerCache);
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
      if (c.file) set.add(effectTextureUrl(`sprites-webp/${c.file}.webp`));
      if (uv && c.sheet) set.add(effectTextureUrl(`sheets-webp/${c.sheet}.webp`));
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
/**
 * 이전 문서의 GPU 텍스처를 내린다.
 *
 * [문제] 이펙트를 서너 개 보면 화면이 사라진다(사용자 보고). 문서를 바꿀 때
 *   스프라이트는 부수지만 **텍스처는 캐시와 Assets 에 남아** GPU 메모리가
 *   문서마다 수십 MB 씩 쌓였다. 캐시 상한(r60)은 참조만 끊고, PIXI 기본
 *   TextureGC 는 3600프레임(약 2분) 뒤에나 내리므로 서너 번 전환이면 먼저
 *   컨텍스트가 죽는다.
 * [처리] 문서 전환 시, **새 문서가 쓰지 않는** 캐시 항목과 Assets URL 을
 *   즉시 destroy/unload 한다. 이전 문서의 스프라이트는 같은 전환 코드에서
 *   이미 파괴되므로 안전하다.
 */
export async function releaseUnused(next: AnssDocument | null): Promise<void> {
  const keepFiles = new Set<string>();
  const keepSheets = new Set<string>();
  if (next) {
    for (const p of next.parts) {
      for (const c of p.cells ?? (p.c ? [p.c] : [])) {
        if (!c) continue;
        if (c.file) keepFiles.add(c.file);
        if (c.sheet) keepSheets.add(c.sheet);
      }
    }
  }
  /**
   * [철회 — r80] 여기서 `destroy(true)` 를 부르면 **행 아이콘(thumb.ts)** 이
   *   아직 쓰고 있는 텍스처의 source 까지 죽는다. thumb.ts 는 같은
   *   cellTexture/sheetTexture(=cornerCache·intensityCache·sheetCache)를
   *   공유하므로, 이펙트를 바꾸는 순간 목록의 아이콘이 파괴된 소스를 가리켜
   *   렌더 중 죽는다 — 사용자 보고 "다른 거 재생하면 뻑간다".
   *   r60 에서 같은 이유로 이미 참조 해제로 바꿨던 것을 r72 가 되돌렸던 것이라
   *   다시 철회한다. GPU 해제는 아래 textureGC 설정에 맡긴다.
   */
  const sweep = (m: Map<string, Texture | null>, keep: Set<string>) => {
    for (const k of [...m.keys()]) {
      if (keep.has(k.split("|")[0])) continue;
      m.delete(k);
    }
  };
  sweep(cornerCache as Map<string, Texture | null>, keepFiles);
  sweep(intensityCache, keepFiles);
  sweep(sheetCache, keepSheets);
  /**
   * 정점색 셰이더 캐시도 **함께** 비운다.
   *
   * [문제] 사용자 보고 "이펙트 다른 거 재생하면 이전 거 지워라, 자꾸 뻑간다".
   * [원인] r78 에서 셰이더를 텍스처 소스 uid 로 캐시했는데, 바로 위 sweep 이
   *   그 소스를 destroy 해도 캐시는 남아 **파괴된 소스를 가리키는 셰이더**가
   *   다음 문서에서 재사용됐다. 소스가 null 이 되어 렌더 중 크래시
   *   ("Cannot read properties of null (reading 'alphaMode')" 계열)로 이어진다.
   * [처리] 문서 전환마다 셰이더 캐시를 비운다. 셰이더는 텍스처당 1개라
   *   재생성 비용이 작고, uid 는 재사용될 수 있으므로 부분 삭제보다 안전하다.
   */
  for (const sh of vcolShaders.values()) {
    try { (sh as unknown as { destroy?: () => void }).destroy?.(); } catch { /* 이미 파괴됨 */ }
  }
  vcolShaders.clear();
  // Assets 캐시의 스프라이트/시트 URL 도 내린다 (새 문서 것 제외)
  const toUnload: string[] = [];
  for (const key of ["sprites-webp", "sheets-webp"] as const) {
    void key;
  }
  const cacheAny = Assets.cache as unknown as { _cache?: Map<string, unknown> };
  const inner = cacheAny._cache;
  if (inner) {
    for (const k of inner.keys()) {
      if (typeof k !== "string") continue;
      const m1 = k.match(/\/effects\/sprites-webp\/([0-9a-f]{16})\.webp$/);
      const m2 = k.match(/\/effects\/sheets-webp\/([0-9a-f]{16})\.webp$/);
      if (m1 && !keepFiles.has(m1[1])) toUnload.push(k);
      else if (m2 && !keepSheets.has(m2[1])) toUnload.push(k);
    }
  }
  // [철회] Assets.unload 도 내부 텍스처를 파괴해 위와 같은 크래시를 만든다.
  //   URL 목록은 진단용으로만 남긴다.
  void toUnload;
}

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
      /**
       * 화면 픽셀 밀도만큼 그린다.
       *
       * [문제] resolution 이 1 이라 백킹 버퍼가 **CSS 픽셀 수와 같았다**.
       *   Retina(dpr 2)에서는 브라우저가 그것을 2배로 늘려 표시하므로 파티클
       *   윤곽·불꽃 가닥이 전부 두 배로 뭉개진다. 원본 게임은 단말 해상도로
       *   그리므로, 우리 쪽만 세로/가로 절반 해상도로 합성하고 있었다.
       * [측정] 선수 상세에서 백킹 885x1825 · CSS 885x1825 · dpr 2
       *   = 물리 1770x3650 을 885x1825 버퍼로 채움(2배 확대).
       * [처리] resolution 에 devicePixelRatio 를 곱한다. autoDensity 는 계속
       *   false 이고 CSS 크기는 아래에서 직접 지정하므로 레이아웃은 그대로다.
       * [주의] 선수 상세의 캔버스는 카드 틀보다 크고 overflow:hidden 으로
       *   잘린다(이펙트가 카드 밖으로 번지므로 의도된 구조다). 그래서 백킹이
       *   885x1825 x dpr2 = 6.5M 화소까지 간다. 화소 예산 9M 을 넘지 않도록
       *   배율을 되돌린다 — 저사양/모바일에서 프레임이 무너지는 것을 막는다.
       * [신뢰도] CONFIRMED (dpr·백킹 실측)
       */
      const PIXEL_BUDGET = 9e6;
      let dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const area = Math.max(1, width * height);
      while (dpr > 1 && area * dpr * dpr > PIXEL_BUDGET) dpr -= 0.25;
      await app.init({
        width, height, backgroundAlpha: 0, antialias: true,
        resolution: renderScaleRef.current * dpr,
        autoDensity: false,
        /**
         * 안 쓰이는 GPU 텍스처를 **빨리** 내린다.
         *
         * [문제] 기본값은 60프레임마다 검사 · 3600프레임(약 2분) 미사용 시 해제라,
         *   이펙트를 서너 개 넘기면 VRAM 이 먼저 바닥나 컨텍스트가 죽었다.
         * [처리] 30프레임마다 검사 · 300프레임(10초) 미사용이면 해제. 명시적
         *   destroy 와 달리 **사용 중인 텍스처는 건드리지 않으므로** 행 아이콘이
         *   공유하는 텍스처를 깨지 않는다.
         */
        textureGCActive: true,
        textureGCCheckCountMax: 30,
        textureGCMaxIdle: 300,
      });
      app.canvas.style.width = `${width}px`;
      app.canvas.style.height = `${height}px`;
      /**
       * 자동 렌더를 끈다. 원본 애니메이션은 **30fps** 인데 Application 의
       * 기본 티커는 화면 주사율(60/120Hz)마다 render() 를 부른다. 같은
       * 원본 프레임을 2~4번 다시 그리는 셈이라 GPU 를 그만큼 헛돈다.
       * 아래 body() 에서 원본 프레임이 바뀔 때만 직접 render() 한다.
       * (thumb.ts 는 이미 같은 게이트를 쓰고 있었고 여기만 빠져 있었다.)
       */
      app.stop();
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
        /**
         * 프레임 대비 전체 크기 보정. (docs §38)
         *
         * [근거] 원본 스크린샷 실측 — 카드아트/화면폭 **0.61** ·
         *   불고리/화면폭 **0.78**. 보정 전 우리 값은 0.71 / 0.93 이었다.
         *   둘의 **상대비(고리/카드 1.30)는 이미 맞으므로**, 전체에 0.86 을
         *   곱하면 0.61 / 0.80 이 되어 원본과 맞는다.
         * [주의] 스크린샷 눈대중이라 +-15%. `window.__anssFitScale = 1` 로 끈다.
         */
        stage.scale.set((b.scale ?? b.height / CARD_ART_REF_H) * fitScaleAdjust);
      }
      app.stage.addChild(stage);
      stageRef.current = stage;
      appRef.current = app;
      // 디버그: 최종 픽셀을 재려면 렌더러가 필요하다 (window.__anss.app)
      const dbg = { app, stage, frames: 0, ready: () => readyRef.current,
                    docId: () => docRef.current?.effectId ?? null,
                    draws: 0, noUv: false, noFrameGate: false,
                    dropMix: 0, dropMute: 0, dropTex: 0,
                    dropFiles: new Set<string>(),
                    // 디버그 A/B: true 로 두면 스크롤 창(§34)을 끄고 창 높이를
                    // 이동 단위로 되돌린다. 같은 세션에서 전/후를 비교한다.
                    noScrollWindow: false,
                    // 파츠 이름별로 그려진 스프라이트를 되짚기 위한 디버그 색인.
                    // 특정 레이어만 남기고 렌더해 원본과 대조할 때 쓴다.
                    byPart: new Map<string, unknown[]>() };
      (window as unknown as { __anss?: unknown }).__anss = dbg;
      (window as unknown as { __anssAssets?: unknown }).__anssAssets = Assets;

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
      let lastSrcFrame = -1, lastDocId: number | null = null;

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

        // 자동 렌더를 껐으므로 어느 경로로 빠져나가든 한 번은 그려야 한다.
        // (여기서 그냥 return 하면 로딩 중 카드 사진이 통째로 안 나온다.)
        if (!d || readyRef.current !== d.effectId) { app!.render(); return; }
        if (!reduce) clock += dt * speedRef.current;
        // no global wrap: each part wraps on its own animation length, and the
        // lengths (121, 361, 601, 31 ...) share no small common multiple
        // speed는 clock에 이미 반영됐다. 여기서 다시 곱하면 50%가 25%, 200%가
        // 400%로 재생되는 제곱 배속이 된다.
        // 현재 682개는 모두 30fps지만 JSON에 보존한 원본 값을 기준으로 삼는다.
        // 신규 팩에서 다른 fps가 들어와도 UI 배속과 실제 타임라인이 어긋나지 않는다.
        const frame = forced !== null ? forced : clock * (d.fps || APP_FPS);
        /**
         * 원본 프레임이 그대로면 아무 것도 다시 만들지 않는다.
         *
         * [근거] 원본은 30fps 다. 60Hz 화면에서는 같은 프레임을 2번, 120Hz 면
         *   4번 재구성했다 — 파츠 수백 개의 변환·정점버퍼·업로드를 통째로.
         * [주의] 문서가 바뀌면 프레임 번호가 같아도 다시 만들어야 한다.
         * [되돌리기] `window.__anss.noFrameGate = true`
         */
        const srcFrame = Math.floor(frame);
        const docChanged = lastDocId !== d.effectId;
        if (forced === null && !dbg.noFrameGate && !docChanged && srcFrame === lastSrcFrame) {
          // 원본 프레임이 그대로면 **재구성만** 건너뛴다. 그리기는 한다 —
          // 카드 텍스처가 늦게 도착하는 등 무대 밖 변화가 있을 수 있다.
          app!.render(); return;
        }
        lastSrcFrame = srcFrame; lastDocId = d.effectId;
        const draws: Draw[] = evaluate(d, frame, roleRef.current);
        dbg.draws = draws.length;
        dbg.dropMix = 0; dbg.dropMute = 0; dbg.dropTex = 0; dbg.dropFiles.clear();
        dbg.byPart.clear();

        live.clear();
        draws.forEach((dr, order) => {
          // 조상 그룹 블렌드까지 반영한 값 (evaluate 의 plan.blend)
          const blend = pixiBlend(dr.blend ?? dr.part.bl);
          const sw = d.stageW || BASE_W, sh = d.stageH || BASE_H;
          const dw = dr.cell.w * Math.hypot(dr.a, dr.b);
          const dh = dr.cell.h * Math.hypot(dr.c, dr.d);
          const isBackdropPlate = blend === "normal" && dw >= sw * 0.9 && dh >= sh * 0.9;
          /**
           * 배경 레이어 끄기 = **화면을 통째로 덮는 판만** 버린다.
           *
           * [실패 이력] 처음엔 "일반 블렌드 전부", 다음엔 "back 층의 일반
           *   블렌드 전부"를 버렸다. 둘 다 과했다.
           *     1차 → 사인(front, 508x252)이 사라짐 (1039454800 / 1082105)
           *     2차 → **SELECTION 로고·리본 문구**가 사라짐. 1214105 의 back 층
           *           일반블렌드 셀 파츠 79개 안에 logo_base·logo_base_bloom 이
           *           들어 있다 (1237950700 SL3 보고).
           * [처리] 가리는 주범은 저작 화면을 꽉 채우는 불투명 판 하나뿐이다.
           *   **그리는 크기가 스테이지의 90% 이상**일 때만 버린다.
           *   로고(512x128)·리본(256x128)은 스테이지(720x1484)에 한참 못 미쳐 남는다.
           * [되돌리기] backdrop 을 켜면(기본값) 아무 것도 버리지 않는다.
           */
          if (!backdropRef.current && blend === "normal") {
            if (isBackdropPlate) { dbg.dropMix++; return; }
          }
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
          // 타일 루프 파츠는 시트가 아니라 **개별 셀 텍스처**를 반복 샘플링한다.
          // 그러면 rx/ry=0·rw/rh=1 이 되어 UV 이동 단위가 자동으로 셀이 되고,
          // repeat 가 이음매 없이 감아 준다(위 isTileWrap 의 근거 참조).
          // 쌍 스트립이 있으면 그것이 최우선 (주기 = 쌍 전체)
          const strip = wantMesh ? stripOf(d?.effectId, dr.cell) : null;
          const tileWrap = wantMesh && !!dr.cell.sheet
            && (isTileWrap(dr.part, dr.cell) || isUvWrap(d?.effectId, dr.part.n));
          const stripTex = strip ? stripTexture(strip[0]) : null;
          const tileTex = stripTex
            ?? (tileWrap ? cellTexturePlain(dr.cell, blend === "add") : null);
          if (tileTex) {
            const st = tileTex.source.style;
            if (st.addressMode !== "repeat") { st.addressMode = "repeat"; st.update(); }
          }
          const sheetTex = wantMesh && dr.cell.sheet && !tileWrap && !stripTex
            ? sheetTexture(dr.cell.sheet, blend === "add") : null;
          /**
           * 셀이 **시트 전체**인 UV 파츠는 반복 샘플링한다.
           *
           * [문제] UV 이동이 [0,1] 을 벗어나면 clamp 는 가장자리 한 줄을
           *   늘린다. 셀이 시트 일부면 이웃 셀 내용이 보이는 게 맞지만,
           *   **셀이 곧 시트 전체**이면 이웃이 아예 없어서 늘어난 줄무늬만
           *   남는다. 그런 파츠의 uv 이동은 "한 바퀴 흘려보내기" 로만 뜻이
           *   통한다 — 예: 851005 `Cell_logo_kemuri_tx` 는 512x64 시트를
           *   통째로 쓰면서 uvy 를 0 -> 1.0 으로 민다.
           * [범위] 셀 = 시트 전체이고 uv 이동이 0 을 벗어나는 파츠
           *   **1,924개 / 131개 이펙트**.
           * [주의] 소스는 시트 단위로 공유된다. 다만 이 조건에서는 그 시트를
           *   쓰는 UV 파츠가 모두 전체를 샘플하므로 부작용이 없다.
           * [디버그] `window.__anssWrap = false` 로 끈다. (docs §40)
           */
          if (sheetTex) {
            const c0 = dr.cell;
            if (c0.rx === 0 && c0.ry === 0 && c0.rw === c0.sw && c0.rh === c0.sh) {
              const style = sheetTex.source.style;
              const want = wrapFullSheet ? "repeat" : "clamp-to-edge";
              if (style.addressMode !== want) {
                style.addressMode = want;
                // _resourceId 가 캐시되므로 update() 를 불러야 샘플러가 바뀐다
                style.update();
              }
            }
          }
          let sp = sprites.get(dr.index);
          if (sp && (sp instanceof Mesh) !== wantMesh) {
            // 메시는 프레임 전용 geometry/셰이더까지 함께 부순다 (GPU 누수 방지)
            if ((sp as Mesh).geometry) {
              // 셰이더는 텍스처 소스별 공유 자원이라 메시와 함께 부수지 않는다
              (sp as Mesh & { _anssVcol?: unknown })._anssVcol = undefined;
              (sp as Mesh).geometry.destroy();
            }
            sp.destroy(); sprites.delete(dr.index); sp = undefined;
          }
          if (!sp) {
            if (wantMesh) {
              const geometry = new MeshGeometry({
                positions: new Float32Array(8),
                uvs: new Float32Array(8),
                indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
              });
              // 정점 알파용 속성. 그라데이션이 없는 메시는 계속 1 로 남는다.
              geometry.addAttribute("aColor", {
                buffer: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
                format: "float32x4",
              });
              sp = new Mesh({ geometry, texture: sheetTex ?? tileTex ?? tex });
            } else {
              sp = new Sprite();
              sp.anchor.set(0.5);
            }
            sprites.set(dr.index, sp);
            stage.addChild(sp);
          }
          const use = sp instanceof Mesh ? (sheetTex ?? tileTex ?? tex) : tex;
          if (sp.texture !== use) sp.texture = use;
          if (sp instanceof Mesh) {
            /**
             * 모서리 알파를 정점 속성으로 넣는다.
             *
             * 모서리 순서는 스프라이트 경로(cellTexture)의 2x2 램프와 같은 규약을
             * 쓴다 — c[2],c[3] 이 이미지 위쪽 행, c[0],c[1] 이 아래쪽 행이다.
             * 메시 정점은 map(u0,v0)=위왼 · (u1,v0)=위오 · (u1,v1)=아래오 ·
             * (u0,v1)=아래왼 순이므로 c[2] c[3] c[1] c[0] 으로 대응한다.
             */
            const ca = cornerAlphas(dr.vcol);
            const cc = cornerColors(dr.vcol);
            const colBuf = sp.geometry.getBuffer("aColor");
            if (colBuf) {
              const cd = colBuf.data as Float32Array;
              /**
               * 코너 순서 — 원본 c[0],c[1] 이 **위쪽** 두 코너다.
               *
               * [문제] 사용자 보고 "무지개가 딱딱 구분된다. 자연스럽게 번져야
               *   한다". 종전에는 c[2],c[3] 을 위로 놓아 **그라데이션이 상하
               *   반전**됐고, 위아래로 맞물린 판마다 이음매에서 색이 튀었다.
               * [결정적 근거] 세로로 정확히 맞물린 4코너 이웃쌍 1,230건 전수
               *   검사 — 위판의 아래 코너와 아래판의 위 코너가 일치하는 조합은
               *   `c0,c1=위` 가설이 **41건**, 현행 `c2,c3=위` 가설이 **2건**.
               *   711005 의 형제 이펙트 712005 의 boke_4->boke_3->boke_2->boke_1
               *   연쇄가 그 41건에 포함된다.
               * [보강] 711005 의 다섯 판은 높이 28.4px · 간격 28.5px 로 정확히
               *   맞물리고, 코너색 연쇄(초록-시안-보라-마젠타-주황)도 연속이다.
               *   반전만 바로잡으면 이음매 없는 무지개가 된다.
               * [신뢰도] CONFIRMED (전수 통계 41:2)
               *
               * 메시 정점은 (위왼, 위오, 아래오, 아래왼) 순이므로
               * c0 c1 c3 c2 로 대응한다.
               */
              // Native BBMsf vertices are TL,BL,BR,TR and updateCell writes
              // CHK c0..c3 to destinations {0,3,1,2}. Thus CHK is
              // TL,TR,BL,BR; our TL,TR,BR,BL mesh needs c0,c1,c3,c2.
              const order = ca ? [ca[0], ca[1], ca[3], ca[2]] : [1, 1, 1, 1];
              const rgbOrder = cc ? [cc[0], cc[1], cc[3], cc[2]] : null;
              let changed = false;
              for (let k = 0; k < 4; k += 1) {
                const a = order[Math.min(k, order.length - 1)] ?? 1;
                const o = k * 4;
                if (cd[o + 3] !== a) changed = true;
                /**
                 * RGB 도 알파로 곱한다 — vColor 는 **프리멀티플라이드**다.
                 *
                 * [문제] rgb=1 로 두면 알파 채널만 줄어든다. 가산 블렌드는
                 *   (ONE, ONE) 로 원본 rgb 를 그대로 더하므로 알파를 아무리
                 *   낮춰도 화면이 어두워지지 않는다. 그래서 그라데이션이 걸린
                 *   파츠가 **모서리까지 꽉 찬 사각형**으로 보였다.
                 * [근거] 1285005 의 eff_t·eff_u 만 남기고 f30 을 렌더해 A/B:
                 *   켜진 픽셀 수는 225,158 로 동일한데 평균 밝기가 107 -> 52.7.
                 *   화면에서도 딱딱한 블록이 끝으로 갈수록 사라지는 띠가 된다.
                 * [신뢰도] CONFIRMED (동일 프레임 실측 + 육안)
                 */
                const col = rgbOrder?.[Math.min(k, rgbOrder.length - 1)];
                if (col) {
                  // 프리멀티플라이드: rgb x a
                  const r = col[0] * a, g = col[1] * a, b = col[2] * a;
                  if (cd[o] !== r || cd[o + 1] !== g || cd[o + 2] !== b) changed = true;
                  cd[o] = r; cd[o + 1] = g; cd[o + 2] = b; cd[o + 3] = a;
                } else {
                  cd[o] = a; cd[o + 1] = a; cd[o + 2] = a; cd[o + 3] = a;
                }
              }
              if (changed) colBuf.update();
              if (ca || cc) {
                // 기본 메시 셰이더는 aColor 를 안 읽는다. 필요한 메시에만 붙인다.
                const m = sp as Mesh & { _anssVcol?: VcolShader };
                const sh = vcolShaderFor(sp.texture);
                if (m.shader !== sh) m.shader = sh;
                m._anssVcol = sh;
              }
            }
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
            // 창(스케일)은 셀 중심 기준, 이동은 아래 map 에서 단위를 골라 더한다
            const u0 = 0.5 - 0.5 * uv.sx, u1 = 0.5 + 0.5 * uv.sx;
            const v0 = 0.5 - 0.5 * uv.sy, v1 = 0.5 + 0.5 * uv.sy;
            const c = dr.cell;
            const useSheet = !!(sheetTex && c.sheet && c.sw && c.sh && c.rw && c.rh);
            // 스트립: 위 절반 = [0,0.5), 아래 절반 = [0.5,1). 이동 단위는 1(스트립 전체)
            // Native uses exact atlas-cell boundaries. Its +/-0.5 constants
            // form the centred UV quad; they are not a half-texel inset.
            const rx = stripTex ? 0 : (useSheet ? (c.rx ?? 0) / c.sw! : 0);
            const ry = stripTex ? strip![1] * 0.5 : (useSheet ? (c.ry ?? 0) / c.sh! : 0);
            const rw = stripTex ? 1 : (useSheet ? c.rw! / c.sw! : 1);
            const rh = stripTex ? 0.5 : (useSheet ? c.rh! / c.sh! : 1);
            /**
             * UV 이동(uvx·uvy)의 단위는 **텍스처 페이지 전체**다. (docs §41)
             *
             * [결정적 근거 — 1082105 사인 광택] `sign_ef_L/R` 쿼드는 부모 x 로
             *   -131 -> 381, 정확히 **512 = 시트 폭**을 이동한다. uvx 를 시트
             *   단위로 읽으면 f80 에서 쿼드가 로고의 318~510 구간 위에 있을 때
             *   샘플 창이 320~512 — **2px 오차로 일치**한다(광택이 지나가는
             *   자리의 로고 그림을 그대로 비춘다). 셀 단위(96px)로 읽으면 창이
             *   87px 만 움직여 광택이 로고를 따라가지 못한다 — 사용자가 본
             *   "광택 위치 안 맞음"이다.
             * [보강] 1285005 로고 광택도 정지값(uvy=1.0)이 페이지 단위에서
             *   시트 밖/빈 행에 떨어져 광택이 **사라진다**. 셀 단위에서는 이웃
             *   셀 줄무늬를 가리켜 91/121 프레임 동안 정지된 광택이 떠 있었다.
             *   §34 의 fan01 사례(정지값 = 리본의 빈 꼬리)도 같은 방향이다.
             * [해석] GL 표준 그대로 — UV 는 텍스처 정규화 좌표이고 이동도 그
             *   좌표에서 이뤄진다. §34 의 uh(컨테이너 추정)는 이것의 부분
             *   근사였으므로 페이지 단위가 켜져 있으면 쓰지 않는다.
             * [디버그] `window.__anssUvPage = false` 로 셀 단위로 되돌린다.
             */
            const uvUnitY = useSheet && c.uh && scrollWindow && !uvPageUnits ? c.uh / c.sh! : rh;
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
              // 이동: 페이지 단위(기본) 또는 셀/컨테이너 단위(폴백)
              ud[i] = rx + cu * rw + uv.x * (stripTex ? 1 : (uvPageUnits && useSheet ? 1 : rw));
              ud[i + 1] = ry + cv * rh + uv.y * (stripTex ? 1 : (uvPageUnits && useSheet ? 1 : uvUnitY));
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
          // 화면 전체를 채우는 일반 블렌드 판은 배경이다. 평탄화된 파츠 배열에서
          // 뒤늦게 등장해도 지도·광원·파티클을 덮지 않도록 최하단에 둔다.
          sp.zIndex = isBackdropPlate
            ? -100000 + order
            : dr.part.role === "front" ? 100000 + order : order;
          // evaluate() already folded the pivot into dr.x / dr.y.
          // flip the frame, not the texture: negate the y row and y translation
          // Matrix 를 프레임마다 새로 만들지 않고 하나를 덮어쓴다
          /**
           * 이펙트만 줄이는 보정 계수. 카드 아트는 건드리지 않는다.
           *
           * [근거] 인게임 스크린샷(1285005, MAJOR 카드) 실측:
           *   불고리 외곽 지름 약 725px · 카드 아트 폭 약 558px
           *   (선수 키 720px / 카드아트 660논리 x 512) -> **고리/카드 = 1.30**.
           *   우리 렌더는 스테이지 논리단위에서 고리 806 · 카드 445 -> **1.81**.
           *   1.30 / 1.81 = 0.72 만큼 이펙트가 크다.
           * [주의] 스크린샷 픽셀을 눈으로 잰 값이라 +-15% 오차가 있다.
           *   `window.__anssFxScale = 1` 로 보정을 끄고 비교할 수 있다.
           */
          const K = fxScaleAdjust;
          scratch.a = dr.a * K; scratch.b = -dr.b * K;
          scratch.c = -dr.c * K; scratch.d = dr.d * K;
          scratch.tx = dr.x * K; scratch.ty = -dr.y * K;
          sp.setFromMatrix(scratch);
          const bucket = dbg.byPart.get(dr.part.n);
          if (bucket) bucket.push(sp); else dbg.byPart.set(dr.part.n, [sp]);
        });
        for (const [i, sp] of sprites) if (!live.has(i)) sp.visible = false;
        // 자동 렌더를 껐으므로 여기서 한 번만 그린다.
        if (forced === null) app!.render();
      };

      /**
       * 화면 밖이면 아무 것도 하지 않는다.
       *
       * [문제] 카드가 스크롤로 밀려 나가도 파츠 수백 개를 계속 재구성하고 GPU 에
       *   올렸다. 목록의 행 아이콘은 이미 가시성 게이트가 있는데 이 무대에는 없었다.
       * [왜 IntersectionObserver 가 아닌가] 처음엔 IO 로 했는데 **화면이 통째로
       *   비는 회귀**가 났다(/player/407903500 에서 frames=0). 이 프로젝트의
       *   미리보기 창은 보이는데도 document.hidden=true 를 보고하고, 그런 문서에서
       *   IO 는 isIntersecting=false 를 준다. document.hidden 게이트도 같은 이유로
       *   뺐다. 그래서 **실제 좌표**로만 판정한다.
       * [안전] 크기나 뷰포트를 모르면 "보인다"로 친다 — 모르면 그린다.
       * [비용] 10프레임에 한 번만 getBoundingClientRect 한다.
       */
      let onScreen = true, checkIn = 0;
      const isVisible = () => {
        const el = host.current;
        if (!el) return true;
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return true;
        const vw = window.innerWidth, vh = window.innerHeight;
        if (!vw || !vh) return true;
        const M = 160;
        return r.bottom > -M && r.top < vh + M && r.right > -M && r.left < vw + M;
      };
      const tick = () => {
        raf = requestAnimationFrame(tick);
        if (--checkIn <= 0) { checkIn = 10; onScreen = isVisible(); }
        if (!onScreen) { prev = performance.now(); return; }
        body();
      };
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
    // docs §38 — 프레임 정합 보정을 리사이즈 경로에도 동일 적용
    stage.scale.set((scale ?? height / CARD_ART_REF_H) * fitScaleAdjust);
  }, [width, height, originY, scale, offsetX, offsetY]);

  // 카드 이미지는 미리 로드해야 첫 프레임부터 그려진다
/**
 * 카드 아트의 **실제 그림 높이**를 알파로 잰다.
 *
 * [문제] 사용자 요청 "선수 사진에 맞게 이펙트 크기가 유동적으로 바뀌어야 함".
 * [확인된 사실] CL 아틀라스는 512x1024 이고 코드는 위 **660행**을 카드 그림으로
 *   가정해 왔다. 그런데 12장 실측에서 그림은 y≈606~619 에서 끝나고
 *   (615~776 이 완전 투명), 그 아래는 이름띠다. 즉 660 크롭에는 **46px 의 빈
 *   여백**이 붙어, 카드 스프라이트의 중심이 실제 선수 그림의 중심보다
 *   23단위(3.7%) 위로 밀린다 — 이펙트가 선수를 기준으로 어긋나 보이는 원인.
 * [처리] 카드를 실을 때 알파 행 합계로 그림/이름띠 경계를 찾아 그 높이로
 *   자른다. 카드마다 다르면 다른 대로 따라간다. 못 찾으면 종전 상수로.
 * [디버그] `window.__anssArtCrop = false` 로 끄고 A/B 할 수 있다.
 * [신뢰도] 경계 위치 CONFIRMED(12장 실측, 606~619) / 시각적 최종 판단은 사용자.
 */
function measureArtHeight(src: TextureSource, key: string): number {
  const hit = artHeightCache.get(key);
  if (hit !== undefined) return hit;
  const H = src.height || CARD_ART_H;
  let out = Math.min(CARD_ART_H, H);
  try {
    const img = (src as unknown as { resource?: CanvasImageSource }).resource;
    if (img) {
      const cv = document.createElement("canvas");
      cv.width = 64;                       // 가로는 줄여도 행 판정에 지장 없다
      cv.height = H;
      const g = cv.getContext("2d", { willReadFrequently: true });
      if (g) {
        g.drawImage(img, 0, 0, src.width || CARD_ART_W, H, 0, 0, 64, H);
        const d = g.getImageData(0, 0, 64, H).data;
        let run = 0, end = -1;
        for (let y = 200; y < H; y += 1) {   // 위쪽 200행은 늘 그림이다
          let any = 0;
          for (let x = 0; x < 64; x += 1) if (d[(y * 64 + x) * 4 + 3] > 16) { any = 1; break; }
          if (any) { run = 0; continue; }
          run += 1;
          if (run >= 6) { end = y - run + 1; break; }   // 완전 투명 6행 = 경계
        }
        if (end > 200) out = end;
      }
    }
  } catch { /* 픽셀을 못 읽으면 상수로 */ }
  artHeightCache.set(key, out);
  return out;
}

  useEffect(() => {
    if (!cardArt) { cardTexRef.current = null; cardArtReadyRef.current = null; return; }
    let alive = true;
    // 확장자가 없는 API URL 이라 파서를 지정해야 이미지로 읽는다
    Assets.load({ src: cardArt, parser: "loadTextures" })
      .then((tex: Texture) => {
        if (!alive || !tex?.source) return;
        // 아틀라스에서 카드 그림이 끝나는 행을 **실측**해 자른다 (위 주석 참조)
        const h = artCropOn
          ? measureArtHeight(tex.source, cardArt)
          : Math.min(CARD_ART_H, tex.source.height || CARD_ART_H);
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
      for (const sp of spritesRef.current.values()) {
        if ((sp as Mesh).geometry) {
          (sp as Mesh & { _anssVcol?: unknown })._anssVcol = undefined;
          (sp as Mesh).geometry.destroy();
        }
        sp.destroy();
      }
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
    // 쌍 스트립도 함께 미리 싣는다 (로드 전에는 stripTexture 가 null 을 돌려준다)
    const urls = [...cellUrls(doc), ...stripUrls(doc)];
    // 이전 문서의 텍스처를 먼저 내려 GPU 를 비운다 (r72 — "서너 개 보면 사라짐" 수정)
    releaseUnused(doc)
      .then(async () => {
        if (!urls.length) return;
        /**
         * [문제] 사용자 보고 "1237950700 배경이 안 뜸". 계측 결과 ready 가
         *   0.6초 만에 세팅되는데 텍스처는 40초가 지나도 캐시에 없었다 —
         *   페이지 초기화 직후의 Assets.load 배치가 **즉시 거부**되고
         *   `.catch(() => undefined)` 가 삼켜서, prepare 와 ready 가 텍스처
         *   없이 진행됐다. 같은 배치를 몇 초 뒤 수동 실행하면 54/54 성공 —
         *   시작 타이밍 레이스다.
         * [처리] 짧은 간격으로 재시도하고, 끝내 실패하면 이유를 콘솔에 남긴다.
         *   부분 실패에도 성공분은 캐시에 남으므로 재시도가 나머지를 채운다.
         */
        /**
         * 파일별 **독립 로드** — 배치는 한 장의 404 가 전체를 죽인다.
         *
         * [문제] 사용자 보고 "1237950700 배경이 안 뜸". 콘솔 계측으로 확정:
         *   최근 내보낸 사인판 스프라이트(8765c7e6f68e3e26.webp)가 CDN 고정
         *   커밋에 없어 404 → `Assets.load(54장 배치)` 전체가 거부되고 정상
         *   53장까지 캐시에 안 실렸다. 게다가 PIXI 의 워커 로더는
         *   Assets.add 의 src 배열 폴백을 태우지 않고 첫 소스 404 로 끝냈다.
         * [처리] ① 장별로 로드해 실패를 그 장에 가둔다.
         *   ② 404 난 장은 alias 를 로컬 사본(`/effects/...`)으로 다시 묶어
         *   재시도한다 — 이 저장소에는 전 파일이 있으므로 dev 는 항상 성공,
         *   prod 는 CDN 누락분만 로컬(사이트 번들 외 경로)로 넘어간다.
         */
        const list = registerTextureFallback(urls);
        await Promise.all(list.map(async u => {
          try { await Assets.load(u); return; }
          catch { /* 아래 로컬 재시도 */ }
          const i = u.indexOf("/public/effects/");
          const path = i >= 0 ? u.slice(i + "/public/effects/".length)
                              : u.slice(EFFECT_TEXTURE_ROOT.length + 1);
          /**
           * 같은 alias 로 Assets.add 를 다시 불러도 리졸버는 **첫 등록을
           * 유지**해서(재별칭 무효) 재시도가 또 CDN 404 를 때렸다.
           * 로컬 사본을 자기 경로로 로드한 뒤 **CDN URL 키로 캐시에 직접
           * 심는다** — Texture.from(cdnUrl)/이후 Assets.load 가 그대로 찾는다.
           */
          try {
            const tex = await Assets.load(`/effects/${path}`);
            if (tex && !Assets.cache.has(u)) Assets.cache.set(u, tex);
          } catch (e) { console.warn("[anss] texture load failed (cdn+local)", u, e); }
        }));
      })
      .then(() => (alive ? prepare(doc) : undefined))
      .then(() => { if (alive) readyRef.current = doc.effectId; });
    return () => { alive = false; };
  }, [doc]);

  return <div ref={host} className="anss-stage" style={{ width, height }} />;
}
