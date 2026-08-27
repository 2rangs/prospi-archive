"use client";

import { Application, Assets, Container, Matrix, Mesh, MeshGeometry, Sprite, Texture } from "pixi.js";
import { useEffect, useState } from "react";
import { evaluate } from "./evaluate";
import { cellTexture, cellUrls, cornerAlphas, cornerColors, isTileWrap,
         cellTexturePlain, stripFor, makeVcolShader, pixiBlend,
         prepare, sheetTexture } from "./AnssStage";
import { AnssSize, loadAnssIcon } from "./useAnss";
import { AnssDocument, CARD_ART_H } from "./types";

/**
 * 목록 아이콘 뒤에서 **실제로 재생되는** 이펙트 배경.
 *
 * [문제] 행마다 AnssStage 를 두면 WebGL 컨텍스트가 25개 필요해 브라우저 상한을
 *   넘는다. 정지 프레임 썸네일은 가볍지만 "배경은 다 재생되는 것" 이라는 원본과
 *   다르다.
 * [처리] **캔버스 하나에 타일 아틀라스**를 만든다. 화면에 보이는 이펙트마다
 *   타일 한 칸을 배정하고, 공유 렌더러가 매 프레임 전 타일을 한 번에 그린다.
 *   각 행은 그 캔버스를 CSS 배경으로 깔고 `background-position` 으로 자기
 *   타일만 본다. 컨텍스트는 1개, 드로우콜은 한 번, 재생은 그대로다.
 */
/**
 * 타일 = 소스 이미지 원본 크기(CS 카드 = 128x128). 그 이상으로 키우면
 * 아이콘이 원본보다 커져 흐려진다 — 최대치를 원본에 맞춘다.
 */
const TW = 128, TH = 128;
/**
 * 슬롯 수는 **목록 한 페이지(25행)보다 커야 한다.**
 * [문제] 24슬롯이라 25번째 행의 배경이 영영 mount 되지 못했고, 해제가 늦으면
 *   그 아래 행들도 배경 없이 떴다 — "일정 개수 이상 보면 사라진다"의 한 축.
 */
const COLS = 6, ROWS = 5;      // 최대 30슬롯 (페이지 25행 + 여유)
const MAX = COLS * ROWS;
/**
 * front(role) 파츠는 **선수 사진 위**에 얹어야 한다.
 *
 * [근거] 사용자 실측 — 인게임 아이콘에서 사인/로고가 사진 제일 위에 보인다.
 *   아이콘 문서 663개 중 103개가 front 셀파츠(총 460개, logo·icon·사인류)를
 *   갖고 있는데 종전에는 전부 사진 뒤 캔버스에 깔려 가려졌다.
 * [처리] 아틀라스 세로를 두 배로 늘려 아래 절반에 front 파츠만 그린다.
 *   행 DOM 은 사진 위에 두 번째 캔버스(.rp-fx-front)를 얹어 그 절반을 blit.
 */
const FRONT_OFF_ROWS = ROWS;   // front 층은 아래 절반 (row + 4)
/**
 * 원본 재생 속도. CHK 클립 레코드 +0x40 이 30 이다(682개 8,795클립 전수 동일).
 * 여기만 24 로 두어 목록 아이콘이 상세 화면보다 20% 느리게 돌고 있었다.
 */
const FPS = 30;
/**
 * _S 저작본이 그려지는 좌표 폭. stageW/stageH 는 _L 과 같은 720x1136 이 적혀
 * 있지만 실제로 찍히는 범위는 그 값과 무관하다: 카드 아트 배율(128/660)로
 * 그리면 타일의 0.1~3.5% 만 덮고 실측 사방 24px 에 그친다. 24 / (128/660) ~=
 * 124 이므로 _S 는 **아이콘 픽셀 그대로**, 즉 CS 카드 원본 128px 기준으로
 * 저작돼 있다. 그래서 배율은 타일 크기 / 아이콘 원본 크기다.
 */
const ICON_SRC = 128;
/** 화면 픽셀 밀도. 백킹 버퍼와 blit 좌표에 함께 곱한다. */
const DPR = typeof window === "undefined" ? 1
  : Math.min(2, Math.max(1, window.devicePixelRatio || 1));

type Slot = { id: number; doc: AnssDocument | null; size: AnssSize; ready: boolean; idx: number };

const slots = new Map<number, Slot>();   // effectId -> slot
const free: number[] = Array.from({ length: MAX }, (_, i) => i);
let app: Application | null = null;
let appP: Promise<Application> | null = null;
let root: Container | null = null;
let raf = 0;
let clock = 0;
let prev = 0;
let renderedFrame = -1;

async function ensureApp() {
  if (appP) return appP;
  const a = new Application();
  appP = a.init({
    width: TW * COLS, height: TH * (ROWS + FRONT_OFF_ROWS),
    /**
     * 아틀라스도 화면 픽셀 밀도로 그린다(§18 과 같은 이유).
     * 행 아이콘은 76 CSS px 로 표시되므로 dpr 2 화면에서는 152 물리 화소인데,
     * 타일 백킹이 128 이면 1.19 배 늘어나 흐려진다. 백킹을 dpr 배로 잡으면
     * 152 를 256 에서 줄이는 셈이라 선명해진다. 768x512 x2 = 1.6M 화소로 가볍다.
     */
    backgroundAlpha: 0, antialias: true, resolution: DPR, autoDensity: false,
  }).then(() => {
    app = a; root = new Container(); a.stage.addChild(root);
    prev = performance.now();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      clock += Math.min(0.1, (now - prev) / 1000); prev = now;
      if (slots.size === 0) return;
      // The source animation is 30fps. On a 60/120Hz display rebuilding every
      // mesh on every rAF created the same authored frame 2-4 times.
      const frame = Math.floor(clock * FPS);
      if (frame !== renderedFrame) {
        renderedFrame = frame;
        draw(frame);
        blit();
      }
    };
    raf = requestAnimationFrame(tick);
    // 디버그: 패널이 숨겨져 rAF 가 멈춰도 한 프레임 강제로 그린다
    (window as unknown as { __thumbs?: unknown }).__thumbs = {
      step: (f: number) => { draw(f); blit(); },
      slots, sinks, app: a,
    };
    return a;
  });
  return appP;
}

const m = new Matrix();

function draw(frame: number) {
  if (!app || !root) return;
  /**
   * 깊은 파괴 — PIXI v8 의 destroy() 는 기본으로 **자식을 파괴하지 않는다.**
   * 종전 코드는 셀 컨테이너만 죽여서, 그 안의 스프라이트·메시(+GPU
   * 지오메트리·셰이더)가 프레임마다 수백 개씩 떠돌았다(30fps ≈ 초당 9천 객체).
   * 메시의 geometry/shader 는 이 프레임 전용으로 만든 것이라 함께 부순다.
   * (텍스처는 공유 캐시라 건드리지 않는다 — destroy 의 texture 기본값 false)
   */
  for (const cell of root.removeChildren()) {
    for (const ch of (cell as Container).children) {
      const mesh = ch as Mesh;
      if (mesh.geometry) {
        if (mesh.shader && (mesh.shader as { destroy?: () => void }).destroy) mesh.shader.destroy();
        mesh.geometry.destroy();
      }
    }
    cell.destroy({ children: true });
  }
  for (const s of slots.values()) {
    if (!s.ready || !s.doc) continue;
    if (!anyVisible(s.id)) continue;   // 화면 밖 행은 그리지 않는다
    const cell = new Container();
    cell.sortableChildren = true;
    const col = s.idx % COLS, row = (s.idx / COLS) | 0;
    // _S 는 아이콘 픽셀 기준, _L 되돌림은 카드 아트 픽셀 기준이다.
    const scale = s.size === "S" ? TH / ICON_SRC : TH / CARD_ART_H;
    cell.position.set(col * TW + TW / 2, row * TH + TH / 2);
    cell.scale.set(scale);
    // front 파츠 전용 층 — 같은 칸의 아래 절반 아틀라스에 그린다
    const cellFront = new Container();
    cellFront.sortableChildren = true;
    cellFront.position.set(col * TW + TW / 2, (row + FRONT_OFF_ROWS) * TH + TH / 2);
    cellFront.scale.set(scale);
    for (const dr of evaluate(s.doc, frame)) {
      /**
       * 저작본이 쓴 블렌드를 그대로 쓴다.
       * 큰 이펙트(_L)를 아이콘에 줄여 쓸 때는 불투명한 받침판이 사진을 덮어
       * 가산 파츠만 골랐는데, _S 는 아이콘 배경 그 자체라 663개 중 307개가
       * 가산 파츠를 아예 갖고 있지 않다. 골라 그리면 절반이 빈 칸이 된다.
       */
      const bl = pixiBlend(dr.blend ?? dr.part.bl);
      const tex = cellTexture(dr.cell, dr.vcol, bl === "add");
      if (!tex) continue;
      /**
       * UV 애니메이션 파츠는 아이콘에서도 **메시**로 그린다.
       *
       * [문제] 여기는 전부 Sprite 로만 그리고 있었다. Sprite 는 셀을 통째로
       *   붙이므로 uvx/uvy/uvsx/uvsy/uvrot 이 **통째로 무시된다.** 그러면
       *   흘러야 할 파츠가 정지한 그림이 되어 부모 변환에 실려 움직이기만 한다.
       * [측정] 아이콘 문서의 셀파츠 7,274개 중 **494개(6.8%)** 가 UV 트랙을
       *   갖고, **663개 아이콘 중 161개**가 영향을 받는다.
       * [처리] AnssStage 의 메시 경로와 같은 규약을 쓴다 — 시트를 텍스처로
       *   삼고 UV 창을 직접 넣으며, 스크롤 창은 원본 높이(uh)를 이동 단위로
       *   쓴다(docs §34). UV 가 없는 파츠는 종전대로 Sprite 라 결과가 같다.
       */
      const c = dr.cell;
      /**
       * [수정] 행 아이콘은 AnssStage 와 **별도 경로**라 r74~r85 의 UV/정점색
       *   수정이 하나도 반영되지 않았다(사용자 보고 "진짜 하나도 안 바뀜").
       *   AnssStage 와 같은 세 가지를 여기에도 적용한다:
       *     ① `_t`/`_u` 쌍 스트립 텍스처 (주기 = 쌍 전체)
       *     ② 부분셀 + UV 이동 1.0 이상이면 개별 셀 텍스처 반복
       *     ③ 정점색 **RGB** 반영 (종전에는 알파만 넣어 전부 흰색이었다)
       */
      const strip = dr.hasUv ? (stripFor(s.doc.effectId, c) as Texture | null) : null;
      const tileWrap = dr.hasUv && !!c.sheet && !strip && isTileWrap(dr.part, c);
      const altTex = strip ?? (tileWrap ? cellTexturePlain(c, bl === "add") : null);
      const sheetTex = dr.hasUv && c.sheet && !altTex
        ? sheetTexture(c.sheet, bl === "add") : null;
      const useSheet = !!(sheetTex && c.sw && c.sh && c.rw && c.rh) || !!altTex;
      let sp: Sprite | Mesh;
      if (useSheet && dr.uv) {
        const uv = dr.uv;
        const hw = c.w / 2, hh = c.h / 2;
        const half = strip ? (stripFor(s.doc.effectId, c, true) as number) : 0;
        const rx = altTex ? 0 : (c.rx ?? 0) / c.sw!;
        const ry = strip ? half * 0.5 : (altTex ? 0 : (c.ry ?? 0) / c.sh!);
        const rw = altTex ? 1 : c.rw! / c.sw!;
        const rh = strip ? 0.5 : (altTex ? 1 : c.rh! / c.sh!);
        // UV 이동은 페이지 단위 (docs §41). AnssStage 와 같은 규약.
        const u0 = 0.5 - 0.5 * uv.sx, u1 = 0.5 + 0.5 * uv.sx;
        const v0 = 0.5 - 0.5 * uv.sy, v1 = 0.5 + 0.5 * uv.sy;
        const r = uv.rot * Math.PI / 180;
        const cr = Math.cos(r), sr = Math.sin(r);
        const uvs = new Float32Array(8);
        const put = (u: number, v: number, i: number) => {
          let cu = u, cv = v;
          if (uv.rot) {
            const du = u - 0.5, dv = v - 0.5;
            cu = 0.5 + du * cr - dv * sr;
            cv = 0.5 + du * sr + dv * cr;
          }
          // 스트립/개별셀이면 그 텍스처 단위, 시트면 페이지 단위(§41)
          uvs[i] = rx + cu * rw + uv.x * (altTex ? (strip ? 1 : rw) : 1);
          uvs[i + 1] = ry + cv * rh + uv.y * (altTex ? (strip ? 1 : rh) : 1);
        };
        put(u0, v0, 0); put(u1, v0, 2); put(u1, v1, 4); put(u0, v1, 6);
        const geometry = new MeshGeometry({
          positions: new Float32Array([-hw, -hh, hw, -hh, hw, hh, -hw, hh]),
          uvs,
          indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
        });
        const ca = cornerAlphas(dr.vcol);
        const cc = cornerColors(dr.vcol);
        if (ca || cc) {
          // Native resolves to CHK TL,TR,BL,BR; mesh is TL,TR,BR,BL.
          const order = ca ? [ca[0], ca[1], ca[3], ca[2]] : [1, 1, 1, 1];
          const rgbOrder = cc ? [cc[0], cc[1], cc[3], cc[2]] : null;
          const buf = new Float32Array(16);
          for (let k = 0; k < 4; k += 1) {
            const av = order[Math.min(k, order.length - 1)] ?? 1;
            const col = rgbOrder?.[Math.min(k, rgbOrder.length - 1)];
            if (col) {
              buf[k * 4] = col[0] * av; buf[k * 4 + 1] = col[1] * av;
              buf[k * 4 + 2] = col[2] * av; buf[k * 4 + 3] = av;
            } else {
              buf[k * 4] = av; buf[k * 4 + 1] = av; buf[k * 4 + 2] = av; buf[k * 4 + 3] = av;
            }
          }
          geometry.addAttribute("aColor", { buffer: buf, format: "float32x4" });
        }
        const tex2 = (altTex ?? sheetTex)!;
        const mesh = new Mesh({ geometry, texture: tex2 });
        if (ca || cc) {
          const tx = (altTex ?? sheetTex)!;
          const sh = makeVcolShader();
          sh.resources.uTexture = tx.source;
          sh.resources.uSampler = tx.source.style;
          sh.resources.textureUniforms.uniforms.uTextureMatrix = tx.textureMatrix.mapCoord;
          sh.texture = tx;
          mesh.shader = sh;
        }
        sp = mesh;
      } else {
        const s2 = new Sprite(tex);
        s2.anchor.set(0.5);
        sp = s2;
      }
      sp.blendMode = bl;
      sp.alpha = dr.alpha;
      m.set(dr.a, dr.b, dr.c, dr.d, dr.x, dr.y);
      sp.setFromMatrix(m);
      sp.zIndex = dr.prio;
      (dr.part.role === "front" ? cellFront : cell).addChild(sp);
    }
    root.addChild(cell);
    root.addChild(cellFront);
  }
  app.render();
}

/**
 * 슬롯이 없을 때 mount 를 포기하지 않고 대기시킨다.
 * [문제] 페이지를 넘기면 React 가 새 행을 먼저 그리고 헌 행을 나중에 지운다.
 *   그 사이 free 가 비어 mount 가 조용히 실패했고 **재시도가 없어서** 그 행은
 *   영영 빈 배경이었다.
 */
const pending = new Set<number>();
function drainPending() {
  for (const id of pending) {
    if (free.length === 0) return;
    pending.delete(id);
    if (sinks.has(id) || frontSinks.has(id)) void mount(id);
  }
}

async function mount(effectId: number) {
  if (slots.has(effectId)) return;
  if (free.length === 0) { pending.add(effectId); return; }
  const idx = free.shift()!;
  const slot: Slot = { id: effectId, doc: null, size: "S", ready: false, idx };
  slots.set(effectId, slot);
  await ensureApp();
  if (slots.get(effectId) !== slot) return;
  const got = await loadAnssIcon(effectId);
  if (slots.get(effectId) !== slot) return;
  if (!got) { slots.delete(effectId); free.push(idx); drainPending(); return; }
  const { doc } = got;
  slot.size = got.size;
  const urls = cellUrls(doc);
  if (urls.length) await Assets.load(urls).catch(() => undefined);
  if (slots.get(effectId) !== slot) return;
  await prepare(doc);
  if (slots.get(effectId) !== slot) return;
  slot.doc = doc; slot.ready = true;
}

function releaseSlotIfUnused(effectId: number) {
  if ((sinks.get(effectId)?.size ?? 0) > 0 || (frontSinks.get(effectId)?.size ?? 0) > 0) return;
  const s = slots.get(effectId);
  if (!s) return;
  s.doc = null;
  s.ready = false;
  slots.delete(effectId);
  if (!free.includes(s.idx)) free.push(s.idx);
  drainPending();
}

/**
 * 행 캔버스 등록부. 공유 렌더러가 한 프레임 그린 뒤, 등록된 2D 캔버스마다
 * 자기 타일 구간만 blit 한다. 2D 컨텍스트는 WebGL 컨텍스트 상한과 무관해서
 * 수십 개를 띄워도 안전하다.
 */
/**
 * 화면에 보이는 캔버스만 재생한다 (사용자 요청 — 메모리/GPU 절약).
 * IntersectionObserver 로 가시성을 추적하고, draw()/blit() 이 안 보이는
 * 슬롯·캔버스를 건너뛴다. 문서·텍스처 캐시는 유지되므로 다시 보이면 즉시 잇는다.
 */
const visibleCanvases = new WeakSet<HTMLCanvasElement>();
const io = typeof IntersectionObserver !== "undefined"
  ? new IntersectionObserver(entries => {
      for (const e of entries) {
        const cv = e.target as HTMLCanvasElement;
        if (e.isIntersecting) visibleCanvases.add(cv);
        else visibleCanvases.delete(cv);
      }
    }, { rootMargin: "120px" })
  : null;
function anyVisible(id: number): boolean {
  if (!io) return true;
  for (const set of [sinks.get(id), frontSinks.get(id)]) {
    if (!set) continue;
    for (const cv of set) if (visibleCanvases.has(cv)) return true;
  }
  return false;
}

const sinks = new Map<number, Set<HTMLCanvasElement>>();
/** 사진 위에 얹는 front 층 캔버스 */
const frontSinks = new Map<number, Set<HTMLCanvasElement>>();

function blit() {
  if (!app) return;
  const src = app.canvas as HTMLCanvasElement;
  for (const [layer, sinkMap] of [[0, sinks], [1, frontSinks]] as const) {
   for (const [id, set] of sinkMap) {
    const s = slots.get(id);
    if (!s || !s.ready || set.size === 0) continue;
    // 아틀라스가 dpr 배로 커졌으므로 잘라 낼 좌표도 같이 곱한다.
    const R = app.renderer.resolution;
    const sx = (s.idx % COLS) * TW * R,
      sy = (((s.idx / COLS) | 0) + layer * FRONT_OFF_ROWS) * TH * R;
    const tw = Math.round(TW * R), th = Math.round(TH * R);
    for (const cv of set) {
      if (io && !visibleCanvases.has(cv)) continue;   // 화면 밖 캔버스 스킵
      const g = cv.getContext("2d");
      if (!g) continue;
      if (cv.width !== tw || cv.height !== th) { cv.width = tw; cv.height = th; }
      g.clearRect(0, 0, tw, th);
      g.drawImage(src, sx, sy, tw, th, 0, 0, tw, th);
      // 첫 프레임이 실제로 그려진 순간 스켈레톤을 걷는다 (globals.css 의 [data-ready])
      if (!cv.dataset.ready) cv.dataset.ready = "1";
    }
   }
  }
}

/**
 * 행에서 쓰는 훅. 반환된 ref 를 <canvas> 에 걸면 그 캔버스에 이펙트가
 * 계속 재생된다.
 */
export function useEffectTile(effectId: number | null | undefined) {
  const [el, setEl] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (effectId == null || !el) return;
    let set = sinks.get(effectId);
    if (!set) { set = new Set(); sinks.set(effectId, set); }
    set.add(el);
    io?.observe(el);
    void mount(effectId);
    return () => {
      io?.unobserve(el);
      const cur = sinks.get(effectId);
      cur?.delete(el);
      if (cur && cur.size === 0) {
        sinks.delete(effectId);
        releaseSlotIfUnused(effectId);
      }
    };
  }, [effectId, el]);
  return setEl;
}

/** front 층(사진 위) 캔버스용 훅. 등록만 다르고 나머지는 useEffectTile 과 같다. */
export function useEffectFrontTile(effectId: number | null | undefined) {
  const [el, setEl] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (effectId == null || !el) return;
    let set = frontSinks.get(effectId);
    if (!set) { set = new Set(); frontSinks.set(effectId, set); }
    set.add(el);
    io?.observe(el);
    void mount(effectId);
    return () => {
      io?.unobserve(el);
      const cur = frontSinks.get(effectId);
      cur?.delete(el);
      if (cur && cur.size === 0) {
        frontSinks.delete(effectId);
        releaseSlotIfUnused(effectId);
      }
    };
  }, [effectId, el]);
  return setEl;
}

export function stopThumbs() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}
