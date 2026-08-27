/**
 * ANSS document model.
 *
 * Every field here is grounded in libAll.so, not in guesswork. The references
 * are the symbols and offsets the values were read from.
 *
 *   ChunkLoad::LinkChunkData      "CHK " + [char[8] label, u32 size] * N + "CHUNKEND"
 *   AnimssNormalModel::buildPart  DescPart+0x44 selects the part class
 *   ...::updatePartAttributeSub   33-entry table -> AnimssPart::set<Attr>
 *   AnimssInterpolation           keyframe+0x04 selects one of six curves
 *   AnimssCellPart::setCell       BlendType = DescPart+0x48, range 0..3
 *   Material::AffectStatus        the five GL blend states
 *   AnimssCanvas::stretchBG       scale = screenHeight / GetBaseScreenHeight()
 *   GetBaseScreenWidth/Height     640 x 1136
 */

/** Logical reference screen. GetBaseScreenWidth/Height in libAll.so. */
/**
 * 카드 아트의 픽셀 크기. CL 아틀라스는 512x1024 이고 카드 그림이 y 0~660 을
 * 차지한다.
 *
 * [확인된 사실] 이펙트가 그리는 내용의 실질 크기는 중앙 586 x 519 논리단위이고
 *   중심 x 는 0 이다(60개 이펙트 x 5프레임, 5~95 백분위).
 * [확인된 사실] 카드 아트 512x660 의 종횡비 1.289 는 카드를 표시하는 틀
 *   420x541 의 종횡비 1.288 과 같다. 그래서 논리단위 1 = 카드 아트 픽셀 1 로
 *   보면 배율이 420/512 = 541/660 = 0.820 으로 한 값에 모인다.
 * [반박된 가설] 논리단위를 기준 화면 높이(1136)에 맞추는 것. 그러면 배율이
 *   0.476 이 되어 모든 이펙트가 1.72배 작게 그려진다. 실제로 사용자가 눈으로
 *   맞춘 값이 175%(실효 0.833)였고 이는 0.820 과 1.6% 차이다.
 * [신뢰도] STRONG
 */
export const CARD_ART_W = 512;
export const CARD_ART_H = 660;

/**
 * 카드 이미지가 기준 화면(640x1136)에 그려지는 배율.
 *
 * [근거] 인게임 스크린샷(923px 폭, 有原 航平 2026 Series1)에서
 *   - 선수 높이 약 506px, 불꽃 가로 폭 약 860px(화면의 93%)
 *   카드 아트 안의 선수는 220x456px 이므로, 선수 높이로 역산하면 카드 아트가
 *   화면에서 약 568px = 화면 폭의 61.5% 로 그려진다. 그러면
 *   불꽃 / 카드아트 = 860/568 = 1.51 인데, 논리단위 1 = 카드아트 픽셀 1 로 두면
 *   586/512 = 1.14 밖에 안 된다. 필요한 배수 1.32 는 660/500 ≈ 1/0.75 다.
 *   즉 카드 이미지는 0.75배로 그려지고 이펙트는 1:1 이다.
 * [신뢰도] STRONG (실물 스크린샷 1장 기준 역산)
 */
export const CARD_ART_SCREEN_SCALE = 1.0;   // 되돌림: 1.32배 확대는 실물과 더 어긋났다

/** 표시 틀 높이에서 이펙트 배율을 구할 때 쓰는 기준 높이 */
export const CARD_ART_REF_H = CARD_ART_H * CARD_ART_SCREEN_SCALE;

/**
 * 카드 표시 틀 높이 → 이펙트 배율(출력픽셀 / 논리단위).
 * 모든 화면이 이 하나를 써야 같은 이펙트가 같은 크기로 보인다.
 */
export function fxScaleFor(cardFrameH: number) {
  return cardFrameH / CARD_ART_REF_H;
}

/**
 * 이펙트를 담을 캔버스 크기.
 *
 * [확인된 사실] 저작 스테이지는 이펙트마다 다르다. 애니메이션 레코드 +0x58 의
 *   float 2개를 읽으면 682개가 720x1136(350) · 720x1484(208) · 640x1136(102) ·
 *   720x1386(18) · 740x1136(3) · 640x1484(1) 로 갈린다. 반대로 clip 의
 *   canvas 필드는 682개 전부 320x320 이라 레이아웃 정보가 아니다.
 * [근거] tools/export_anim.py 604행이 이미 stageW/stageH 로 뽑아 두었다.
 * [해석] 640x1136 하나로 고정하면 579개(85%)는 가로가, 209개(31%)는 세로가
 *   잘린다. 지시사항의 "임의 클리핑 금지"에 정면으로 걸리는 부분이었다.
 * [신뢰도] CONFIRMED (682개 전수)
 *
 * [확인된 사실] 스테이지는 하드 클립 경계가 아니다. 자기 스테이지 기준으로도
 *   그려지는 면적의 중앙값 71.8% 만 안에 들어온다(681개 x 5프레임, 알파가중).
 *   1.5배로 넓히면 90.6% 가 들어오고 90% 이상 보이는 이펙트가 6% -> 52% 가 된다.
 * [해석] 스테이지는 설계 기준 프레임이고, 파티클이 밖으로 날아가는 건 정상이다.
 *   그래서 스테이지를 그대로 쓰지 않고 오버스캔을 곱해 잘림을 없앤다.
 * [신뢰도] CONFIRMED (측정값)
 */
/**
 * 캔버스를 스테이지보다 얼마나 넓게 잡을지.
 *
 * [확인된 사실] 실제로 그려지는 내용은 카드보다 훨씬 크다. 1152055 를 프레임을
 *   강제로 그려(window.__anss.step) 스프라이트 경계를 재면 내용이
 *   944~1043 x 2182~2204 px 인데 카드는 420x541 px 다. **카드의 2.25~2.49배**다.
 *   그런데 캔버스는 590x1216 px(카드의 1.40배)뿐이라 가로 40% · 세로 45% 가
 *   화면 밖으로 잘려 나간다.
 * [경쟁 가설] "스테이지 = 화면이므로 1.0 이 맞다." 스테이지 폭에 딱 맞춘 불투명
 *   배경판이 실재하는 것은 사실이지만(1213005 bg_kage_color 726/720 = 1.01),
 *   그건 Mix 판을 쓰는 이펙트 이야기다. 1201005/1152055 처럼 가산 85% 인
 *   불꽃에는 그런 판이 없어서 넓혀도 사각 경계가 드러나지 않는다.
 * [처리] 기본 1.5 배(캔버스/카드 = 2.1)로 두고 화면에서 조절할 수 있게 연다.
 *   Mix 판이 있는 이펙트에서 경계가 보이면 그때 1.0 으로 내리면 된다.
 * [신뢰도] 잘림 CONFIRMED(실측) · 적정 배율은 눈으로 맞출 값
 */
export const FX_OVERSCAN = 1.5;

/**
 * 이펙트가 카드를 채우도록 키우는 배수.
 *
 * [확인된 사실] 아이콘(_S)은 카드 정사각형을 97~99% 채운다. 상세(_L)는 카드
 *   틀(512x660 논리 = 420x541 px) 안을 **81~84%** 밖에 채우지 못하고, 빈 곳은
 *   **아래쪽에 몰려 있다**(카드 높이 85%~100% 구간의 덮음이 16% -> 0%).
 * [근거] 카드 사각형을 k 배로 줄여 가며 덮음을 재면 두 이펙트가 같은 값을 낸다.
 *
 *   | k    | 1201005      | 1182005 |
 *   | ---- | ------------ | ------- |
 *   | 1.00 | 81% (불투명 56%) | 84%   |
 *   | 0.90 | 91% (불투명 66%) |       |
 *   | 0.80 | 98% (불투명 77%) |       |
 *   | 0.75 | 99% (불투명 83%) |       |
 *
 *   즉 이펙트가 꽉 채우는 범위는 카드의 **0.78배**다. 1/0.78 = 1.28.
 * [근거 2] 인게임 스크린샷 역산도 같은 방향이었다(필요 배수 1.32, §CARD_ART_SCREEN_SCALE).
 * [경쟁 가설 — 기각] "화면의 크기 슬라이더로 맞추면 된다." 슬라이더는 스테이지
 *   컨테이너를 통째로 키워 **카드도 같이 커진다**(카드 worldScale 0.820 -> 1.066).
 *   비율이 그대로라 덮음은 변하지 않는다.
 * [처리] 이펙트 배율에 이 값을 곱하고, cardArtScale 에 역수를 넣어 **카드의
 *   화면 크기는 그대로** 둔다. 예전 시도(1.32)가 되돌려진 이유는 카드를 줄여서
 *   선수 사진이 작아졌기 때문이다 — 이번에는 카드가 변하지 않는다.
 * [신뢰도] STRONG (이펙트 2개 x 3프레임 실측, 인게임 역산과 방향 일치)
 */
export const FX_CARD_FILL = 1.15;   // 1.28 에서 10% 축소 (사용자 조정)


export function fxCanvasFor(scale: number, stageW = BASE_W, stageH = BASE_H,
                            over = FX_OVERSCAN) {
  return { w: Math.round(stageW * over * scale), h: Math.round(stageH * over * scale) };
}

/** 기준 화면. 스테이지를 못 읽은 이펙트의 대체값으로만 쓴다. */
export const BASE_W = 640;
export const BASE_H = 1136;

/** AnimssInterpolation curve ids, keyframe+0x04. */
export enum Curve { Hold = 0, Linear = 1, Hermite = 2, Bezier = 3, Accel = 4, Decel = 5 }

/** DescPart+0x44 -> the class AnimssNormalModel::buildPart instantiates. */
export enum PartType { Group = 0, Cell = 1, RefAnime = 3, Effect = 4 }

/**
 * DescPart+0x48, range checked against 4 in the setCell path. The mapping onto
 * Material's blend states is the SpriteStudio order and matches what the data
 * shows (glow parts carry 2 and read as additive), but the enum itself was not
 * read out of the binary, so treat it as strong rather than confirmed.
 */
export enum BlendType { Mix = 0, Multiply = 1, Add = 2, Subtract = 3 }

/** [frame, value, curve] with hermite/bezier handles appended when present. */
export type Key = [number, number, number] | [number, number, number, number[]];
export type Track = Key[];
export type VertexTransformTrack = [number, number[], number, number[]?][];

export type Cell = {
  file: string;
  w: number; h: number;
  /** DescCell pivot, normalised -0.5..0.5 of the cell. */
  px: number; py: number;
  /**
   * Whether the source texture carried alpha at all. 462 of 790 cell textures
   * in the pack are palette-without-tRNS or plain RGB; those are opaque by
   * construction and the runtime leans on BlendType instead (a black-backed
   * glow drawn additive). Nothing here may invent alpha for them.
   */
  alpha?: boolean;
  /**
   * 셀이 잘려 나온 시트와 그 안의 사각형.
   *
   * UV 애니메이션 파츠는 셀 크롭이 아니라 **시트 전체**를 텍스처로 쓰고 이
   * 사각형을 UV 창으로 삼아야 한다. 런타임은 GL_CLAMP_TO_EDGE 만 쓰므로
   * (libAll.so 전체에서 GL_REPEAT 는 0회, CLAMP_TO_EDGE 는 22회) UV 가 셀
   * 밖으로 나가면 반복되는 게 아니라 시트의 이웃 내용이 보이고 시트 경계에서
   * 늘어난다. 18,816개 파츠 / 383개 이펙트가 UV 를 셀 밖으로 밀어낸다.
   */
  sheet?: string;
  /** 시트 픽셀 크기 */
  sw?: number; sh?: number;
  /** 시트 안의 셀 사각형 */
  rx?: number; ry?: number; rw?: number; rh?: number;
  /** 스크롤 창일 때 원본 이미지의 상단/높이 (시트 픽셀). docs §34 */
  uy?: number;
  uh?: number;
};

export type Part = {
  /** part name; RefAnime parts are named "<clip>_<anime>". */
  n: string;
  /** parent index in this array, -1 for a root. */
  p: number;
  /** DescPart+0x44 */
  k: number;
  role: "back" | "front";
  /** DescPart+0x48 */
  bl?: number;
  /** [ADVANCE]#N from USERDATA: phase shift in frames. */
  user?: number;
  /**
   * Animated vertex colour: [frame, blend, colours, curve]. blend 0 carries one
   * colour for the whole quad, blend 1 one per corner. Instances placed with
   * [ADVANCE]#N read different frames of the same track, which is how a ring of
   * arrows runs blue on one side and red on the other.
   */
  vt?: [number, number, number[][], number][];
  /** Attribute 15: four animated per-corner (x,y) offsets, 32-byte Vert value. */
  xt?: VertexTransformTrack;
  /** frames in the animation this part belongs to (anim record +0x4c) */
  len?: number;
  /**
   * 이 파트가 속한 애니메이션이 반복인가.
   * USERDATA `[LOOP]` (애니메이션 root 노드 0프레임)에서 온다. 682개 전수로
   * 애니메이션의 94%가 반복이고 6%는 1회 재생이다.
   */
  loop?: boolean;
  /** playback fps of that animation (anim record +0x48) */
  afps?: number;
  /**
   * Attribute tracks, named after the runtime's own attribute ids
   * (updatePartAttributeSub's 33-entry table, see tools/export_anim.py WANT):
   *   1 x  2 y  4 rx(ROTX)  5 ry(ROTY)  6 rot(ROTZ)  7 sx  8 sy  9 a(alpha)
   *   10 prio  11 fh  12 fv  13 hide  16 pvx  17 pvy  22 ifh  23 ifv
   *   24 uvx  25 uvy  26 uvrot  27 uvsx  28 uvsy
   */
  t: {
    x?: Track; y?: Track; z?: Track; rot?: Track;
    rx?: Track; ry?: Track;
    sx?: Track; sy?: Track;
    a?: Track; prio?: Track; hide?: Track;
    fh?: Track; fv?: Track; ifh?: Track; ifv?: Track;
    pvx?: Track;

    /** SIZE_X / SIZE_Y — 셀의 자연 크기를 덮어쓰는 표시 크기(px) */

    szx?: Track;

    szy?: Track; pvy?: Track;
    uvx?: Track; uvy?: Track; uvrot?: Track; uvsx?: Track; uvsy?: Track;
  };
  /** cell list plus a cell-change track, or a single fixed cell. */
  cells?: Cell[];
  ct?: [number, number, number][];
  c?: Cell;
  /** AnimssValue::Vcol - blend 0 is one colour, 1 is one per corner. */
  v?: { blend: number; c: [number, number, number, number][] };
};

export type AnssDocument = {
  effectId: number;
  /** the animation's authored stage, animation record +0x58. */
  stageW?: number; stageH?: number;
  /** constant 320x320 in every effect; NOT a render size. */
  canvasW: number; canvasH: number;
  frames: number;
  fps: number;
  parts: Part[];
};
